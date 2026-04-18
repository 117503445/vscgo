import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import Editor, { loader } from '@monaco-editor/react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './style.css';

loader.config({ paths: { vs: '/monaco/vs' } });

function App() {
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [entries, setEntries] = useState([]);
  const [selected, setSelected] = useState('');
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState('Loading workspace...');
  const terminalHost = useRef(null);
  const terminalRef = useRef(null);
  const fitRef = useRef(null);
  const wsRef = useRef(null);

  useEffect(() => {
    loadState();
  }, []);

  useEffect(() => {
    if (!terminalHost.current || terminalRef.current) {
      return;
    }
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: '"Fira Code", "JetBrains Mono", monospace',
      theme: {
        background: '#11161c',
        foreground: '#d7dae0'
      }
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(terminalHost.current);
    fit.fit();
    terminalRef.current = term;
    fitRef.current = fit;
    connectTerminal();

    const onResize = () => {
      fit.fit();
      sendTerminal({ type: 'resize', cols: term.cols, rows: term.rows });
    };
    window.addEventListener('resize', onResize);
    term.onData(data => sendTerminal({ type: 'input', data }));
    window.__terminalReady = false;
    return () => {
      window.removeEventListener('resize', onResize);
      wsRef.current?.close();
      term.dispose();
    };
  }, [terminalHost]);

  async function loadState() {
    const res = await fetch('/api/state');
    const data = await res.json();
    setWorkspaceRoot(data.workspaceRoot);
    setEntries(data.entries);
    if (data.entries.length) {
      const file = data.entries.find(entry => !entry.isDir) ?? data.entries[0];
      if (!file.isDir) {
        await openFile(file.path);
      }
    }
    setStatus('Workspace ready');
  }

  async function openFile(filePath) {
    const res = await fetch(`/api/fs/file?path=${encodeURIComponent(filePath)}`);
    const data = await res.json();
    setSelected(filePath);
    setContent(data.content);
    setDirty(false);
    setStatus(`Opened ${filePath}`);
  }

  async function saveFile() {
    if (!selected) {
      return;
    }
    const res = await fetch('/api/fs/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: selected, content })
    });
    if (!res.ok) {
      const data = await res.json();
      setStatus(data.error ?? 'Save failed');
      return;
    }
    setDirty(false);
    setStatus(`Saved ${selected}`);
  }

  function connectTerminal() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/terminal`);
    wsRef.current = ws;
    ws.onopen = () => {
      const term = terminalRef.current;
      fitRef.current.fit();
      sendTerminal({ type: 'resize', cols: term.cols, rows: term.rows });
      setStatus('Terminal connected');
      window.__terminalReady = true;
    };
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.type === 'output') {
        terminalRef.current.write(message.data);
      } else if (message.type === 'error') {
        terminalRef.current.writeln(`\r\n[error] ${message.message}`);
      }
    };
    ws.onclose = () => {
      setStatus('Terminal disconnected');
      window.__terminalReady = false;
    };
  }

  function sendTerminal(message) {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }

  useEffect(() => {
    const onKeyDown = event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveFile();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="panel-title">Explorer</div>
        <div className="workspace-root" data-testid="workspace-root">{workspaceRoot}</div>
        <div className="file-list">
          {entries.map(entry => (
            <button
              key={entry.path}
              className={`file-item ${selected === entry.path ? 'active' : ''}`}
              onClick={() => !entry.isDir && openFile(entry.path)}
              disabled={entry.isDir}
            >
              <span className="file-kind">{entry.isDir ? 'DIR' : 'FILE'}</span>
              <span>{entry.name}</span>
            </button>
          ))}
        </div>
      </aside>
      <main className="main-pane">
        <header className="titlebar">
          <div>
            <div className="title">code-server-go</div>
            <div className="subtitle">{selected || 'No file selected'}</div>
          </div>
          <button className="save-button" onClick={saveFile} disabled={!selected}>
            {dirty ? 'Save *' : 'Save'}
          </button>
        </header>
        <section className="editor-pane">
          <Editor
            theme="vs-dark"
            path={selected}
            value={content}
            onChange={value => {
              setContent(value ?? '');
              setDirty(true);
            }}
            options={{
              fontSize: 14,
              minimap: { enabled: false },
              automaticLayout: true
            }}
          />
        </section>
        <section className="terminal-pane">
          <div className="panel-title">
            <span>Terminal</span>
            <span data-testid="terminal-connect">{status}</span>
          </div>
          <div className="terminal-surface" data-testid="terminal-surface" ref={terminalHost}></div>
        </section>
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
