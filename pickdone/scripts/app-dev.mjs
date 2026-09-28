// 开发实例启动包装：注入 TODO_USER_DATA_DIR 隔离数据目录，避免开发/冒烟直连真实用户库。
// 用法：npm run app:dev / npm start / npm run dev（等价于 node scripts/app-dev.mjs，可透传额外参数给 electron .）
// 直连真实用户库须显式 npm run start:real（裸 electron .）——2026-09-02 环境隔离定稿：开发默认不碰真实数据
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDistFresh } from './dist-freshness.mjs'

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const devDataDir = process.env.TODO_USER_DATA_DIR || path.join(appRoot, '.dev-data');

fs.mkdirSync(devDataDir, { recursive: true });

const electron = process.platform === 'win32' ? 'electron.cmd' : 'electron';
const extraArgs = process.argv.slice(2); // 例如 --dev、--remote-debugging-port=9333

// 渲染层先构建(SFC/TS → renderer-dist 产物);app:// 运行时只吃 dist。
// 新鲜度跳过:产物 index.html 比全部源都新时跳过构建,日常启动省 ~4s。指纹清单(与进 dist 的
// 源集同步,漏一项就会静默吃旧产物):renderer/js + renderer/index.html + vite.config.mjs
// (2026-09-05 终审 P1)+ shared/** 与 assets/**(2026-09-28:两者此前漏算,改 shared 后 dev 仍吃旧构建)
const distFresh = isDistFresh(appRoot)
if (process.argv.includes('--no-build') || distFresh) {
  console.log('[app-dev] renderer-dist 已是最新,跳过 vite build')
} else {
  const { status: buildStatus } = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:renderer'], { cwd: appRoot, stdio: 'inherit' })
  if (buildStatus !== 0) { console.error('[app-dev] vite build failed'); process.exit(buildStatus ?? 1) }
}

const child = spawn(electron, ['.', ...extraArgs], {
  cwd: appRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, TODO_USER_DATA_DIR: devDataDir },
});

child.on('exit', (code) => process.exit(code ?? 0));
