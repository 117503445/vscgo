import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

async function loadPlaywright() {
	try {
		return await import('playwright');
	} catch (error) {
		const vscodeRoot = process.env.VSCODE_REPO_ROOT;
		if (!vscodeRoot) {
			throw error;
		}
		const candidate = path.join(vscodeRoot, 'node_modules', 'playwright', 'index.mjs');
		if (!fs.existsSync(candidate)) {
			throw error;
		}
		return import(pathToFileURL(candidate).href);
	}
}

function arg(name) {
	const index = process.argv.indexOf(name);
	if (index === -1 || index + 1 >= process.argv.length) {
		throw new Error(`missing argument ${name}`);
	}
	return process.argv[index + 1];
}

function chromiumPath() {
	for (const candidate of ['/usr/bin/chromium', '/usr/bin/chromium-browser', process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH]) {
		if (candidate && fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function shortcut(key) {
	return `${process.platform === 'darwin' ? 'Meta' : 'Control'}+${key}`;
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function waitFor(check, timeoutMs, message) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error(message);
}

async function shot(page, outputDir, screenshots, name) {
	const file = path.join(outputDir, `${name}.png`);
	await page.screenshot({ path: file, fullPage: true });
	screenshots.push(file);
}

async function dismissOnboarding(page, appearTimeoutMs = 0) {
	if (appearTimeoutMs > 0) {
		// The onboarding dialog can appear several seconds after the workbench
		// renders, so give it a chance to show up before deciding it is absent.
		await page.locator('.onboarding-a-overlay.visible').waitFor({ state: 'visible', timeout: appearTimeoutMs }).catch(() => {});
	}
	const skip = page.getByRole('button', { name: 'Skip' });
	if (await skip.isVisible().catch(() => false)) {
		await skip.click({ force: true });
		await page.waitForFunction(() => !document.querySelector('.onboarding-a-overlay.visible'), null, { timeout: 10000 }).catch(() => {});
	}
}

async function runCommandPalette(page, commandLabel) {
	await page.keyboard.press('F1');
	const input = page.locator('.quick-input-widget input[aria-label]').last();
	await input.waitFor({ state: 'visible', timeout: 10000 });
	await input.fill(`>${commandLabel}`);
	await page.waitForTimeout(1000);
	await page.waitForFunction(
		expected => Array.from(document.querySelectorAll('.quick-input-list .monaco-list-row')).some(node => node.textContent?.includes(expected)),
		commandLabel,
		{ timeout: 10000 }
	);
	await page.keyboard.press('Enter');
}

async function openExplorerFile(page, fileName) {
	const selector = `[role="treeitem"][aria-label="${fileName.replaceAll('"', '\\"')}"]`;
	await page.locator(selector).evaluate(node => {
		for (const type of ['mousedown', 'mouseup', 'click']) {
			node.dispatchEvent(new MouseEvent(type, { bubbles: true, detail: type === 'click' ? 1 : 0 }));
		}
	});
}

// ─── Scenario: local-dev-flow ─────────────────────────────────────────────

async function runLocalDevFlow({ page, url, outputDir, workspaceFile }) {
	const workspaceFileName = path.basename(workspaceFile);
	const screenshots = [];
	const observations = [];
	const websocketUrls = [];
	const terminalWebsocketUrls = [];
	const relevantConsoleErrors = [];
	const allConsoleErrors = [];
	const expectedFileContent = 'edited in browser e2e\n';
	const terminalFile = path.join(path.dirname(workspaceFile), 'terminal-output.txt');
	const terminalCommand = `echo terminal-ok > ${terminalFile}`;

	fs.rmSync(terminalFile, { force: true });

	page.on('websocket', ws => {
		websocketUrls.push(ws.url());
		if (ws.url().includes('/ws/terminal')) {
			terminalWebsocketUrls.push(ws.url());
		}
	});
	page.on('console', message => {
		if (message.type() !== 'error') {
			return;
		}
		const text = message.text();
		allConsoleErrors.push(text);
		if (/1006|No file system provider|remote filesystem provider|No terminal backend registered|\/oss-dev/i.test(text)) {
			relevantConsoleErrors.push(text);
		}
	});

	await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
	await waitFor(async () => {
		if ((await page.locator('.monaco-workbench').count()) > 0) {
			return true;
		}
		return (await page.title().catch(() => '')).includes('Code - OSS');
	}, 60000, 'workbench did not render');
	await dismissOnboarding(page, 12000);
	await page.waitForFunction(() => document.title.includes('Code - OSS'), null, { timeout: 60000 });
	observations.push('Official VS Code workbench rendered');
	await shot(page, outputDir, screenshots, '01-workbench');

	const workbenchConfig = await page.evaluate(() => {
		const meta = document.getElementById('vscode-workbench-web-configuration');
		if (!meta) {
			throw new Error('missing workbench configuration meta');
		}
		return JSON.parse(meta.dataset.settings ?? '{}');
	});
	if (workbenchConfig.remoteAuthority) {
		throw new Error(`remoteAuthority should be empty in pure-go mode, got: ${workbenchConfig.remoteAuthority}`);
	}
	if (workbenchConfig.folderUri?.scheme !== 'code-server') {
		throw new Error(`unexpected folderUri scheme: ${workbenchConfig.folderUri?.scheme}`);
	}
	observations.push('Workbench bootstrap uses pure-go code-server workspace configuration');

	const fileTreeItem = page.getByRole('treeitem', { name: new RegExp(escapeRegExp(workspaceFileName)) });
	await fileTreeItem.waitFor({ state: 'visible', timeout: 30000 });
	observations.push(`Explorer shows workspace file "${workspaceFileName}"`);

	await page.waitForTimeout(5000);
	if (websocketUrls.some(entry => entry.includes('/oss-dev'))) {
		throw new Error('unexpected /oss-dev websocket attempt in pure-go mode');
	}
	observations.push('No /oss-dev websocket attempt was made');

	if (relevantConsoleErrors.length > 0) {
		throw new Error(relevantConsoleErrors[0]);
	}

	await openExplorerFile(page, workspaceFileName);
	await page.waitForFunction(
		expected => document.body.innerText.includes(expected),
		workspaceFileName,
		{ timeout: 30000 }
	);
	await page.waitForFunction(() => document.querySelectorAll('.editor-instance .monaco-editor textarea').length > 0, null, { timeout: 30000 });

	const editorInput = page.locator('.editor-instance .monaco-editor textarea').first();
	await editorInput.waitFor({ state: 'attached', timeout: 30000 });
	await editorInput.click({ force: true });
	await page.keyboard.press(shortcut('A'));
	await page.keyboard.type(expectedFileContent);
	await page.keyboard.press(shortcut('S'));
	await waitFor(
		async () => fs.existsSync(workspaceFile) && fs.readFileSync(workspaceFile, 'utf8') === expectedFileContent,
		30000,
		'edited file content was not saved to disk'
	);
	observations.push('Browser edited and saved the workspace file');
	await shot(page, outputDir, screenshots, '02-editor');

	await editorInput.click({ force: true });
	await page.waitForTimeout(250);
	await runCommandPalette(page, 'Terminal: Create New Terminal');
	await page.waitForFunction(
		() => document.querySelectorAll('.terminal-wrapper').length > 0,
		null,
		{ timeout: 30000 }
	);
	const terminalInput = page.locator('.terminal-wrapper .xterm-helper-textarea').last();
	await terminalInput.waitFor({ state: 'attached', timeout: 30000 });
	await terminalInput.focus();
	await terminalInput.type(terminalCommand);
	await terminalInput.press('Enter');
	await waitFor(
		async () => fs.existsSync(terminalFile) && fs.readFileSync(terminalFile, 'utf8').trim() === 'terminal-ok',
		30000,
		'terminal command did not produce the expected file'
	);
	observations.push('Browser created a terminal and executed a command in the workspace');
	if (terminalWebsocketUrls.length === 0) {
		throw new Error('terminal websocket was never opened');
	}
	observations.push('Detected pure-go terminal websocket traffic');
	await shot(page, outputDir, screenshots, '03-terminal');

	if (allConsoleErrors.length > 0) {
		observations.push(`Ignored non-blocking console errors: ${allConsoleErrors.length}`);
	}

	return { status: 'passed', observations, screenshots };
}

// ─── Scenario: open-folder ──────────────────────────────────────────────────
//
// Asserts the built-in VS Code SimpleFileDialog experience (same as
// code-server): title "Open Folder", a path input pre-filled with an absolute
// path, a directory-only listing, ".." navigation, click-to-enter directories,
// no "Show Local" button, and accept -> reload into the chosen folder.

async function runOpenFolder({ page, url, outputDir, workspaceFile }) {
	const observations = [];
	const screenshots = [];
	const workspaceDir = path.dirname(workspaceFile);
	const workspaceDirName = path.basename(workspaceDir);

	const widgetSelector = '.quick-input-widget';
	const inputSelector = '.quick-input-widget input';
	const rowSelector = '.quick-input-widget .quick-input-list .monaco-list-row';

	async function widgetInputValue() {
		return page.evaluate(sel => document.querySelector(sel)?.value ?? '', inputSelector);
	}
	function rowLabelOf(row) {
		return row.querySelector('.label-name')?.textContent?.trim() ?? '';
	}
	async function waitForRow(name, timeoutMs = 15000) {
		await page.waitForFunction(
			({ sel, expected }) => Array.from(document.querySelectorAll(sel)).some(row => (row.querySelector('.label-name')?.textContent?.trim() ?? '') === expected),
			{ sel: rowSelector, expected: name },
			{ timeout: timeoutMs }
		);
	}
	async function clickRow(name) {
		await waitForRow(name);
		await page.evaluate(({ sel, expected }) => {
			const row = Array.from(document.querySelectorAll(sel)).find(node => (node.querySelector('.label-name')?.textContent?.trim() ?? '') === expected);
			if (!row) throw new Error(`row not found: ${expected}`);
			for (const type of ['mousedown', 'mouseup', 'click']) {
				row.dispatchEvent(new MouseEvent(type, { bubbles: true, detail: type === 'click' ? 1 : 0 }));
			}
		}, { sel: rowSelector, expected: name });
	}

	await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
	await waitFor(async () => {
		if ((await page.locator('.monaco-workbench').count()) > 0) {
			return true;
		}
		return (await page.title().catch(() => '')).includes('Code - OSS');
	}, 60000, 'workbench did not render');
	await dismissOnboarding(page, 12000);
	await page.waitForTimeout(3000);
	observations.push('Workbench rendered for Open Folder test');
	await shot(page, outputDir, screenshots, '01-workbench');

	await runCommandPalette(page, 'File: Open Folder');

	await page.waitForFunction(
		sel => /Open Folder/i.test(document.querySelector(`${sel} .quick-input-title`)?.textContent ?? ''),
		widgetSelector,
		{ timeout: 20000 }
	);
	observations.push('Dialog title is "Open Folder"');

	await page.waitForFunction(sel => (document.querySelector(sel)?.value ?? '').startsWith('/'), inputSelector, { timeout: 15000 });
	const initialPath = await widgetInputValue();
	observations.push(`Path input pre-filled with absolute path: ${initialPath}`);

	const widgetText = await page.evaluate(sel => document.querySelector(sel)?.textContent ?? '', widgetSelector);
	if (/show local/i.test(widgetText)) {
		throw new Error('SimpleFileDialog shows a "Show Local" button, diverging from code-server UX');
	}
	observations.push('No "Show Local" button in the dialog');

	await page.waitForFunction(sel => document.querySelectorAll(sel).length > 0, rowSelector, { timeout: 15000 });
	observations.push('Directory listing rendered');
	await shot(page, outputDir, screenshots, '02-dialog-initial');

	// The initial directory depends on history, so type the absolute workspace
	// path (code-server supports typing paths) to reach a known listing.
	const typedPath = `${workspaceDir}/`;
	await page.locator(inputSelector).fill(typedPath);
	await waitForRow('subdir');
	await waitForRow('..');
	const typedValue = await widgetInputValue();
	if (!typedValue.endsWith(`/${workspaceDirName}/`)) {
		throw new Error(`input did not stay at typed path: ${typedValue}`);
	}
	observations.push(`Typed path ${typedPath}; listing shows subdir and ".."`);

	await clickRow('..');
	await waitForRow(workspaceDirName);
	const parentValue = await widgetInputValue();
	if (!parentValue.endsWith(`/${path.basename(path.dirname(workspaceDir))}/`)) {
		throw new Error(`".." did not navigate to parent: ${parentValue}`);
	}
	observations.push('".." navigated up to the parent directory');

	await clickRow(workspaceDirName);
	await waitForRow('subdir');
	const backValue = await widgetInputValue();
	if (backValue !== typedValue) {
		throw new Error(`re-entering ${workspaceDirName} changed path: ${backValue}`);
	}
	observations.push(`Click navigated back into ${backValue}`);

	await clickRow('subdir');
	const subdirValue = await widgetInputValue();
	if (!subdirValue.endsWith('/subdir/')) {
		throw new Error(`input did not navigate into subdir: ${subdirValue}`);
	}
	observations.push(`Navigated into ${subdirValue}`);
	await shot(page, outputDir, screenshots, '03-dialog-subdir');

	const navigation = page.waitForURL(u => new URL(u).searchParams.has('folder'), { timeout: 60000 });
	await page.locator(inputSelector).press('Enter');
	await navigation;
	const folderParam = new URL(page.url()).searchParams.get('folder') ?? '';
	if (!folderParam.endsWith(path.join(workspaceDirName, 'subdir'))) {
		throw new Error(`unexpected folder param after accept: ${folderParam}`);
	}
	observations.push(`Accept opened ?folder=${folderParam}`);

	await waitFor(async () => (await page.locator('.monaco-workbench').count()) > 0, 60000, 'workbench did not reload into the new folder');
	await dismissOnboarding(page);
	const nestedItem = page.getByRole('treeitem', { name: /nested\.txt/ });
	await nestedItem.waitFor({ state: 'visible', timeout: 30000 });
	observations.push('Explorer shows subdir file "nested.txt" after folder switch');
	await shot(page, outputDir, screenshots, '04-opened');

	return { status: 'passed', observations, screenshots };
}


// ─── Scenario: builtin-extensions ───────────────────────────────────────────

async function runBuiltinExtensions({ page, url, outputDir, workspaceFile }) {
	const observations = [];
	const screenshots = [];

	await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
	await waitFor(async () => {
		if ((await page.locator('.monaco-workbench').count()) > 0) {
			return true;
		}
		return (await page.title().catch(() => '')).includes('Code - OSS');
	}, 60000, 'workbench did not render');
	await dismissOnboarding(page, 12000);
	await page.waitForTimeout(3000);
	observations.push('Workbench rendered for builtin-extensions test');
	await shot(page, outputDir, screenshots, '01-workbench');

	// Read the builtin extensions from the workbench configuration
	// (the vscode-workbench-builtin-extensions meta may be consumed by VS Code at boot)
	const builtinExtensions = await page.evaluate(() => {
		const configMeta = document.getElementById('vscode-workbench-web-configuration');
		if (!configMeta) {
			throw new Error('missing workbench configuration meta');
		}
		const config = JSON.parse(configMeta.dataset.settings ?? '{}');
		return config.additionalBuiltinExtensions || [];
	});

	observations.push('Builtin extensions count: ' + builtinExtensions.length);

	// Verify required extensions are present
	const requiredExtensions = [
		'pkief.material-icon-theme',
		'mechatroner.rainbow-csv',
		'iliazeus.vscode-ansi',
		'njzy.stats-bar',
		'tomoki1207.pdf',
		'humao.rest-client',
		'mhutchie.git-graph',
	];

	for (const extName of requiredExtensions) {
		const found = builtinExtensions.some(ext => ext.name === extName);
		if (found) {
			observations.push('Extension registered: ' + extName);
		} else {
			throw new Error('Missing builtin extension: ' + extName);
		}
	}

	// Verify each VSIX file is accessible (non-empty)
	for (const ext of builtinExtensions) {
		const vsixUrl = new URL(ext.path, url).href;
		const response = await fetch(vsixUrl);
		if (!response.ok) {
			throw new Error('VSIX not accessible: ' + ext.path + ' (HTTP ' + response.status + ')');
		}
		const body = await response.arrayBuffer();
		if (body.byteLength < 1024) {
			throw new Error('VSIX too small: ' + ext.path + ' (' + body.byteLength + ' bytes)');
		}
		observations.push('VSIX served: ' + ext.path + ' (' + body.byteLength + ' bytes)');
	}

	// Material icon theme must be the DEFAULT file icon theme on a fresh
	// profile (no manual selection), so icons are material on first visit.
	const workspaceFileName = path.basename(workspaceFile);
	const fileTreeItem = page.getByRole('treeitem', { name: new RegExp(escapeRegExp(workspaceFileName)) });
	await fileTreeItem.waitFor({ state: 'visible', timeout: 30000 });

	async function explorerUsesMaterialIcons() {
		return page.evaluate(() => {
			for (const label of Array.from(document.querySelectorAll('.explorer-folders-view .monaco-icon-label'))) {
				const bg = getComputedStyle(label, '::before').backgroundImage;
				if (bg.includes('pkief.material-icon-theme')) {
					return true;
				}
			}
			return false;
		});
	}

	await waitFor(explorerUsesMaterialIcons, 20000, 'default file icon theme is not material-icon-theme on fresh load');
	observations.push('Material icon theme is the default file icon theme');
	await shot(page, outputDir, screenshots, '02-material-default');

	await runCommandPalette(page, 'Preferences: File Icon Theme');
	const themeInput = page.locator('.quick-input-widget input').first();
	await themeInput.waitFor({ state: 'visible', timeout: 10000 });
	await themeInput.fill('Material Icon Theme');
	await page.waitForFunction(
		() => Array.from(document.querySelectorAll('.quick-input-list .monaco-list-row')).some(node => node.textContent?.includes('Material Icon Theme')),
		null,
		{ timeout: 15000 }
	);
	observations.push('File Icon Theme picker lists "Material Icon Theme"');
	await page.keyboard.press('Enter');
	observations.push('Selected "Material Icon Theme"');

	await waitFor(async () => {
		return explorerUsesMaterialIcons();
	}, 20000, 'explorer icons did not switch to material-icon-theme');
	observations.push('Explorer icons render from pkief.material-icon-theme resources');

	await shot(page, outputDir, screenshots, '02-material-icons');

	return { status: 'passed', observations, screenshots };
}

// ─── Scenario: syntax-highlight ─────────────────────────────────────────────
//
// Opens Go/Python/JSON files and asserts TextMate tokenization is active:
// tokens in the editor must render in at least two distinct colors, which only
// happens when the builtin grammar extensions are registered and a theme with
// token colors (theme-defaults) applies.

async function runSyntaxHighlight({ page, url, outputDir, workspaceFile }) {
	const observations = [];
	const screenshots = [];

	await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
	await waitFor(async () => {
		if ((await page.locator('.monaco-workbench').count()) > 0) {
			return true;
		}
		return (await page.title().catch(() => '')).includes('Code - OSS');
	}, 60000, 'workbench did not render');
	await dismissOnboarding(page, 12000);
	await page.waitForTimeout(3000);
	observations.push('Workbench rendered for syntax-highlight test');

	const cases = [
		{ file: 'main.go', marker: 'package main', minClasses: 4 },
		{ file: 'main.py', marker: 'def main', minClasses: 4 },
		{ file: 'config.json', marker: '"name"', minClasses: 3 },
	];

	for (const c of cases) {
		const item = page.getByRole('treeitem', { name: new RegExp(escapeRegExp(c.file)) });
		await item.waitFor({ state: 'visible', timeout: 30000 });
		await openExplorerFile(page, c.file);
		await page.waitForFunction(
			// Monaco renders some spaces as U+00A0 in view-lines; normalize first.
			expected => (document.querySelector('.editor-instance .view-lines')?.textContent?.replace(/\u00a0/g, ' ').includes(expected)) ?? false,
			c.marker,
			{ timeout: 30000 }
		);
		observations.push(`Editor opened ${c.file}`);

		// Distinct mtkN classes prove TextMate tokenization; without a grammar
		// every token is mtk1. Bracket-pair colors would fake a color-based
		// assertion, so count token type classes instead.
		let distinctClasses = 0;
		await waitFor(async () => {
			distinctClasses = await page.evaluate(() => {
				const classes = new Set();
				for (const span of document.querySelectorAll('.editor-instance .view-line span[class*="mtk"]')) {
					for (const cls of span.classList) {
						if (/^mtk\d+$/.test(cls)) {
							classes.add(cls);
						}
					}
				}
				return classes.size;
			});
			return distinctClasses >= c.minClasses;
		}, 30000, `${c.file}: expected at least ${c.minClasses} distinct mtk token classes, got ${distinctClasses} (grammar not active?)`);
		observations.push(`${c.file} renders with ${distinctClasses} distinct token classes`);
	}
	await shot(page, outputDir, screenshots, '02-syntax-highlight');

	return { status: 'passed', observations, screenshots };
}

// ─── Scenario registry ──────────────────────────────────────────────────────

const scenarios = {
	'local-dev-flow': runLocalDevFlow,
	'open-folder': runOpenFolder,
	'builtin-extensions': runBuiltinExtensions,
	'syntax-highlight': runSyntaxHighlight,
};

// ─── Main ───────────────────────────────────────────────────────────────────

const url = arg('--url');
const scenario = arg('--scenario');
const outputDir = arg('--output-dir');
const workspaceFile = arg('--workspace-file');

const runScenario = scenarios[scenario];
if (!runScenario) {
	const result = { scenario, status: 'failed', url, screenshots: [], observations: ['Unknown scenario: ' + scenario] };
	console.log(JSON.stringify(result));
	process.exit(1);
}

const { chromium } = await loadPlaywright();
const chromiumArgs = ['--disable-dev-shm-usage'];
if (typeof process.getuid === 'function' && process.getuid() === 0) {
	chromiumArgs.push('--no-sandbox', '--disable-setuid-sandbox');
}

let browser;
try {
	browser = await chromium.launch({ headless: true, executablePath: chromiumPath(), args: chromiumArgs });

	await waitFor(async () => {
		try {
			const health = await fetch(new URL('/healthz', url));
			return health.ok;
		} catch { return false; }
	}, 30000, 'healthz did not become ready');

	const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

	let result;
	try {
		result = await runScenario({ page, url, outputDir, workspaceFile });
	} catch (error) {
		const observations = [String(error)];
		try {
			observations.push('URL at failure: ' + page.url());
			const widgetState = await page.evaluate(() => {
				const w = document.querySelector('.quick-input-widget');
				if (!w) return null;
				return {
					title: w.querySelector('.quick-input-title')?.textContent ?? null,
					input: w.querySelector('input')?.value ?? null,
					rows: Array.from(w.querySelectorAll('.monaco-list-row')).map(r => r.textContent?.trim()).slice(0, 15),
				};
			});
			if (widgetState) {
				observations.push('QuickInput at failure: ' + JSON.stringify(widgetState));
			}
			const file = path.join(outputDir, 'failure.png');
			await page.screenshot({ path: file, fullPage: true });
			result = { status: 'failed', observations, screenshots: [file] };
		} catch {
			result = { status: 'failed', observations, screenshots: [] };
		}
	}
	await page.close();

	const finalResult = {
		scenario,
		status: result.status,
		url,
		screenshots: result.screenshots || [],
		observations: result.observations || [],
	};
	console.log(JSON.stringify(finalResult));
	process.exitCode = finalResult.status === 'passed' ? 0 : 1;
} catch (error) {
	console.log(JSON.stringify({ scenario, status: 'failed', url, screenshots: [], observations: [String(error)] }));
	process.exitCode = 1;
} finally {
	if (browser) await browser.close();
}
