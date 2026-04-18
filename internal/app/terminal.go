package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"

	"github.com/coder/websocket"
	"github.com/creack/pty"
	"github.com/rs/zerolog"
)

type TerminalHub struct {
	workspaceRoot string
	log           zerolog.Logger
}

func NewTerminalHub(workspaceRoot string, logger zerolog.Logger) *TerminalHub {
	return &TerminalHub{workspaceRoot: workspaceRoot, log: logger}
}

type TerminalSession struct {
	root string
	cwd  string
	log  zerolog.Logger

	cmd  *exec.Cmd
	ptmx *os.File
	once sync.Once
}

type terminalMessage struct {
	Type string `json:"type"`
	Data string `json:"data,omitempty"`
	Cols uint16 `json:"cols,omitempty"`
	Rows uint16 `json:"rows,omitempty"`
}

func (h *TerminalHub) NewSession(_ context.Context, requestedCWD string) (*TerminalSession, error) {
	cwd, err := resolveWithin(h.workspaceRoot, requestedCWD)
	if err != nil {
		return nil, err
	}
	shell, args := defaultShell()
	cmd := exec.Command(shell, args...)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: 120, Rows: 32})
	if err != nil {
		return nil, fmt.Errorf("start pty: %w", err)
	}
	return &TerminalSession{
		root: h.workspaceRoot,
		cwd:  cwd,
		log:  h.log.With().Str("cwd", cwd).Logger(),
		cmd:  cmd,
		ptmx: ptmx,
	}, nil
}

func (s *TerminalSession) Run(ctx context.Context, conn *websocket.Conn) error {
	writeErrCh := make(chan error, 1)
	readErrCh := make(chan error, 1)

	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := s.ptmx.Read(buf)
			if n > 0 {
				if writeErr := writeWSJSON(ctx, conn, terminalMessage{Type: "output", Data: string(buf[:n])}); writeErr != nil {
					writeErrCh <- writeErr
					return
				}
			}
			if err != nil {
				if err == io.EOF {
					_ = writeWSJSON(ctx, conn, terminalMessage{Type: "exit"})
					writeErrCh <- nil
					return
				}
				writeErrCh <- err
				return
			}
		}
	}()

	go func() {
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				readErrCh <- err
				return
			}
			var msg terminalMessage
			if err := json.Unmarshal(data, &msg); err != nil {
				readErrCh <- err
				return
			}
			switch msg.Type {
			case "input":
				if _, err := s.ptmx.Write([]byte(msg.Data)); err != nil {
					readErrCh <- err
					return
				}
			case "resize":
				if err := pty.Setsize(s.ptmx, &pty.Winsize{Cols: msg.Cols, Rows: msg.Rows}); err != nil {
					readErrCh <- err
					return
				}
			}
		}
	}()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-readErrCh:
		return err
	case err := <-writeErrCh:
		return err
	}
}

func (s *TerminalSession) Close() {
	s.once.Do(func() {
		if s.cmd != nil && s.cmd.Process != nil {
			_ = s.cmd.Process.Signal(syscall.SIGTERM)
		}
		if s.ptmx != nil {
			_ = s.ptmx.Close()
		}
	})
}

func defaultShell() (string, []string) {
	if runtime.GOOS == "windows" {
		return "cmd.exe", nil
	}
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	return shell, nil
}

func resolveWithin(root string, rel string) (string, error) {
	if strings.TrimSpace(rel) == "" {
		return root, nil
	}
	target := filepath.Join(root, filepath.Clean(rel))
	target, err := filepath.Abs(target)
	if err != nil {
		return "", err
	}
	if target != root && !strings.HasPrefix(target, root+string(os.PathSeparator)) {
		return "", os.ErrPermission
	}
	return target, nil
}
