import { mainWindow } from '/static/out/vs/base/browser/window.js';
import { Emitter, Event } from '/static/out/vs/base/common/event.js';
import { URI } from '/static/out/vs/base/common/uri.js';
import { IRemoteAgentHostService, NullRemoteAgentHostService } from '/static/out/vs/platform/agentHost/common/remoteAgentHostService.js';
import { IFileService, FileChangeType, FileSystemProviderCapabilities, FileSystemProviderErrorCode, FileType, createFileSystemProviderError } from '/static/out/vs/platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '/static/out/vs/platform/instantiation/common/extensions.js';
import { Registry } from '/static/out/vs/platform/registry/common/platform.js';
import '/static/out/vs/workbench/workbench.web.main.js';
import { BrowserMain } from '/static/out/vs/workbench/browser/web.main.js';
import { Workbench } from '/static/out/vs/workbench/browser/workbench.js';
import { BasePty } from '/static/out/vs/workbench/contrib/terminal/common/basePty.js';
import { ITerminalInstanceService, ITerminalService } from '/static/out/vs/workbench/contrib/terminal/browser/terminal.js';
import { ProcessPropertyType, TerminalExtensions } from '/static/out/vs/platform/terminal/common/terminal.js';

const WORKSPACE_SCHEME = 'code-server';

performance.mark('code/didLoadWorkbenchMain');
registerSingleton(IRemoteAgentHostService, NullRemoteAgentHostService, InstantiationType.Delayed);

class HostFileSystemProvider {
	constructor(workspaceRootPath) {
		this.workspaceRootPath = normalizeWorkspacePath(workspaceRootPath);
		this.capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive;
		this.onDidChangeCapabilities = Event.None;
		this._onDidChangeFile = new Emitter();
		this.onDidChangeFile = this._onDidChangeFile.event;
	}

	watch() {
		return { dispose() {} };
	}

	async stat(resource) {
		const payload = await requestJSON('/api/fs/stat', { path: this.resourceToRelativePath(resource) });
		return toFileStat(payload);
	}

	async readdir(resource) {
		const payload = await requestJSON('/api/fs/readdir', { path: this.resourceToRelativePath(resource) });
		return payload.entries.map(entry => [entry.name, entry.isDir ? FileType.Directory : FileType.File]);
	}

	async readFile(resource) {
		const response = await request('/api/fs/file', { path: this.resourceToRelativePath(resource) });
		return new Uint8Array(await response.arrayBuffer());
	}

	async writeFile(resource, content) {
		await request('/api/fs/file', { path: this.resourceToRelativePath(resource) }, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/octet-stream' },
			body: content
		});
		this._onDidChangeFile.fire([{ type: FileChangeType.UPDATED, resource }]);
	}

	async mkdir(resource) {
		await request('/api/fs/mkdir', { path: this.resourceToRelativePath(resource) }, { method: 'POST' });
		this._onDidChangeFile.fire([{ type: FileChangeType.ADDED, resource }]);
	}

	async delete(resource) {
		await request('/api/fs/entry', { path: this.resourceToRelativePath(resource) }, { method: 'DELETE' });
		this._onDidChangeFile.fire([{ type: FileChangeType.DELETED, resource }]);
	}

	async rename(from, to) {
		await request('/api/fs/rename', undefined, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				from: this.resourceToRelativePath(from),
				to: this.resourceToRelativePath(to)
			})
		});
		this._onDidChangeFile.fire([
			{ type: FileChangeType.DELETED, resource: from },
			{ type: FileChangeType.ADDED, resource: to }
		]);
	}

	resourceToRelativePath(resource) {
		if (resource.scheme !== WORKSPACE_SCHEME) {
			throw createFileSystemProviderError(`unsupported scheme: ${resource.scheme}`, FileSystemProviderErrorCode.Unavailable);
		}

		const resourcePath = normalizeWorkspacePath(resource.path);
		if (resourcePath === this.workspaceRootPath) {
			return '';
		}
		const prefix = `${this.workspaceRootPath}/`;
		if (!resourcePath.startsWith(prefix)) {
			throw createFileSystemProviderError('resource is outside the workspace', FileSystemProviderErrorCode.NoPermissions);
		}
		return resourcePath.slice(prefix.length);
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

	async attachToProcess() {
		return undefined;
	}

	async attachToRevivedProcess() {
		return undefined;
	}

	async listProcesses() {
		return [];
	}

	async getLatency() {
		return [];
	}

	async getDefaultSystemShell() {
		return '/bin/sh';
	}

	async getProfiles() {
		return [{
			profileName: 'Default Shell',
			path: '/bin/sh',
			isDefault: true
		}];
	}

	async getWslPath(original) {
		return original;
	}

	async getEnvironment() {
		return {};
	}

	async getShellEnvironment() {
		return {};
	}

	async setTerminalLayoutInfo() {}

	async updateTitle() {}

	async updateIcon() {}

	async setNextCommandId() {}

	async getTerminalLayoutInfo() {
		return undefined;
	}

	async getPerformanceMarks() {
		return [];
	}

	async reduceConnectionGraceTime() {}

	async requestDetachInstance() {
		return undefined;
	}

	async acceptDetachInstanceReply() {}

	async persistTerminalState() {}

	async installAutoReply() {}

	async uninstallAllAutoReplies() {}

	restartPtyHost() {}

	async createProcess(shellLaunchConfig, cwd, cols, rows, _unicodeVersion, _env, _options, shouldPersist) {
		return new GoTerminalPty(
			this._nextId++,
			shouldPersist,
			this.resolveCwd(cwd, shellLaunchConfig),
			cols,
			rows
		);
	}

	resolveCwd(cwd, shellLaunchConfig) {
		const candidate = firstDefinedPath(cwd, shellLaunchConfig?.cwd);
		if (!candidate) {
			return { absolute: this.workspaceRootPath, relative: '' };
		}

		const normalized = normalizeWorkspacePath(candidate);
		if (normalized === this.workspaceRootPath) {
			return { absolute: normalized, relative: '' };
		}
		const prefix = `${this.workspaceRootPath}/`;
		if (normalized.startsWith(prefix)) {
			return { absolute: normalized, relative: normalized.slice(prefix.length) };
		}
		return { absolute: this.workspaceRootPath, relative: '' };
	}
}

class GoTerminalPty extends BasePty {
	constructor(id, shouldPersist, cwd, cols, rows) {
		super(id, shouldPersist);
		this.cwd = cwd;
		this.cols = cols;
		this.rows = rows;
		this.socket = undefined;
		this.exited = false;
	}

	async start() {
		const params = new URLSearchParams();
		if (this.cwd.relative) {
			params.set('cwd', this.cwd.relative);
		}
		const protocol = mainWindow.location.protocol === 'https:' ? 'wss:' : 'ws:';
		const query = params.toString();
		const socketURL = `${protocol}//${mainWindow.location.host}/ws/terminal${query ? `?${query}` : ''}`;
		this.socket = new WebSocket(socketURL);

		this.socket.addEventListener('open', () => {
			this.handleDidChangeProperty({ type: ProcessPropertyType.InitialCwd, value: this.cwd.absolute });
			this.handleDidChangeProperty({ type: ProcessPropertyType.Cwd, value: this.cwd.absolute });
			this.handleReady({ pid: this.id, cwd: this.cwd.absolute, windowsPty: undefined });
			this.resize(this.cols, this.rows);
		});

		this.socket.addEventListener('message', event => {
			const message = JSON.parse(typeof event.data === 'string' ? event.data : '');
			switch (message.type) {
				case 'output':
					this.handleData(message.data);
					break;
				case 'error':
					this.handleData(`\r\n[error] ${message.message}\r\n`);
					break;
				case 'exit':
					this.handleExitOnce(undefined);
					break;
			}
		});

		this.socket.addEventListener('close', () => {
			this.handleExitOnce(undefined);
		});

		return undefined;
	}

	shutdown() {
		this.socket?.close();
	}

	input(data) {
		this.send({ type: 'input', data });
	}

	sendSignal(signal) {
		if (signal === 'SIGINT') {
			this.input('\u0003');
		}
	}

	async processBinary() {}

	resize(cols, rows) {
		this.cols = cols;
		this.rows = rows;
		if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) {
			return;
		}
		if (this.socket?.readyState !== WebSocket.OPEN) {
			return;
		}
		if (this._lastDimensions.cols === cols && this._lastDimensions.rows === rows) {
			return;
		}
		this._lastDimensions.cols = cols;
		this._lastDimensions.rows = rows;
		this.send({ type: 'resize', cols, rows });
	}

	clearBuffer() {}

	acknowledgeDataEvent() {}

	async setUnicodeVersion() {}

	async refreshProperty(type) {
		switch (type) {
			case ProcessPropertyType.Cwd:
			case ProcessPropertyType.InitialCwd:
				return this.cwd.absolute;
			default:
				return undefined;
		}
	}

	async updateProperty(type, value) {
		if (type === ProcessPropertyType.Cwd && typeof value === 'string') {
			this.cwd = { absolute: value, relative: '' };
		}
	}

	send(message) {
		if (this.socket?.readyState === WebSocket.OPEN) {
			this.socket.send(JSON.stringify(message));
		}
	}

	handleExitOnce(code) {
		if (this.exited) {
			return;
		}
		this.exited = true;
		this.handleExit(code);
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
		fileService.registerProvider(WORKSPACE_SCHEME, new HostFileSystemProvider(this.workspaceRootPath));
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
		if (!value) {
			continue;
		}
		if (typeof value === 'string') {
			return value;
		}
		if (typeof value.path === 'string') {
			return value.path;
		}
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
		case 403:
			code = FileSystemProviderErrorCode.NoPermissions;
			break;
		case 404:
			code = FileSystemProviderErrorCode.FileNotFound;
			break;
		case 409:
			code = FileSystemProviderErrorCode.FileExists;
			break;
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
		async open() {
			return false;
		}
	};

	new PureGoBrowserMain(mainWindow.document.body, {
		...config,
		settingsSyncOptions: config.settingsSyncOptions ? { enabled: config.settingsSyncOptions.enabled } : undefined,
		workspaceProvider
	}, folderUri.path).open();
})();
