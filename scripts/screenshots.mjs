// Regenerate docs/screenshots/*.png with a headless Chromium.
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROME_PATH=/path/to/chrome node scripts/screenshots.mjs
// Optional: EVERYTHING_URL=http://localhost:3001/mcp (official "everything" server running), LIVE_URL=<any MCP URL>.
// Starts its own host and the Daybreak Coffee demo; fails on any page error or horizontal overflow.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHost } from '../server/serve.mjs';
import { startDemoServer } from '../examples/daybreak-coffee/server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs/screenshots');

const demo = await startDemoServer();
const host = await startHost({ server: demo.url });
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const q = (o) => new URLSearchParams(Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]]))).toString();

const SHOTS = [
  { name: '01-show15-card', theme: 'light', params: { device: 'show15', say: 'find iced drinks' } },
  { name: '02-lint-one-shot-purchase', theme: 'light', params: { device: 'show15', say: ['reorder my usual', 'yes'], inspector: 'lint' } },
  { name: '03-dot-voice-only', theme: 'dark', params: { device: 'dot', say: ['reorder my usual', 'yes'] } },
  { name: '04-show8-quote-confirm', theme: 'dark', params: { device: 'show8', say: 'order a large oat latte' } },
  { name: '05-traffic-drawer', theme: 'light', params: { device: 'show8', say: 'order a large oat latte', inspector: 'traffic' } },
  { name: '06-phone', theme: 'light', params: { device: 'phone', say: 'find tea' } },
  { name: '07-iphone-layout', theme: 'dark', params: { device: 'phone', say: 'store hours' }, viewport: { width: 390, height: 844 }, mobile: true },
];
if (process.env.EVERYTHING_URL) SHOTS.push({ name: '08-everything-server', theme: 'light', params: { server: process.env.EVERYTHING_URL, device: 'show15', say: 'echo hello from the kitchen', inspector: 'traffic' } });
if (process.env.LIVE_URL) SHOTS.push({ name: '09-live-server', theme: 'light', params: { server: process.env.LIVE_URL, device: 'show15', say: process.env.LIVE_SAY || 'status', inspector: 'lint' } });

let failed = false;
for (const s of SHOTS) {
  const page = await browser.newPage({ viewport: s.viewport || { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: s.theme, isMobile: Boolean(s.mobile), hasTouch: Boolean(s.mobile) });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${host.origin}/?${q({ tts: 'captions', ...s.params })}`);
  await page.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
  await page.waitForTimeout(900);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  await page.screenshot({ path: path.join(OUT, `${s.name}.png`), fullPage: Boolean(s.mobile) });
  const ok = !errors.length && overflow <= 0;
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${s.name}${errors.length ? ' errors: ' + errors.join(' | ') : ''}${overflow > 0 ? ` overflow ${overflow}px` : ''}`);
  await page.close();
}
await browser.close();
await host.close();
await demo.close();
process.exit(failed ? 1 : 0);
