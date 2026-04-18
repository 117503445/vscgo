package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/rs/zerolog/log"
)

type e2eResult struct {
	Scenario     string   `json:"scenario"`
	Status       string   `json:"status"`
	URL          string   `json:"url"`
	Screenshots  []string `json:"screenshots"`
	Observations []string `json:"observations"`
}

func runE2E() error {
	ctx := context.Background()
	if err := build(); err != nil {
		return err
	}

	runDir := filepath.Join(dirProjectRoot, "data", "e2e", "runs", time.Now().Format("20060102-150405"))
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		return err
	}

	result, err := runLocalE2E(ctx, runDir)
	if err != nil {
		result.Status = "failed"
		result.Observations = append(result.Observations, err.Error())
	}

	reportPath := filepath.Join(runDir, "report.md")
	if err := os.WriteFile(reportPath, []byte(renderReport(runDir, []e2eResult{result})), 0o644); err != nil {
		return err
	}

	log.Info().Str("report", reportPath).Msg("e2e finished")
	if err != nil {
		return fmt.Errorf("e2e failed, see %s", reportPath)
	}
	return nil
}

func runLocalE2E(ctx context.Context, runDir string) (e2eResult, error) {
	result := e2eResult{Scenario: "local-dev-flow", Status: "failed"}
	outputDir := filepath.Join(runDir, "local")
	if err := os.MkdirAll(outputDir, 0o755); err != nil {
		return result, err
	}

	workspaceDir := filepath.Join(outputDir, "workspace")
	if err := os.MkdirAll(workspaceDir, 0o755); err != nil {
		return result, err
	}

	workspaceFile := filepath.Join(workspaceDir, "playground.txt")
	if err := os.WriteFile(workspaceFile, []byte("original from e2e\n"), 0o644); err != nil {
		return result, err
	}

	port, err := randomPort()
	if err != nil {
		return result, err
	}

	serverLogPath := filepath.Join(outputDir, "server.log")
	serverLog, err := os.Create(serverLogPath)
	if err != nil {
		return result, err
	}
	defer serverLog.Close()

	binPath := filepath.Join(dirProjectRoot, "data", "bin", "code-server-go")
	cmd := exec.CommandContext(ctx, binPath)
	cmd.Dir = workspaceDir
	cmd.Env = append(os.Environ(), "CODE_SERVER_GO_ADDR="+fmt.Sprintf("127.0.0.1:%d", port))
	cmd.Stdout = serverLog
	cmd.Stderr = serverLog
	if err := cmd.Start(); err != nil {
		return result, fmt.Errorf("start local server: %w", err)
	}

	waitCh := make(chan error, 1)
	go func() {
		waitCh <- cmd.Wait()
	}()
	defer stopProcess(cmd, waitCh)

	url := fmt.Sprintf("http://127.0.0.1:%d", port)
	result.URL = url
	if err := waitHTTP(ctx, url+"/healthz", 60*time.Second); err != nil {
		return result, fmt.Errorf("wait for server: %w (see %s)", err, serverLogPath)
	}

	out, err := outputCmdAllowFailure(ctx, dirVSCodeRoot, "node",
		filepath.Join(dirProjectRoot, "scripts", "playwright", "e2e.mjs"),
		"--url", url,
		"--scenario", result.Scenario,
		"--output-dir", outputDir,
		"--workspace-file", workspaceFile,
	)
	if err != nil {
		return result, fmt.Errorf("run playwright: %w (see %s)", err, serverLogPath)
	}
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		return result, fmt.Errorf("parse playwright result: %w\n%s", err, out)
	}
	result.Observations = append(result.Observations, "Server log: "+serverLogPath)
	if result.Status != "passed" {
		return result, fmt.Errorf("playwright scenario failed (see %s)", serverLogPath)
	}

	return result, nil
}

func stopProcess(cmd *exec.Cmd, waitCh <-chan error) {
	if cmd.Process == nil {
		return
	}

	_ = cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-waitCh:
	case <-time.After(5 * time.Second):
		_ = cmd.Process.Kill()
		<-waitCh
	}
}

func outputCmdAllowFailure(ctx context.Context, dir string, name string, args ...string) (string, error) {
	log.Info().Str("dir", dir).Str("cmd", name+" "+strings.Join(args, " ")).Msg("exec")
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	text := strings.TrimSpace(string(out))
	if err == nil {
		return text, nil
	}

	var result e2eResult
	if json.Unmarshal([]byte(text), &result) == nil && result.Status != "" {
		return text, nil
	}

	return "", fmt.Errorf("%s %s: %w\n%s", name, strings.Join(args, " "), err, text)
}

func waitHTTP(ctx context.Context, url string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
	return fmt.Errorf("timeout waiting for %s", url)
}

func randomPort() (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port, nil
}

func renderReport(runDir string, results []e2eResult) string {
	var b strings.Builder
	b.WriteString("# code-server-go E2E Report\n\n")
	b.WriteString("Flow: build the local binary -> start pure-Go `code-server-go` against a temporary workspace -> open the official VS Code workbench in Playwright -> verify there is no `/oss-dev` remote bootstrap -> edit and save a file -> create a terminal and execute a command -> capture screenshots.\n\n")
	b.WriteString(fmt.Sprintf("- Run directory: `%s`\n\n", runDir))
	for _, result := range results {
		b.WriteString(fmt.Sprintf("## %s\n\n", strings.Title(strings.ReplaceAll(result.Scenario, "-", " "))))
		b.WriteString(fmt.Sprintf("- Status: **%s**\n", result.Status))
		b.WriteString(fmt.Sprintf("- URL: `%s`\n", result.URL))
		for _, note := range result.Observations {
			b.WriteString(fmt.Sprintf("- Observation: %s\n", note))
		}
		for _, shot := range result.Screenshots {
			rel, _ := filepath.Rel(runDir, shot)
			b.WriteString(fmt.Sprintf("- Screenshot: `%s`\n", rel))
		}
		b.WriteString("\n")
	}
	return b.String()
}
