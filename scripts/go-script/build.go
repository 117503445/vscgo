package main

import (
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
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
	// Stage declarative built-in extensions (grammars, themes, snippets) into
	// .build/web/extensions: the bundler inlines this list into the bundle, and
	// the files are served under /static/extensions below.
	stagedExtensions, err := stageWebExtensions()
	if err != nil {
		return err
	}
	log.Info().Int("count", stagedExtensions).Msg("staged declarative builtin extensions")
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
	// TextMate tokenization loads vscode-textmate/vscode-oniguruma at runtime
	// via importAMDNodeModule; encoding support loads iconv-lite/jschardet and
	// markdown math preview loads katex. All are plain script-tag/wasm loads
	// resolved under /static/node_modules, so they must be served unbundled.
	for _, mod := range []string{
		"vscode-oniguruma",
		"vscode-textmate",
		"jschardet",
		"katex",
	} {
		if err := copyDir(filepath.Join(dirVSCodeRoot, "node_modules", mod), filepath.Join(distDir, "static", "node_modules", mod)); err != nil {
			return fmt.Errorf("copy node module %s: %w", mod, err)
		}
	}
	if err := copyDir(filepath.Join(dirVSCodeRoot, "node_modules", "@vscode", "iconv-lite-umd"), filepath.Join(distDir, "static", "node_modules", "@vscode", "iconv-lite-umd")); err != nil {
		return fmt.Errorf("copy node module @vscode/iconv-lite-umd: %w", err)
	}
	if err := copyFile(
		filepath.Join(dirVSCodeRoot, "product.json"),
		filepath.Join(distDir, "static", "product.json"),
		0o644,
	); err != nil {
		return err
	}
	// A source checkout's product.json has no commit, but the workbench treats
	// an empty commit as "not built" and then ignores the builtin extension
	// list baked into the bundle. Stamp the vscode repo commit instead.
	if err := stampProductCommit(ctx, filepath.Join(distDir, "static", "product.json")); err != nil {
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
	// Ship the staged built-in extensions at /static/extensions: that is where
	// builtinExtensionsPath ('vs/../../extensions') resolves at runtime.
	if err := copyDir(
		filepath.Join(dirVSCodeRoot, ".build", "web", "extensions"),
		filepath.Join(distDir, "static", "extensions"),
	); err != nil {
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

// stampProductCommit writes the vscode repo's HEAD commit into product.json.
func stampProductCommit(ctx context.Context, productPath string) error {
	commit, err := outputCmd(ctx, dirVSCodeRoot, "git", "rev-parse", "HEAD")
	if err != nil {
		return fmt.Errorf("resolve vscode commit: %w", err)
	}
	raw, err := os.ReadFile(productPath)
	if err != nil {
		return err
	}
	var product map[string]any
	if err := json.Unmarshal(raw, &product); err != nil {
		return err
	}
	product["commit"] = strings.TrimSpace(commit)
	out, err := json.Marshal(product)
	if err != nil {
		return err
	}
	return os.WriteFile(productPath, out, 0o644)
}

// stageWebExtensions copies VS Code's declarative built-in extensions — those
// without main/browser code, i.e. grammars, themes and snippets — from
// extensions/ into .build/web/extensions. Extensions with code are skipped:
// they would need the upstream per-extension npm install + compile pipeline.
func stageWebExtensions() (int, error) {
	src := filepath.Join(dirVSCodeRoot, "extensions")
	dst := filepath.Join(dirVSCodeRoot, ".build", "web", "extensions")
	if err := os.RemoveAll(dst); err != nil {
		return 0, err
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return 0, err
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return 0, err
	}
	staged := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		manifestPath := filepath.Join(src, entry.Name(), "package.json")
		raw, err := os.ReadFile(manifestPath)
		if err != nil {
			continue
		}
		var manifest map[string]any
		if err := json.Unmarshal(raw, &manifest); err != nil {
			continue
		}
		if _, hasCode := manifest["main"]; hasCode {
			continue
		}
		if _, hasCode := manifest["browser"]; hasCode {
			continue
		}
		if err := copyDir(filepath.Join(src, entry.Name()), filepath.Join(dst, entry.Name())); err != nil {
			return 0, err
		}
		// Declarative extensions must not ship a node_modules dir.
		_ = os.RemoveAll(filepath.Join(dst, entry.Name(), "node_modules"))
		staged++
	}
	return staged, nil
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
	".wasm": true,
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
