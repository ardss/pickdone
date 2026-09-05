#!/usr/bin/env node
/** 渲染层产物清理(best effort):renderer-dist/assets 是 2026-09-05 K盘坏名目(重启前删不掉),
 *  vite emptyOutDir 对它整体失败 → 改为逐项尽力清理 + 关闭 vite emptyOutDir(vite.config) */
import fs from 'node:fs'
import path from 'node:path'
const dir = path.resolve('renderer-dist')
for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
  if (/^assets(2)?$/.test(name)) continue // 坏名目:留着,重启后清
  fs.rmSync(path.join(dir, name), { recursive: true, force: true })
}
// 兜底:若 assets 可删(重启后),顺手删掉
for (const bad of ['assets', 'assets2']) { try { fs.rmSync(path.join(dir, bad), { recursive: true, force: true }) } catch {} }
