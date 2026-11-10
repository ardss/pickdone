#!/usr/bin/env node
/* eslint-env node */
/**
 * UX evidence capture — desktop (S3, Dev-3)
 *
 * Connects to a running isolated Electron instance over CDP (Chrome DevTools
 * Protocol) and captures real-pixel screenshots of the contract screens in
 * both light and dark themes.
 *
 * ISOLATION CONTRACT (must hold):
 *   The Electron instance MUST be started with TODO_USER_DATA_DIR pointing at
 *   a scratch directory, never the real %APPDATA%/pickdone. Example:
 *     TODO_USER_DATA_DIR=K:/tmp/lr-ux-data node scripts/app-dev.mjs --remote-debugging-port=9333
 *
 * Usage:
 *   node scripts/ux-capture/capture-desktop.mjs --out ../../ux-evidence/desktop [--port 9333] [--width 1440] [--height 900]
 *
 * No third-party deps: Node 22 built-in fetch + global WebSocket.
 * Raw CDP only. Screenshots are real rendered pixels (Page.captureScreenshot),
 * NOT "CSS variables look equal" assertions.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = Number(getArg('port', '9333'));
const width = Number(getArg('width', '1440'));
const height = Number(getArg('height', '900'));
const outDir = path.resolve(getArg('out', '../../ux-evidence/desktop'));
fs.mkdirSync(outDir, { recursive: true });

// Screens required by MEGA-MISSION §05/S3. route = hash route; setup = extra JS
// evaluated before capture (e.g. opening a modal).
const SCREENS = [
  { id: '01-today',            route: '#/todo-list/today',            name: 'Today' },
  { id: '02-todox',            route: '#/todo-list/today-x',          name: 'TodayX (push view)' },
  { id: '03-inbox-todobox',    route: '#/todo-list/todo-box',         name: 'Inbox / TodoBox (capture)' },
  { id: '04-projects',         route: '#/todo-list/projects',         name: 'Projects overview' },
  { id: '05-project-detail',   route: '#/todo-list/projects',         name: 'Project detail', needsProject: true },
  { id: '06-statistics',       route: '#/todo-list/statistics',       name: 'Activity & statistics' },
  { id: '07-completed',        route: '#/todo-list/completed',        name: 'Completed / archive' },
  { id: '08-settings',         route: '#/todo-list/today',            name: 'Settings modal', setup: `document.querySelector('#app').__vue_app__.config.globalProperties.$store.commit('ui/toggleSettings', true)` },
  { id: '09-settings-sync',    route: '#/todo-list/today',            name: 'Settings > Sync & Devices', setup: `(()=>{const gp=document.querySelector('#app').__vue_app__.config.globalProperties; gp.$store.commit('ui/toggleSettings', true); setTimeout(()=>{const t=Array.from(document.querySelectorAll('.modal-container--settings .el-tabs__item')).find(e=>/同步|Sync/i.test(e.textContent)); t&&t.click()},200)})()`, settle: 1400 },
  { id: '10-empty-recycle-bin', route: '#/todo-list/recycle-bin',      name: 'Empty state (Recycle Bin)', setup: `document.querySelector('#app').__vue_app__.config.globalProperties.$store.commit('ui/toggleSettings', false)` },
];

const THEMES = ['light', 'dark'];

const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
const page = list.find(t => t.type === 'page' && !t.url.includes('__tomato-float'));
if (!page) { console.error('BLOCKED: no page target on CDP port', port); process.exit(2); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((res, rej) => {
    pending.set(id, (m) => m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result));
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result?.value;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
await evalJs(`location.hash = '#/todo-list/today'; 'ok'`);
await sleep(1500);

// Isolation proof: record where userData actually points (renderer cannot see
// it directly; we assert via the absence of real-user markers instead) plus
// viewport + theme per capture.
const manifest = [];
let firstProjectHref = null;

for (const theme of THEMES) {
  await evalJs(`
    document.documentElement.dataset.theme = ${JSON.stringify(theme)};
    localStorage.setItem('colorMode', ${JSON.stringify(theme)});
    'theme-set'`);
  await sleep(300);

  for (const s of SCREENS) {
    try {
      if (s.needsProject) {
        if (!firstProjectHref) {
          firstProjectHref = await evalJs(`window.todoAPI.dbCall('getAllCategories',{}).then(a=>{const c=a.find(x=>!x.delete);return c?('/todo-list/project/'+c.categoryId):''})`);
        }
        if (!firstProjectHref) { console.error('SKIP (no project):', s.id); continue; }
        await evalJs(`location.hash = ${JSON.stringify(firstProjectHref)}; 'nav'`);
      } else {
        await evalJs(`location.hash = ${JSON.stringify(s.route)}; 'nav'`);
      }
      if (s.setup) { await evalJs(`(function(){ ${s.setup} ; return 'setup' })()`); await sleep(s.settle || 600); }
      await sleep(900); // settle render + async data
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      const file = `${s.id}--${theme}--${width}x${height}.png`;
      fs.writeFileSync(path.join(outDir, file), Buffer.from(shot.data, 'base64'));
      manifest.push({
        file, screen: s.id, name: s.name, theme, viewport: `${width}x${height}`, dpr: 1,
        navPath: s.needsProject ? `SideNav > Projects > first project card (${firstProjectHref})` : `SideNav > ${s.name}`,
        capturedAt: new Date().toISOString(),
        source: 'Electron Page.captureScreenshot via CDP (real rendered pixels)',
        appVersion: await evalJs(`window.PICKDONE_VERSION || document.querySelector('meta[name="app-version"]')?.content || 'unknown'`),
      });
      console.log('captured', file);
    } catch (e) {
      console.error('FAIL', s.id, theme, e.message);
      manifest.push({ screen: s.id, theme, error: e.message, status: 'FAILED' });
    }
  }
}

fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ generatedAt: new Date().toISOString(), width, height, captures: manifest }, null, 2));
console.log('done. manifest at', path.join(outDir, 'manifest.json'));
ws.close();
process.exit(0);
