/**
 * CSS/JS 缓存戳统一 bump —— 同步刷新两个宿主 index.html 的全部 ?v= 时间戳
 * (Electron 宿主改完须 build:renderer 才进 dist;Vite hash 资产自带缓存策略,戳只作用于 vendor/css)
 * 背景：手改 10 处漏一处就缓存不一致（曾致改版不生效的假故障）。用法：npm run bump
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = ['renderer/index.html', 'browser-dev/index.html']
const stamp = Date.now()
for (const rel of files) {
  const file = path.join(ROOT, rel)
  if (!fs.existsSync(file)) continue
  let text = fs.readFileSync(file, 'utf8')
  const n = (text.match(/\?v=\d+/g) || []).length
  text = text.replace(/\?v=\d+/g, `?v=${stamp}`)
  fs.writeFileSync(file, text)
  console.log(`[bump] ${rel} 已更新 ${n} 处缓存戳 -> ?v=${stamp}`)
}
