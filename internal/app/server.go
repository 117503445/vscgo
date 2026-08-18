package app

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/rs/zerolog"
)

type Config struct {
	Addr          string
	WorkspaceRoot string
	StaticFS      embed.FS
}

type Server struct {
	addr          string
	workspaceRoot string
	log           zerolog.Logger
	staticFS      fs.FS
	templateFS    fs.FS
	terminalHub   *TerminalHub
	staticHandler http.Handler
	httpServer    *http.Server
}

func New(cfg Config, logger zerolog.Logger) (*Server, error) {
	if cfg.Addr == "" {
		cfg.Addr = ":8080"
	}
	if cfg.WorkspaceRoot == "" {
		return nil, errors.New("workspace root is required")
	}

	workspaceRoot, err := filepath.Abs(cfg.WorkspaceRoot)
	if err != nil {
		return nil, fmt.Errorf("abs workspace root: %w", err)
	}

	distFS, err := fs.Sub(cfg.StaticFS, "dist")
	if err != nil {
		return nil, fmt.Errorf("load embedded dist: %w", err)
	}
	staticFS, err := fs.Sub(distFS, "static")
	if err != nil {
		return nil, fmt.Errorf("load embedded static assets: %w", err)
	}
	templateFS, err := fs.Sub(distFS, "templates")
	if err != nil {
		return nil, fmt.Errorf("load embedded templates: %w", err)
	}

	s := &Server{
		addr:          cfg.Addr,
		workspaceRoot: workspaceRoot,
		log:           logger.With().Str("workspace", workspaceRoot).Logger(),
		staticFS:      staticFS,
		templateFS:    templateFS,
		staticHandler: http.StripPrefix("/static/", http.FileServer(http.FS(staticFS))),
	}
	s.terminalHub = NewTerminalHub(workspaceRoot, s.log.With().Str("component", "terminal").Logger())
	return s, nil
}

func (s *Server) Run(ctx context.Context) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRoot)
	mux.HandleFunc("/callback", s.handleCallback)
	mux.HandleFunc("/static/", s.handleStatic)
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/api/state", s.handleState)
	mux.HandleFunc("/api/fs/stat", s.handleStat)
	mux.HandleFunc("/api/fs/readdir", s.handleReaddir)
	mux.HandleFunc("/api/fs/tree", s.handleTree)
	mux.HandleFunc("/api/fs/file", s.handleFile)
	mux.HandleFunc("/api/fs/mkdir", s.handleMkdir)
	mux.HandleFunc("/api/fs/entry", s.handleDeleteEntry)
	mux.HandleFunc("/api/fs/rename", s.handleRename)
	mux.HandleFunc("/ws/terminal", s.handleTerminalWS)

	s.httpServer = &http.Server{
		Addr:              s.addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		s.log.Info().Str("addr", s.addr).Msg("serving http")
		if err := s.httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
			return
		}
		errCh <- nil
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = s.httpServer.Shutdown(shutdownCtx)
		return ctx.Err()
	case err := <-errCh:
		return err
	}
}

func (s *Server) handleRoot(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}

	// Support ?folder= query parameter for workspace switching.
	// The parameter is relative to the configured workspace root.
	folderParam := r.URL.Query().Get("folder")
	workspaceRoot := s.workspaceRoot
	if folderParam != "" {
		if !strings.HasPrefix(folderParam, "/") {
			folderParam = "/" + folderParam
		}
		if resolved, ok := s.resolveFolderWithinWorkspace(folderParam); ok {
			workspaceRoot = resolved
			// Set cookie for subsequent API calls
			http.SetCookie(w, &http.Cookie{
				Name:  "code-server-go-folder",
				Value: resolved,
				Path:  "/",
			})
		}
	} else {
		// Plain load renders the default root; drop any stale folder override.
		http.SetCookie(w, &http.Cookie{
			Name:   "code-server-go-folder",
			Value:  "",
			Path:   "/",
			MaxAge: -1,
		})
	}

	values := map[string]string{
		"WORKBENCH_WEB_BASE_URL":       "/static",
		"WORKBENCH_WEB_CONFIGURATION":  s.asJSON(s.workbenchConfigurationWithRoot(workspaceRoot)),
		"WORKBENCH_AUTH_SESSION":       "",
		"WORKBENCH_BUILTIN_EXTENSIONS": s.builtinExtensionsJSON(),
		"WORKBENCH_DEV_CSS_MODULES":    string(mustJSON(s.cssModules())),
	}

	data, err := s.renderTemplate("workbench.html", values)
	if err != nil {
		s.log.Error().Err(err).Msg("render workbench template")
		http.Error(w, "failed to render workbench", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func (s *Server) handleCallback(w http.ResponseWriter, r *http.Request) {
	data, err := fs.ReadFile(s.templateFS, "callback.html")
	if err != nil {
		s.log.Error().Err(err).Msg("load callback template")
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	relativePath := strings.TrimPrefix(path.Clean("/"+strings.TrimPrefix(r.URL.Path, "/static/")), "/")
	if relativePath == "" || relativePath == "." {
		s.staticHandler.ServeHTTP(w, r)
		return
	}

	if _, err := fs.Stat(s.staticFS, relativePath); err == nil {
		// Embedded files carry no modtime/etag; without this browsers heuristically
		// cache stale assets across binary upgrades.
		w.Header().Set("Cache-Control", "no-cache")
		s.staticHandler.ServeHTTP(w, r)
		return
	}

	http.NotFound(w, r)
}

func (s *Server) renderTemplate(name string, values map[string]string) ([]byte, error) {
	raw, err := fs.ReadFile(s.templateFS, name)
	if err != nil {
		return nil, err
	}
	rendered := string(raw)
	for key, value := range values {
		rendered = strings.ReplaceAll(rendered, "{{"+key+"}}", value)
	}
	return []byte(rendered), nil
}

func (s *Server) builtinExtensions() []any {
	// Built-in extensions served from /static/extensions/
	exts := []struct {
		name      string
		version   string
	}{
		{"pkief.material-icon-theme", "5.20.0"},
		{"mechatroner.rainbow-csv", "3.6.0"},
		{"iliazeus.vscode-ansi", "1.1.4"},
		{"njzy.stats-bar", "0.5.2"},
		{"tomoki1207.pdf", "1.2.2"},
		{"humao.rest-client", "0.25.1"},
		{"mhutchie.git-graph", "1.30.0"},
	}
	var result []any
	for _, ext := range exts {
		result = append(result, map[string]any{
			"name":    ext.name,
			"version": ext.version,
			"path":    fmt.Sprintf("/static/extensions/%s-%s.vsix", ext.name, ext.version),
		})
	}
	return result
}

func (s *Server) builtinExtensionsJSON() string {
	return s.asJSON(s.builtinExtensions())
}

func (s *Server) workbenchConfigurationWithRoot(root string) map[string]any {
	workspacePath := filepath.ToSlash(root)
	if !strings.HasPrefix(workspacePath, "/") {
		workspacePath = "/" + workspacePath
	}

	return map[string]any{
		"serverBasePath":       "/",
		"callbackRoute":        "/callback",
		"enableWorkspaceTrust": false,
		"folderUri": map[string]any{
			"scheme":    "code-server",
			"authority": "",
			"path":      workspacePath,
		},
		"workspaceUri":                nil,
		"additionalBuiltinExtensions": s.builtinExtensions(),
		"settingsSyncOptions": map[string]any{
			"enabled": false,
		},
		"configurationDefaults": map[string]any{
			"terminal.integrated.enablePersistentSessions": false,
			"terminal.integrated.shellIntegration.enabled": false,
			"workbench.startupEditor":                      "none",
		},
		"windowIndicator": map[string]any{
			"label":   "$(browser) code-server-go",
			"tooltip": root,
		},
		"productConfiguration": map[string]any{
			"enableTelemetry": false,
		},
	}
}

func (s *Server) workbenchConfiguration() map[string]any {
	return s.workbenchConfigurationWithRoot(s.workspaceRoot)
}
func (s *Server) cssModules() []string {
	var modules []string
	_ = fs.WalkDir(s.staticFS, "out/vs", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		if strings.HasSuffix(path, ".css") {
			modules = append(modules, strings.TrimPrefix(path, "out/"))
		}
		return nil
	})
	sort.Strings(modules)
	return modules
}

func (s *Server) asJSON(value any) string {
	return strings.ReplaceAll(string(mustJSON(value)), `"`, "&quot;")
}

func mustJSON(value any) []byte {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return data
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	s.writeJSON(w, http.StatusOK, map[string]any{
		"ok":        true,
		"workspace": s.workspaceRoot,
	})
}

func (s *Server) handleState(w http.ResponseWriter, r *http.Request) {
	tree, err := s.listDir(r, "")
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"workspaceRoot": s.workspaceRoot,
		"entries":       tree,
	})
}

func (s *Server) handleStat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	entry, err := s.statPath(r, r.URL.Query().Get("path"))
	if err != nil {
		s.writeError(w, statusForError(err), err)
		return
	}
	s.writeJSON(w, http.StatusOK, entry)
}

func (s *Server) handleReaddir(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	rel := r.URL.Query().Get("path")
	entries, err := s.listDir(r, rel)
	if err != nil {
		s.writeError(w, statusForError(err), err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"path":    cleanRelPath(rel),
		"entries": entries,
	})
}

func (s *Server) handleTree(w http.ResponseWriter, r *http.Request) {
	rel := r.URL.Query().Get("path")
	entries, err := s.listDir(r, rel)
	if err != nil {
		s.writeError(w, statusForError(err), err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"path":    cleanRelPath(rel),
		"entries": entries,
	})
}

func (s *Server) handleFile(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.handleReadFile(w, r)
	case http.MethodPut:
		s.handleWriteFile(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleReadFile(w http.ResponseWriter, r *http.Request) {
	abs, err := s.resolvePathForRequest(r, r.URL.Query().Get("path"))
	if err != nil {
		s.writeError(w, statusForError(err), err)
		return
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		s.writeError(w, statusForError(err), err)
		return
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func (s *Server) handleWriteFile(w http.ResponseWriter, r *http.Request) {
	rel := r.URL.Query().Get("path")
	abs, err := s.resolvePathForRequest(r, rel)
	if err != nil {
		s.writeError(w, statusForError(err), err)
		return
	}

	data, err := io.ReadAll(r.Body)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err)
		return
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		s.writeError(w, http.StatusInternalServerError, err)
		return
	}
	if err := os.WriteFile(abs, data, 0o644); err != nil {
		s.writeError(w, statusForError(err), err)
		return
	}

	entry, err := s.statPath(r, rel)
	if err != nil {
		s.writeError(w, statusForError(err), err)
		return
	}
	s.writeJSON(w, http.StatusOK, entry)
}

func (s *Server) handleMkdir(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	rel := r.URL.Query().Get("path")
	abs, err := s.resolvePathForRequest(r, rel)
	if err != nil {
		s.writeError(w, statusForError(err), err)
		return
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		s.writeError(w, statusForError(err), err)
		return
	}

	entry, err := s.statPath(r, rel)
	if err != nil {
		s.writeError(w, statusForError(err), err)
		return
	}
	s.writeJSON(w, http.StatusOK, entry)
}

func (s *Server) handleDeleteEntry(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	abs, err := s.resolvePathForRequest(r, r.URL.Query().Get("path"))
	if err != nil {
		s.writeError(w, statusForError(err), err)
		return
	}
	if err := os.RemoveAll(abs); err != nil {
		s.writeError(w, statusForError(err), err)
		return
	}

	s.writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func (s *Server) handleRename(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var payload struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		s.writeError(w, http.StatusBadRequest, err)
		return
	}

	fromAbs, err := s.resolvePathForRequest(r, payload.From)
	if err != nil {
		s.writeError(w, statusForError(err), err)
		return
	}
	toAbs, err := s.resolvePathForRequest(r, payload.To)
	if err != nil {
		s.writeError(w, statusForError(err), err)
		return
	}
	if err := os.MkdirAll(filepath.Dir(toAbs), 0o755); err != nil {
		s.writeError(w, http.StatusInternalServerError, err)
		return
	}
	if err := os.Rename(fromAbs, toAbs); err != nil {
		s.writeError(w, statusForError(err), err)
		return
	}

	entry, err := s.statPath(r, payload.To)
	if err != nil {
		s.writeError(w, statusForError(err), err)
		return
	}
	s.writeJSON(w, http.StatusOK, entry)
}

func (s *Server) handleTerminalWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
		OriginPatterns:     []string{"*"},
	})
	if err != nil {
		s.log.Error().Err(err).Msg("accept websocket")
		return
	}
	defer conn.CloseNow()

	cwd := r.URL.Query().Get("cwd")
	session, err := s.terminalHub.NewSession(r.Context(), cwd)
	if err != nil {
		_ = writeWSJSON(r.Context(), conn, map[string]any{"type": "error", "message": err.Error()})
		_ = conn.Close(websocket.StatusInternalError, err.Error())
		return
	}
	defer session.Close()

	if err := session.Run(r.Context(), conn); err != nil && websocket.CloseStatus(err) == -1 && !errors.Is(err, context.Canceled) {
		s.log.Error().Err(err).Msg("terminal websocket")
	}
}

type FileEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size,omitempty"`
	Mtime int64  `json:"mtime"`
	Ctime int64  `json:"ctime"`
}

func (s *Server) listDir(r *http.Request, rel string) ([]FileEntry, error) {
	abs, err := s.resolvePathForRequest(r, rel)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(abs)
	if err != nil {
		return nil, err
	}

	result := make([]FileEntry, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".git") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return nil, err
		}
		childRel := cleanRelPath(filepath.ToSlash(filepath.Join(rel, name)))
		result = append(result, FileEntry{
			Name:  name,
			Path:  childRel,
			IsDir: entry.IsDir(),
			Size:  info.Size(),
			Mtime: info.ModTime().UnixMilli(),
			Ctime: info.ModTime().UnixMilli(),
		})
	}

	sort.Slice(result, func(i, j int) bool {
		if result[i].IsDir != result[j].IsDir {
			return result[i].IsDir
		}
		return strings.ToLower(result[i].Name) < strings.ToLower(result[j].Name)
	})
	return result, nil
}

func (s *Server) statPath(r *http.Request, rel string) (FileEntry, error) {
	abs, err := s.resolvePathForRequest(r, rel)
	if err != nil {
		return FileEntry{}, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return FileEntry{}, err
	}

	name := info.Name()
	cleanRel := cleanRelPath(rel)
	if cleanRel == "" {
		name = filepath.Base(s.workspaceRoot)
	}

	return FileEntry{
		Name:  name,
		Path:  cleanRel,
		IsDir: info.IsDir(),
		Size:  info.Size(),
		Mtime: info.ModTime().UnixMilli(),
		Ctime: info.ModTime().UnixMilli(),
	}, nil
}

func (s *Server) resolveFolderWithinWorkspace(folder string) (string, bool) {
	resolved, err := filepath.Abs(filepath.Join(s.workspaceRoot, folder))
	if err != nil {
		return "", false
	}
	if resolved != s.workspaceRoot && !strings.HasPrefix(resolved, s.workspaceRoot+string(os.PathSeparator)) {
		return "", false
	}
	return resolved, true
}

func (s *Server) resolvePathForRequest(r *http.Request, rel string) (string, error) {
	root := s.workspaceRoot
	if cookie, err := r.Cookie("code-server-go-folder"); err == nil && cookie.Value != "" {
		// Cookie is client-supplied; only honor absolute paths inside the workspace root.
		candidate := filepath.Clean(cookie.Value)
		if filepath.IsAbs(candidate) && (candidate == s.workspaceRoot || strings.HasPrefix(candidate, s.workspaceRoot+string(os.PathSeparator))) {
			root = candidate
		}
	}
	clean := filepath.Clean(strings.TrimSpace(rel))
	if clean == "." || clean == "" {
		return root, nil
	}
	target := filepath.Join(root, clean)
	target, err := filepath.Abs(target)
	if err != nil {
		return "", err
	}
	if target != root && !strings.HasPrefix(target, root+string(os.PathSeparator)) {
		return "", os.ErrPermission
	}
	return target, nil
}

func cleanRelPath(rel string) string {
	clean := filepath.ToSlash(filepath.Clean(strings.TrimSpace(rel)))
	switch clean {
	case ".", "/", "":
		return ""
	default:
		return strings.TrimPrefix(clean, "/")
	}
}

func (s *Server) writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func (s *Server) writeError(w http.ResponseWriter, status int, err error) {
	s.writeJSON(w, status, map[string]any{"error": err.Error()})
}

func statusForError(err error) int {
	switch {
	case errors.Is(err, os.ErrPermission):
		return http.StatusForbidden
	case errors.Is(err, os.ErrNotExist):
		return http.StatusNotFound
	default:
		return http.StatusInternalServerError
	}
}

func writeWSJSON(ctx context.Context, conn *websocket.Conn, payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, data)
}
