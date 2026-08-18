import {
	mainWindow,
	Emitter, Event,
	URI,
	IRemoteAgentHostService, NullRemoteAgentHostService,
	IFileService, FileChangeType, FileSystemProviderCapabilities, FileSystemProviderErrorCode, FileType, createFileSystemProviderError,
	InstantiationType, registerSingleton,
	IFileDialogService,
	IContextKeyService,
	Registry,
	BrowserMain,
	Workbench,
	BasePty,
	ITerminalInstanceService, ITerminalService,
	ProcessPropertyType, TerminalExtensions,
	Schemas
} from '/static/out/vs/code/browser/workbench/codeServerGo.main.js';

const WORKSPACE_SCHEME = 'code-server';

performance.mark('code/didLoadWorkbenchMain');
registerSingleton(IRemoteAgentHostService, NullRemoteAgentHostService, InstantiationType.Delayed);

class HostFileSystemProvider {
	constructor() {
		this.capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive;
		this.onDidChangeCapabilities = Event.None;
		this._onDidChangeFile = new Emitter();
		this.onDidChangeFile = this._onDidChangeFile.event;
	}

	watch() {
		return { dispose() {} };
	}

	async stat(resource) {
		const payload = await requestJSON('/api/fs/stat', { path: this.resourceToPath(resource) });
		return toFileStat(payload);
	}

	async readdir(resource) {
		const payload = await requestJSON('/api/fs/readdir', { path: this.resourceToPath(resource) });
		return payload.entries.map(entry => [entry.name, entry.isDir ? FileType.Directory : FileType.File]);
	}

	async readFile(resource) {
		const response = await request('/api/fs/file', { path: this.resourceToPath(resource) });
		return new Uint8Array(await response.arrayBuffer());
	}

	async writeFile(resource, content) {
		await request('/api/fs/file', { path: this.resourceToPath(resource) }, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/octet-stream' },
			body: content
		});
		this._onDidChangeFile.fire([{ type: FileChangeType.UPDATED, resource }]);
	}

	async mkdir(resource) {
		await request('/api/fs/mkdir', { path: this.resourceToPath(resource) }, { method: 'POST' });
		this._onDidChangeFile.fire([{ type: FileChangeType.ADDED, resource }]);
	}

	async delete(resource) {
		await request('/api/fs/entry', { path: this.resourceToPath(resource) }, { method: 'DELETE' });
		this._onDidChangeFile.fire([{ type: FileChangeType.DELETED, resource }]);
	}

	async rename(from, to) {
		await request('/api/fs/rename', undefined, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				from: this.resourceToPath(from),
				to: this.resourceToPath(to)
			})
		});
		this._onDidChangeFile.fire([
			{ type: FileChangeType.DELETED, resource: from },
			{ type: FileChangeType.ADDED, resource: to }
		]);
	}

	resourceToPath(resource) {
		if (resource.scheme !== WORKSPACE_SCHEME) {
			throw createFileSystemProviderError(`unsupported scheme: ${resource.scheme}`, FileSystemProviderErrorCode.Unavailable);
		}
		return normalizeWorkspacePath(resource.path);
	}
}

class GoTerminalBackend {
	constructor(workspaceRootPath) {
		this.workspaceRootPath = normalizeWorkspacePath(workspaceRootPath);
		this.remoteAuthority = undefined;
		this.isResponsive = true;
		this.whenReady = Promise.resolve();
		this.onPtyHostUnresponsive = Event.None;
		this.onPtyHostResponsive = Event.None;
		this.onPtyHostRestart = Event.None;
		this.onPtyHostConnected = Event.None;
		this.onDidRequestDetach = Event.None;
		this._nextId = 1;
	}

	setReady() {}
	async attachToProcess() { return undefined; }
	async attachToRevivedProcess() { return undefined; }
	async listProcesses() { return []; }
	async getLatency() { return [{ label: 'local', latency: 0 }]; }
	async getPerformanceMarks() { return []; }
	async getDefaultSystemShell() { return '/bin/sh'; }
	async getProfiles() {
		return [
			{ profileName: 'zsh', path: '/bin/zsh', isDefault: true },
			{ profileName: 'bash', path: '/bin/bash' },
			{ profileName: 'sh', path: '/bin/sh' }
		];
	}
	async getWslPath() { return undefined; }
	async getEnvironment() { return {}; }
	async getShellEnvironment() { return {}; }
	async setEnvironment() {}
	async refreshEnvironment() { return {}; }
	async acceptPtyHostResolved() {}
	async requestDetach() {}

	async createProcess(process, options, shouldPersist) {
		const id = this._nextId++;
		const ws = this._openTerminalWS(id, process, options);
		return {
			pid: id,
			shouldPersist: false,
			onDidChangeProperty: Event.None,
			onProcessData: ws.onData,
			onProcessExit: ws.onExit,
			onProcessReady: ws.onReady,
			onProcessTitleChanged: Event.None,
			onProcessOverrideDimensions: Event.None,
			onProcessResolvedShellLaunchConfig: Event.None,
			start() {},
			shutdown(immediate) { ws.close(immediate); },
			input(data) { ws.send({ type: 'input', data }); },
			resize(cols, rows) { ws.send({ type: 'resize', cols, rows }); },
			processBinary(data) { ws.send({ type: 'binary', data }); },
			acknowledgeDataEvent(charCount) {},
			setUnicodeVersion() {},
			getInitialCwd() { return Promise.resolve(this.workspaceRootPath); },
			getCwd() { return Promise.resolve(this.workspaceRootPath); },
			getLatency() { return Promise.resolve(0); },
			orphanQuestion() {},
			sendKeyEvent() {},
			sendMouseEvent() {},
			serializePerformance() {},
			clearBuffer() {},
			clearSelection() {},
			findNext() {},
			findPrevious() {},
		};
	}

	_openTerminalWS(id, process, options) {
		const onData = new Emitter();
		const onExit = new Emitter();
		const onReady = new Emitter();
		let ws, closed = false;

		const cwd = firstDefinedPath(options?.cwd, process?.cwd);
		const url = buildURL('/ws/terminal', { cwd });
		url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

		ws = new WebSocket(url.toString());
		ws.binaryType = 'arraybuffer';

		ws.onopen = () => {
			ws.send(JSON.stringify({
				type: 'create',
				cols: options?.cols ?? 80,
				rows: options?.rows ?? 24
			}));
			onReady.fire({ pid: id, cwd: cwd || this.workspaceRootPath });
		};

		ws.onmessage = (event) => {
			if (closed) return;
			try {
				const msg = JSON.parse(event.data);
				if (msg.type === 'data') {
					onData.fire(msg.data);
				} else if (msg.type === 'exit') {
					closed = true;
					onExit.fire({ code: msg.code });
				}
			} catch {
				onData.fire(new Uint8Array(event.data));
			}
		};

		ws.onclose = () => {
			if (!closed) {
				closed = true;
				onExit.fire({ code: 0 });
			}
		};

		return {
			onData: onData.event,
			onExit: onExit.event,
			onReady: onReady.event,
			send(msg) {
				if (!closed && ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify(msg));
				}
			},
			close(immediate) {
				closed = true;
				if (immediate) {
					ws.close();
				} else {
					ws.send(JSON.stringify({ type: 'exit' }));
					ws.close();
				}
			}
		};
	}
}

class PureGoWorkbench extends Workbench {
	constructor(parent, options, serviceCollection, logService, workspaceRootPath) {
		super(parent, options, serviceCollection, logService);
		this.workspaceRootPath = workspaceRootPath;
	}

	startup() {
		const instantiationService = super.startup();
		instantiationService.invokeFunction(accessor => {
			const terminalInstanceService = accessor.get(ITerminalInstanceService);
			const terminalService = accessor.get(ITerminalService);
			const backend = new GoTerminalBackend(this.workspaceRootPath);
			Registry.as(TerminalExtensions.Backend).registerTerminalBackend(backend);
			terminalInstanceService.didRegisterBackend(backend);
			terminalService.registerProcessSupport(true);
		});
		// Enable Open Folder in web
		instantiationService.invokeFunction(accessor => {
			try {
				const contextKeyService = accessor.get(IContextKeyService);
				contextKeyService.createKey('openFolderWorkspaceSupport', true);
			} catch (e) {
				console.warn('[code-server-go] Failed to enable Open Folder:', e);
			}
			try {
				const fileDialogService = accessor.get(IFileDialogService);
				// Stock VS Code appends the local 'file' scheme for non-file dialogs,
				// which surfaces a "Show Local" button that opens a native picker our
				// provider cannot serve. Keep dialogs on the built-in provider only.
				fileDialogService.addFileSchemaIfNeeded = (schema) => schema === Schemas.untitled ? [Schemas.file] : [schema];
			} catch (e) {
				console.warn('[code-server-go] Failed to patch FileDialogService:', e);
			}
		});
		return instantiationService;
	}
}

class PureGoBrowserMain extends BrowserMain {
	constructor(domElement, configuration, workspaceRootPath) {
		super(domElement, configuration);
		this.workspaceRootPath = workspaceRootPath;
	}

	createWorkbench(domElement, serviceCollection, logService) {
		const fileService = serviceCollection.get(IFileService);
		fileService.registerProvider(WORKSPACE_SCHEME, new HostFileSystemProvider());
		return new PureGoWorkbench(domElement, undefined, serviceCollection, logService, this.workspaceRootPath);
	}
}

function normalizeWorkspacePath(pathname) {
	if (!pathname || pathname === '/') {
		return '/';
	}
	return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function toFileStat(entry) {
	return {
		type: entry.isDir ? FileType.Directory : FileType.File,
		ctime: entry.ctime ?? 0,
		mtime: entry.mtime ?? 0,
		size: entry.size ?? 0
	};
}

function firstDefinedPath(...values) {
	for (const value of values) {
		if (!value) continue;
		if (typeof value === 'string') return value;
		if (typeof value.path === 'string') return value.path;
	}
	return undefined;
}

function buildURL(route, query) {
	const url = new URL(route, mainWindow.location.origin);
	if (query) {
		for (const [key, value] of Object.entries(query)) {
			if (value !== undefined && value !== null && value !== '') {
				url.searchParams.set(key, String(value));
			}
		}
	}
	return url;
}

async function request(route, query, init) {
	const response = await fetch(buildURL(route, query), init);
	if (!response.ok) {
		throw await toProviderError(response);
	}
	return response;
}

async function requestJSON(route, query, init) {
	const response = await request(route, query, init);
	return response.json();
}

async function toProviderError(response) {
	let message = response.statusText || 'request failed';
	try {
		const payload = await response.json();
		if (payload?.error) {
			message = payload.error;
		}
	} catch {}

	let code = FileSystemProviderErrorCode.Unknown;
	switch (response.status) {
		case 403: code = FileSystemProviderErrorCode.NoPermissions; break;
		case 404: code = FileSystemProviderErrorCode.FileNotFound; break;
		case 409: code = FileSystemProviderErrorCode.FileExists; break;
	}
	return createFileSystemProviderError(message, code);
}

(function () {
	const configElement = mainWindow.document.getElementById('vscode-workbench-web-configuration');
	const raw = configElement?.getAttribute('data-settings');
	if (!raw) {
		throw new Error('Missing web configuration element');
	}

	const config = JSON.parse(raw);
	const folderUri = URI.revive(config.folderUri);
	const workspaceProvider = {
		workspace: { folderUri },
		payload: Object.create(null),
		trusted: true,
		async open(workspace) {
			const target = workspace?.folderUri;
			if (target && target.scheme === WORKSPACE_SCHEME) {
				const url = new URL('/', mainWindow.location.origin);
				url.searchParams.set('folder', target.path);
				mainWindow.location.assign(url.toString());
			}
			return true;
		}
	};

	// VS Code expects UriComponents pointing at unpacked extension directories;
	// the server advertises .vsix paths for validation, so map them here.
	const builtinExtensions = (config.additionalBuiltinExtensions ?? []).map(ext => ({
		scheme: mainWindow.location.protocol.replace(':', ''),
		authority: mainWindow.location.host,
		path: ext.path.replace(/\.vsix$/, '')
	}));

	new PureGoBrowserMain(mainWindow.document.body, {
		...config,
		additionalBuiltinExtensions: builtinExtensions,
		settingsSyncOptions: config.settingsSyncOptions ? { enabled: config.settingsSyncOptions.enabled } : undefined,
		workspaceProvider
	}, folderUri.path).open();
})();
