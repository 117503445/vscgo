package main

import (
	"context"
	"os"
	"path/filepath"

	"github.com/rs/zerolog/log"
)

func build() error {
	ctx := context.Background()
	distDir := filepath.Join(dirProjectRoot, "dist")
	binDir := filepath.Join(dirProjectRoot, "data", "bin")
	binPath := filepath.Join(binDir, "code-server-go")

	_ = os.RemoveAll(distDir)
	if err := copyDir(filepath.Join(dirVSCodeRoot, "out"), filepath.Join(distDir, "static", "out")); err != nil {
		return err
	}
	if err := copyFile(
		filepath.Join(dirVSCodeRoot, "node_modules", "@vscode", "codicons", "dist", "codicon.ttf"),
		filepath.Join(distDir, "static", "out", "vs", "base", "browser", "ui", "codicons", "codicon", "codicon.ttf"),
		0o644,
	); err != nil {
		return err
	}
	if err := copyDir(filepath.Join(dirVSCodeRoot, "resources"), filepath.Join(distDir, "static", "resources")); err != nil {
		return err
	}
	if err := copyDir(filepath.Join(dirVSCodeRoot, "node_modules", "@xterm"), filepath.Join(distDir, "static", "node_modules", "@xterm")); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(distDir, "static", "code-server-go"), 0o755); err != nil {
		return err
	}
	if err := copyFile(
		filepath.Join(dirProjectRoot, "web", "static", "workbench.js"),
		filepath.Join(distDir, "static", "code-server-go", "workbench.js"),
		0o644,
	); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(distDir, "templates"), 0o755); err != nil {
		return err
	}
	if err := copyFile(
		filepath.Join(dirProjectRoot, "web", "templates", "workbench.html"),
		filepath.Join(distDir, "templates", "workbench.html"),
		0o644,
	); err != nil {
		return err
	}
	if err := copyFile(
		filepath.Join(dirVSCodeRoot, "out", "vs", "code", "browser", "workbench", "callback.html"),
		filepath.Join(distDir, "templates", "callback.html"),
		0o644,
	); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(distDir, "static", "out", "nls.messages.js"), []byte("export {};\n"), 0o644); err != nil {
		return err
	}

	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return err
	}
	if err := runCmd(ctx, dirProjectRoot, "env", "CGO_ENABLED=0", "go", "build", "-o", binPath, "./cmd/code-server-go"); err != nil {
		return err
	}

	log.Info().Str("binary", binPath).Str("dist", distDir).Msg("build completed")
	return nil
}
