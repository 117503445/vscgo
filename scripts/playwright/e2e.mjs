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

async function dismissOnboarding(page) {
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

const url = arg('--url');
const scenario = arg('--scenario');
const outputDir = arg('--output-dir');
const workspaceFile = arg('--workspace-file');
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
const { chromium } = await loadPlaywright();
const chromiumArgs = ['--disable-dev-shm-usage'];
if (typeof process.getuid === 'function' && process.getuid() === 0) {
	chromiumArgs.push('--no-sandbox', '--disable-setuid-sandbox');
}

fs.rmSync(terminalFile, { force: true });

let browser;

try {
	browser = await chromium.launch({ headless: true, executablePath: chromiumPath(), args: chromiumArgs });

	await waitFor(async () => {
		try {
			const health = await fetch(new URL('/healthz', url));
			return health.ok;
		} catch {
			return false;
		}
	}, 30000, 'healthz did not become ready');

	const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
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
	await dismissOnboarding(page);
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

	await page.close();
	console.log(JSON.stringify({ scenario, status: 'passed', url, screenshots, observations }));
} catch (error) {
	observations.push(String(error));
	console.log(JSON.stringify({ scenario, status: 'failed', url, screenshots, observations }));
	process.exitCode = 1;
} finally {
	if (browser) {
		await browser.close();
	}
}
