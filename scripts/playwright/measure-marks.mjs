import { chromium } from 'playwright';

const url = process.argv[2];
const browser = await chromium.launch();
const page = await browser.newPage();
const t0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForSelector('.monaco-workbench', { timeout: 120000 });
await page.waitForTimeout(4000);
const wallMs = Date.now() - t0;
const data = await page.evaluate(() => {
	const marks = performance.getEntriesByType('mark').map(m => [m.name, Math.round(m.startTime)]);
	const measures = performance.getEntriesByType('measure')
		.filter(m => m.name.startsWith('code/'))
		.map(m => [m.name, Math.round(m.duration)]);
	const resources = performance.getEntriesByType('resource');
	const jsFiles = resources.filter(r => r.name.endsWith('.js'));
	const jsBytes = jsFiles.reduce((a, r) => a + (r.transferSize || 0), 0);
	return { marks: marks.slice(0, 40), measures, jsCount: jsFiles.length, jsMB: (jsBytes / 1048576).toFixed(1), totalReq: resources.length };
});
console.log(JSON.stringify({ wallMs, ...data }, null, 1));
await browser.close();
