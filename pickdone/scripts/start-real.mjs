// start:real wrapper — deliberate-friction entry to the REAL user database (%APPDATA%\pickdone).
// The dev default (npm start / dev / app:dev) isolates via scripts/app-dev.mjs; this is the only
// path that boots Electron against real user data, so it prints a warning + 3s abortable
// countdown instead of being a zero-cost misfire (2026-09-25 isolation-gate wave).
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

console.warn('[start:real] WARNING: this launches the App against your REAL user database');
console.warn('[start:real]   (%APPDATA%\\pickdone) — NOT an isolated dev instance.');
console.warn('[start:real] For development/testing use: npm start (isolated to .dev-data).');
console.warn('[start:real] Starting in 3 seconds — Ctrl+C to abort...');
for (let i = 3; i >= 1; i--) {
  console.warn(`[start:real]   ${i}...`);
  await sleep(1000);
}

// Renderer must be built first (same contract as the previous inline start:real script)
const { status: buildStatus } = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:renderer'], { cwd: appRoot, stdio: 'inherit' });
if (buildStatus !== 0) { console.error('[start:real] vite build failed'); process.exit(buildStatus ?? 1); }

const electron = process.platform === 'win32' ? 'electron.cmd' : 'electron';
const child = spawn(electron, ['.'], { cwd: appRoot, stdio: 'inherit', shell: process.platform === 'win32' });
child.on('exit', (code) => process.exit(code ?? 0));
