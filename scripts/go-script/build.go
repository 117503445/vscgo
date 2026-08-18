package main

import (
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/rs/zerolog/log"
)

func build() error {
	ctx := context.Background()
	distDir := filepath.Join(dirProjectRoot, "dist")
	binDir := filepath.Join(dirProjectRoot, "data", "bin")
	binPath := filepath.Join(binDir, "code-server-go")

	// The workbench CSS references codicon.ttf relative to src/; the file is
	// gitignored upstream, so stage it from node_modules before bundling.
	if err := copyFile(
		filepath.Join(dirVSCodeRoot, "node_modules", "@vscode", "codicons", "dist", "codicon.ttf"),
		filepath.Join(dirVSCodeRoot, "src", "vs", "base", "browser", "ui", "codicons", "codicon", "codicon.ttf"),
		0o644,
	); err != nil {
		return err
	}
	if err := runCmd(ctx, dirVSCodeRoot, "node", "build/next/index.ts", "bundle", "--out", "out-web-min", "--target", "web", "--minify", "--mangle-privates"); err != nil {
		return err
	}

	_ = os.RemoveAll(distDir)
	if err := copyDir(filepath.Join(dirVSCodeRoot, "out-web-min"), filepath.Join(distDir, "static", "out")); err != nil {
		return err
	}
	// Source maps are dev artifacts; shipping them would bloat the binary by ~70MB.
	if err := removeSourceMaps(filepath.Join(distDir, "static", "out")); err != nil {
		return err
	}
	if err := copyDir(filepath.Join(dirVSCodeRoot, "resources"), filepath.Join(distDir, "static", "resources")); err != nil {
		return err
	}
	// The integrated terminal loads xterm.js with a plain script tag at
	// runtime, so it must be served outside the bundle.
	if err := copyDir(filepath.Join(dirVSCodeRoot, "node_modules", "@xterm"), filepath.Join(distDir, "static", "node_modules", "@xterm")); err != nil {
		return err
	}
	if err := copyFile(
		filepath.Join(dirVSCodeRoot, "product.json"),
		filepath.Join(distDir, "static", "product.json"),
		0o644,
	); err != nil {
		return err
	}
	// Copy built-in extensions (downloaded into web/static/extensions)
	extSrcDir := filepath.Join(dirProjectRoot, "web", "static", "extensions")
	if _, err := os.Stat(extSrcDir); err == nil {
		if err := os.MkdirAll(filepath.Join(distDir, "static", "extensions"), 0o755); err != nil {
			return err
		}
		if err := copyDir(extSrcDir, filepath.Join(distDir, "static", "extensions")); err != nil {
			log.Warn().Err(err).Msg("copy extensions failed, continuing without built-in extensions")
		}
		// VS Code's web scanner reads package.json over plain HTTP, so each vsix
		// must also be unpacked next to its archive.
		if err := extractExtensions(filepath.Join(distDir, "static", "extensions")); err != nil {
			return err
		}
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
		filepath.Join(dirVSCodeRoot, "out-web-min", "vs", "code", "browser", "workbench", "callback.html"),
		filepath.Join(distDir, "templates", "callback.html"),
		0o644,
	); err != nil {
		return err
	}

	// Precompress text assets; handleStatic serves the .gz variant when the
	// client accepts gzip. The workbench bundle alone is 17MB -> ~4MB.
	if err := precompressStatic(filepath.Join(distDir, "static")); err != nil {
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

// extractExtensions unpacks every *.vsix in dir into a sibling directory named
// after the archive, stripping the vsix's top-level "extension/" prefix.
func extractExtensions(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".vsix") {
			continue
		}
		if err := extractVSIX(filepath.Join(dir, name), filepath.Join(dir, strings.TrimSuffix(name, ".vsix"))); err != nil {
			return fmt.Errorf("extract %s: %w", name, err)
		}
	}
	return nil
}

func extractVSIX(vsixPath, dstDir string) error {
	raw, err := os.ReadFile(vsixPath)
	if err != nil {
		return err
	}
	if len(raw) >= 2 && raw[0] == 0x1f && raw[1] == 0x8b {
		gz, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			return err
		}
		raw, err = io.ReadAll(gz)
		gz.Close()
		if err != nil {
			return err
		}
	}
	reader, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return err
	}

	for _, f := range reader.File {
		rel := strings.TrimPrefix(f.Name, "extension/")
		if rel == f.Name || rel == "" {
			continue
		}
		target := filepath.Join(dstDir, rel)
		if target != dstDir && !strings.HasPrefix(target, dstDir+string(os.PathSeparator)) {
			return fmt.Errorf("illegal path in vsix: %s", f.Name)
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		src, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
		if err != nil {
			src.Close()
			return err
		}
		_, copyErr := io.Copy(out, src)
		closeErr := out.Close()
		src.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}

var precompressibleExts = map[string]bool{
	".js":   true,
	".css":  true,
	".html": true,
	".json": true,
	".svg":  true,
}

func precompressStatic(dir string) error {
	return filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		if !precompressibleExts[strings.ToLower(filepath.Ext(path))] || info.Size() < 1024 {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var buf bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
		if _, err := zw.Write(raw); err != nil {
			return err
		}
		if err := zw.Close(); err != nil {
			return err
		}
		return os.WriteFile(path+".gz", buf.Bytes(), 0o644)
	})
}
