#!/usr/bin/env node
/**
 * 视觉回归 diff（SOP-06 补充⑨）—— 两张截图逐像素对比，量化差异比例。
 * 零依赖：内置最小 PNG 解码（8bit RGB/RGBA/灰度、非隔行，zlib 内置），
 * 不支持的位深/隔行格式自动退化为文件级比对并如实报告。
 *
 * 用法: node scripts/visual-diff.mjs <baseline.png> <current.png> [阈值百分比, 默认0.5]
 * 退出码: 0=一致(差异≤阈值)  1=超阈  2=用法/读取错误
 */
import fs from 'node:fs'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
// .mjs 里用 createRequire 兼容 require 风格 API

function fail (msg, code = 2) { console.error(msg); process.exit(code) }

const require = createRequire(import.meta.url)
const [aPath, bPath, tolArg] = process.argv.slice(2)
if (!aPath || !bPath) fail('用法: node scripts/visual-diff.mjs <baseline.png> <current.png> [阈值%默认0.5]', 2)
const tolPct = Number(tolArg || 0.5)

function decodePng (buf, file) {
  if (buf.readUInt32BE(0) !== 0x89504e47) return null
  let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, idat = [], interlace = 0
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12] }
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (bitDepth !== 8 || interlace) return null // 退化路径
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
  if (!ch) return null
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * ch
  const out = Buffer.alloc(w * h * ch)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = out.subarray(y * w * ch, (y + 1) * w * ch)
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0
      const b = prev[x]
      const c = x >= ch ? prev[x - ch] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : (pb <= pc ? b : c)
      }
      cur[x] = v & 0xff
    }
    prev = cur
  }
  return { w, h, ch, data: out }
}

function readDecoded (p) {
  try {
    const buf = fs.readFileSync(p)
    return decodePng(buf, p)
  } catch (e) { fail(`读取失败 ${p}: ${e.message}`) }
}

const A = readDecoded(aPath), B = readDecoded(bPath)
if (!A || !B) {
  // 退化：无法像素解码（如 16bit）→ 至少做字节级一致性判断
  const same = fs.readFileSync(aPath).equals(fs.readFileSync(bPath))
  console.log(same ? 'OK: 文件级完全一致（像素解码不支持，已退化）' : 'DIFF: 文件级不一致（像素解码不支持，请人工复查）')
  process.exit(same ? 0 : 1)
}
if (A.w !== B.w || A.h !== B.h) {
  console.error(`DIFF: 尺寸不同 ${A.w}x${A.h} vs ${B.w}x${B.h}`)
  process.exit(1)
}
let diff = 0
const n = A.w * A.h
for (let i = 0; i < n; i++) {
  const o = i * A.ch
  for (let c = 0; c < 3; c++) { // 忽略 alpha 通道
    if (Math.abs((A.data[o + c] || 0) - (B.data[o + c] || 0)) > 8) { diff++; break }
  }
}
const pct = diff / n * 100
const ok = pct <= tolPct
console.log(`${ok ? 'OK' : 'DIFF'}: 差异像素 ${diff}/${n} (${pct.toFixed(3)}%)，阈值 ${tolPct}% — ${aPath} vs ${bPath}`)
process.exit(ok ? 0 : 1)
