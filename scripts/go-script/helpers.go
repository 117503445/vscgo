package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/117503445/goutils"
	"github.com/rs/zerolog/log"
)

var dirRepoRoot = func() string {
	d, err := goutils.FindGitRepoRoot()
	if err != nil {
		log.Panic().Err(err).Msg("find repo root")
	}
	return d
}()

var dirProjectRoot = dirRepoRoot

var dirVSCodeRoot = func() string {
	if root := strings.TrimSpace(os.Getenv("VSCODE_REPO_ROOT")); root != "" {
		abs, err := filepath.Abs(root)
		if err != nil {
			log.Panic().Err(err).Str("path", root).Msg("resolve VSCODE_REPO_ROOT")
		}
		if !hasVSCodeArtifacts(abs) {
			log.Panic().Str("path", abs).Msg("VSCODE_REPO_ROOT is missing required VS Code build artifacts")
		}
		return abs
	}
	if hasVSCodeArtifacts(dirRepoRoot) {
		return dirRepoRoot
	}
	log.Panic().Msg("set VSCODE_REPO_ROOT to a VS Code checkout that already has out/, resources/, and node_modules/@xterm")
	return ""
}()

func hasVSCodeArtifacts(root string) bool {
	for _, rel := range []string{
		"out",
		"resources",
		filepath.Join("node_modules", "@xterm"),
	} {
		if _, err := os.Stat(filepath.Join(root, rel)); err != nil {
			return false
		}
	}
	return true
}

func runCmd(ctx context.Context, dir string, name string, args ...string) error {
	log.Info().Str("dir", dir).Str("cmd", name+" "+strings.Join(args, " ")).Msg("exec")
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	return cmd.Run()
}

func outputCmd(ctx context.Context, dir string, name string, args ...string) (string, error) {
	log.Info().Str("dir", dir).Str("cmd", name+" "+strings.Join(args, " ")).Msg("exec")
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("%s %s: %w\n%s", name, strings.Join(args, " "), err, string(out))
	}
	return strings.TrimSpace(string(out)), nil
}

func copyDir(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, info.Mode())
		}
		return copyFile(path, target, info.Mode())
	})
}

func copyFile(src, dst string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()

	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return os.Chmod(dst, mode)
}
