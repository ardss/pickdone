// 从 OpenGameArt 采集 CC0 环境音/提示音（只取明确标注 CC0 的页面；拿不到就跳过，由合成版兜底）
import fs from 'fs'
import { execSync } from 'child_process'

const curl = (url, timeout = 25) => {
  try { return execSync(`curl -s -m ${timeout} -L "${url}"`, { encoding: 'utf8', maxBuffer: 1e8 }) } catch { return '' }
}
const dl = (url, dest) => {
  try { execSync(`curl -s -m 60 -L "${url}" -o "${dest}"`, { stdio: [] }); return fs.existsSync(dest) && fs.statSync(dest).size > 10000 } catch { return false }
}

// 目标清单：关键词 → 输出文件名（.ogg/.wav 由实际资源决定）
const WANT = process.argv[2]
  ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
  : {
      rain: 'rain loop',
      thunderstorm: 'rain and thunder loop',
      rain_to_glass: 'rain on window loop',
      ocean: 'ocean waves loop',
      brook: 'stream water loop',
      fire: 'fire crackle loop',
      forest: 'forest birds ambience',
      cave: 'cave ambience',
      coffee_shop: 'coffee shop ambience',
      street: 'city traffic ambience',
      train: 'train loop'
    }

const seen = new Set()
const credits = []

for (const [slot, query] of Object.entries(WANT)) {
  if (fs.existsSync(`assets/media/${slot}.ogg`) || fs.existsSync(`assets/media/${slot}.wav`) || fs.existsSync(`assets/media/${slot}.mp3`)) {
    console.log(slot, '已存在，跳过'); continue
  }
  console.log('搜索:', slot, '←', query)
  const search = curl(`https://opengameart.org/art-search-advanced?keys=${encodeURIComponent(query)}&field_art_type_tid%5B%5D=13`)
  const pages = [...search.matchAll(/href="\/content\/([^"]+)"/g)].map(m => m[1]).filter(u => !seen.has(u) && !/faq|about/.test(u)).slice(0, 10)
  let done = false
  for (const p of pages) {
    seen.add(p)
    const html = curl('https://opengameart.org/content/' + p)
    const lic = /CC0/.test(html) ? 'CC0' : (/Public Domain/.test(html) ? 'PD' : (/CC-BY/.test(html) ? 'CC-BY' : null));
    if (!lic) continue // 只收可自由分发的许可
    // 资产文件：sites/default/files/ 下的原始音频（排除预览图与预览音）
    const files = [...html.matchAll(/https:\/\/opengameart\.org\/sites\/default\/files\/([^"'\s]+\.(ogg|wav|mp3))/g)]
      .map(m => m[1]).filter(f => !/preview/.test(f))
    if (!files.length) continue
    const file = files[0]
    const ext = file.split('.').pop()
    const dest = `assets/media/${slot}.${ext}`
    if (dl('https://opengameart.org/sites/default/files/' + file, dest)) {
      const author = (html.match(/href="\/users\/[^"]+">([^<]+)<\/a>/) || [])[1] || 'unknown'
      const title = p.replace(/-/g, ' ')
      credits.push({ slot, file: dest, source: 'https://opengameart.org/content/' + p, author, license: lic, title })
      console.log('  ✓', slot, '←', file, '(' + author + ')')
      done = true
      break
    }
  }
  if (!done) console.log('  ✗', slot, '未找到 CC0 资源（保留合成版兜底）')
}

fs.writeFileSync('.tmp-credits.json', JSON.stringify(credits, null, 2))
console.log('完成，署名记录 → .tmp-credits.json')
