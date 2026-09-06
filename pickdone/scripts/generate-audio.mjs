/**
 * 内置音频合成器 —— 零依赖生成 assets/media/ 全部提示音与白噪音（WAV/PCM 16bit）
 * 版权：本脚本合成，产物视同 CC0，可随应用分发。
 * 运行：node scripts/generate-audio.mjs
 * 输出（assets/media/）：
 *   tomato_ok.wav          完成提示音（双音风铃）
 *   rain.wav thunderstorm.wav rain_to_glass.wav
 *   ocean.wav brook.wav fire.wav forest.wav cave.wav coffee_shop.wav street.wav train.wav
 * 环境音统一 14s 无缝循环（结尾与开头交叉淡化拼接）、22.05kHz 单声道 16bit。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const SR = 22050
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'media')
fs.mkdirSync(DIR, { recursive: true })

/** 写 16bit 单声道 WAV */
function writeWav (name, samples) {
  const n = samples.length
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28)
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2)
  }
  fs.writeFileSync(path.join(DIR, name), buf)
  console.log('  ', name, (buf.length / 1024).toFixed(0) + 'KB')
}

const rand = (() => { let s = 1234567; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff * 2 - 1 })()

/** 无缝循环：把结尾 cross 长度与开头做等功率交叉 */
function seamless (x, crossSec = 1.5) {
  const c = Math.floor(crossSec * SR)
  const out = x.slice(0, x.length - c)
  for (let i = 0; i < c; i++) {
    const t = i / c
    out[i] = out[i] * Math.sqrt(1 - t) + x[x.length - c + i] * Math.sqrt(t)
  }
  return out
}
const sec = n => Math.floor(n * SR)

/** 白噪声 */
function noise (n) { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = rand(); return a }
/** 简单一阶低通 */
function lowpass (x, alpha) { const y = new Float64Array(x.length); let p = 0; for (let i = 0; i < x.length; i++) { p += alpha * (x[i] - p); y[i] = p } return y }
/** 增益包络调制：mod(t) 返回 0~1 */
function modulate (x, mod) { const y = new Float64Array(x.length); for (let i = 0; i < x.length; i++) y[i] = x[i] * mod(i / SR); return y }
function mixInto (base, add, gain = 1) { for (let i = 0; i < base.length; i++) base[i] += add[i] * gain }
function normalize (x, peak = 0.72) {
  let m = 0; for (const v of x) m = Math.max(m, Math.abs(v))
  if (m === 0) return x
  const g = peak / m; for (let i = 0; i < x.length; i++) x[i] *= g
  return x
}

const LEN = sec(14)
const libs = {}
const N = noise(LEN + sec(2)) // 原料池（比目标长，便于低通相位稳定）

/** 雨：白噪高频为主 + 随机雨滴瞬态 */
function genRain () {
  const x = lowpass(N, 0.55)
  const drops = modulate(x, () => 1)
  for (let i = 0; i < 260; i++) { // 雨滴
    const p = Math.floor(rand() * (LEN - 400))
    const amp = 0.12 + rand() * 0.2
    for (let j = 0; j < 220; j++) { if (p + j < LEN) drops[p + j] += Math.sin(j / 6) * amp * Math.exp(-j / 60) }
  }
  return seamless(normalize(drops))
}
/** 雷暴：雨底 + 低频轰隆 */
function genThunder () {
  const base = genRain().map(v => v * 0.8)
  const rumble = lowpass(noise(LEN + sec(2)), 0.015)
  const out = base
  for (let i = 0; i < 3; i++) { // 三声雷
    const p = Math.floor((0.12 + i * 0.31) * LEN)
    const amp = 0.9 - i * 0.18
    for (let j = 0; j < sec(2.6); j++) { if (p + j < LEN) out[p + j] += rumble[(p + j) % rumble.length] * amp * Math.exp(-j / (SR * 0.5)) * Math.sin(j / SR * 9) }
  }
  return seamless(normalize(out))
}
/** 雨打玻璃：雨 + 高频清脆滴答 */
function genRainGlass () {
  const base = genRain().map(v => v * 0.55)
  for (let i = 0; i < 200; i++) {
    const p = Math.floor(rand() * (LEN - 900))
    const f = 1500 + rand() * 2400
    const amp = 0.08 + rand() * 0.16
    for (let j = 0; j < 500; j++) { if (p + j < LEN) base[p + j] += Math.sin(f * j / SR) * amp * Math.exp(-j / 90) }
  }
  return seamless(normalize(base))
}
/** 海浪：棕噪 + 6~11s 周期起伏 */
function genOcean () {
  const x = lowpass(lowpass(N, 0.045), 0.3)
  return seamless(normalize(modulate(x, t => 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2 / 9 - 1.2) + 0.12 * Math.sin(t * 5.3)))))
}
/** 溪流：中频噪 + 气泡哔噜 */
function genBrook () {
  const x = lowpass(N, 0.32)
  const y = modulate(x, t => 0.7 + 0.3 * Math.sin(t * 21) * Math.sin(t * 7.3))
  for (let i = 0; i < 90; i++) {
    const p = Math.floor(rand() * (LEN - 700))
    const f = 600 + rand() * 900
    for (let j = 0; j < 420; j++) { if (p + j < LEN) y[p + j] += Math.sin(f * (1 + j / 900) * j / SR) * 0.1 * Math.exp(-j / 200) }
  }
  return seamless(normalize(y))
}
/** 篝火：低噪底 + 劈啪爆裂 */
function genFire () {
  const base = lowpass(N, 0.06)
  const y = modulate(base, t => 0.8 + 0.25 * Math.sin(t * 2.1) + 0.1 * Math.sin(t * 13))
  for (let i = 0; i < 320; i++) {
    const p = Math.floor(rand() * (LEN - 300))
    const amp = 0.06 + rand() * rand() * 0.5
    for (let j = 0; j < 160; j++) { if (p + j < LEN) y[p + j] += rand() * amp * Math.exp(-j / 22) }
  }
  return seamless(normalize(y))
}
/** 森林：风过树梢（低噪起伏）+ 鸟鸣两三声 */
function genForest () {
  const x = lowpass(N, 0.12)
  let y = modulate(x, t => 0.5 + 0.5 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2 / 7)))
  const bird = (p, f0) => { for (let j = 0; j < sec(0.5); j++) { const t = j / SR; const f = f0 + Math.sin(t * 40) * 300 + t * 900; if (p + j < LEN) y[p + j] += Math.sin(f * t * 2 * Math.PI) * 0.16 * Math.exp(-t / 0.22) * Math.sin(Math.PI * Math.min(1, t / 0.5)) } }
  bird(sec(2.2), 2600); bird(sec(6.4), 3100); bird(sec(10.1), 2300)
  return seamless(normalize(y))
}
/** 山洞：极低频轰鸣 + 滴水回声 */
function genCave () {
  let y = lowpass(lowpass(noise(LEN + sec(2)), 0.02), 0.4)
  y = modulate(y, t => 0.7 + 0.3 * Math.sin(t * 1.3))
  for (let i = 0; i < 14; i++) {
    const p = Math.floor(rand() * (LEN - sec(1.2)))
    const f = 900 + rand() * 700
    for (let j = 0; j < sec(0.9); j++) {
      if (p + j >= LEN) break
      const echo = (j > sec(0.28) ? 0.35 : 1) * Math.exp(-j / (SR * 0.16))
      y[p + j] += Math.sin(f * j / SR) * 0.1 * echo
    }
  }
  return seamless(normalize(y, 0.6))
}
/** 咖啡馆：嗡嗡人声段 + 杯碟叮当 */
function genCoffee () {
  let y = lowpass(N, 0.18)
  y = modulate(y, t => 0.45 + 0.55 * Math.abs(Math.sin(t * 0.9 + Math.sin(t * 2.7))))
  for (let i = 0; i < 26; i++) { // 人声语段（窄带噪声团）
    const p = Math.floor(rand() * (LEN - sec(1.4)))
    const f = 180 + rand() * 220
    for (let j = 0; j < sec(1.2); j++) {
      if (p + j >= LEN) break
      const t = j / SR
      y[p + j] += (Math.sin(f * t * 2 * Math.PI) * 0.5 + rand() * 0.5) * 0.12 * Math.sin(Math.PI * Math.min(1, t / 1.2)) * (0.6 + 0.4 * Math.sin(t * 26))
    }
  }
  for (let i = 0; i < 8; i++) {
    const p = Math.floor(rand() * (LEN - 900))
    for (let j = 0; j < 600; j++) { if (p + j < LEN) y[p + j] += Math.sin(2400 * j / SR) * 0.08 * Math.exp(-j / 70) }
  }
  return seamless(normalize(y, 0.6))
}
/** 街道：低频车流 + 偶发近处驶过 */
function genStreet () {
  let y = lowpass(lowpass(noise(LEN + sec(2)), 0.03), 0.5)
  y = modulate(y, t => 0.6 + 0.4 * Math.abs(Math.sin(t * 0.5)))
  for (let i = 0; i < 5; i++) {
    const p = Math.floor(rand() * (LEN - sec(3)))
    for (let j = 0; j < sec(3); j++) {
      const t = j / SR
      const pass = Math.sin(Math.PI * Math.min(1, t / 3)) // 驶过包络
      y[p + j] += lowpass(noise(64), 0.5)[j % 64] * 0.5 * pass + Math.sin((300 + 900 * t / 3) * t * 2 * Math.PI) * 0.05 * pass
    }
  }
  return seamless(normalize(y, 0.65))
}
/** 火车：轨道咔嗒节奏 + 行进轰鸣 */
function genTrain () {
  const rumble = modulate(lowpass(noise(LEN + sec(2)), 0.08), t => 0.6 + 0.4 * Math.sin(t * 2 * Math.PI / 1.8))
  const y = new Float64Array(LEN)
  mixInto(y, rumble, 0.9)
  const beat = sec(0.62) // 轨节周期
  for (let p = 0; p + 900 < LEN; p += beat) {
    for (let j = 0; j < 700; j++) { if (p + j < LEN) y[p + j] += rand() * 0.3 * Math.exp(-j / 90) }
  }
  return seamless(normalize(y, 0.68))
}
/** 完成提示音：E6→B6 双音风铃（带泛音与衰减） */
function genChime () {
  const n = sec(1.6)
  const y = new Float64Array(n)
  const note = (p, f, amp) => {
    for (let j = 0; j < n - p; j++) {
      const t = j / SR
      const env = Math.exp(-t / 0.32) * Math.min(1, t / 0.004)
      y[p + j] += amp * env * (Math.sin(f * t * 2 * Math.PI) + 0.4 * Math.sin(f * 2 * t * 2 * Math.PI) + 0.18 * Math.sin(f * 3 * t * 2 * Math.PI))
    }
  }
  note(0, 1318.5, 0.5) // E6
  note(Math.floor(SR * 0.14), 1975.5, 0.6) // B6
  return normalize(y, 0.8)
}

console.log('生成内置音频（合成，无版权负担）→ assets/media/')
writeWav('tomato_ok.wav', genChime())
writeWav('rain.wav', genRain())
writeWav('thunderstorm.wav', genThunder())
writeWav('rain_to_glass.wav', genRainGlass())
writeWav('ocean.wav', genOcean())
writeWav('brook.wav', genBrook())
writeWav('fire.wav', genFire())
writeWav('forest.wav', genForest())
writeWav('cave.wav', genCave())
writeWav('coffee_shop.wav', genCoffee())
writeWav('street.wav', genStreet())
writeWav('train.wav', genTrain())
console.log('完成')
