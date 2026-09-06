/** Generate built-in city-outline dataset: renderer/js/utils/city-shapes-data.js
 *  Source: Aliyun DataV GeoAtlas (real administrative boundaries, reachable from mainland networks; Nominatim is DNS-poisoned there).
 *  China market gets fully-offline city outlines; overseas cities keep the widget's Nominatim online fallback.
 *  Format matches WeatherWidget ringToPath (<=40 pts, 1 decimal) so the component needs zero conversion.
 *  Run: node scripts/build-city-shapes.mjs   (network required, ~35 requests) */
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

/** Node 的 fetch(undici) 对部分域名握手失败但系统 curl 正常,构建脚本直接走 curl */
function fetchText (url) {
  return execFileSync('curl', ['-s', '--fail', '-m', '20', '-H', 'User-Agent: PickDone-build', url], { maxBuffer: 64 * 1024 * 1024 }).toString()
}

const OUT = new URL('../renderer/js/utils/city-shapes-data.js', import.meta.url)
const MAX_PTS = 40
const PAD = 3

/** Same math as WeatherWidget.ringToPath, quantized to 1 decimal to keep the bundle lean */
function ringToShape (ring) {
  const step = Math.max(1, Math.ceil(ring.length / MAX_PTS))
  const pts = []
  for (let i = 0; i < ring.length; i += step) pts.push(ring[i])
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity
  for (const [x, y] of pts) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y) }
  const span = Math.max(maxX - minX, maxY - minY) || 1
  const k = (60 - PAD * 2) / span
  const d = pts.map(([x, y], i) => {
    const nx = ((x - minX) * k + PAD).toFixed(1)
    const ny = (60 - PAD - (y - minY) * k).toFixed(1)
    return (i ? 'L' : 'M') + nx + ' ' + ny
  }).join('') + 'Z'
  return { d, vb: '0 0 60 60' }
}

/** Largest ring of Polygon|MultiPolygon -> shape; null when too small to draw */
function largestRingShape (geom) {
  if (!geom) return null
  let ring = null; let best = 0
  if (geom.type === 'Polygon') ring = geom.coordinates[0]
  else if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates) {
      if (poly[0] && poly[0].length > best) { best = poly[0].length; ring = poly[0] }
    }
  }
  if (!ring || ring.length < 8) return null
  return ringToShape(ring)
}

/** "朔州市" "吐鲁番地区" "兴安盟" -> "朔州" "吐鲁番" "兴安" (same suffixes cnCities.js strips) */
function baseName (n) {
  return String(n || '').replace(/(市|地区|盟|自治州|旗)$/, '')
}

async function getJson (url) {
  for (let a = 1; a <= 3; a++) {
    try {
      return JSON.parse(fetchText(url))
    } catch (e) { console.error('retry', a, url.slice(0, 60), String(e).slice(0, 60)) }
    await new Promise(r => setTimeout(r, 1200 * a))
  }
  throw new Error('fetch failed: ' + url)
}

const MUNIS = { 110000: '北京', 120000: '天津', 310000: '上海', 500000: '重庆' }
const provs = await getJson('https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json')
const out = {}
let count = 0
for (const p of provs.features) {
  const ad = p.properties.adcode
  if (!ad) continue
  // 直辖市无地级拆分,省级边界即城市轮廓
  if (MUNIS[ad]) {
    const shape = largestRingShape(p.geometry)
    if (shape) { out[MUNIS[ad]] = shape; count++ }
    continue
  }
  // 港澳台无地级拆分(_full 不存在)或其他省拉取失败:跳过省级整单,不中断全量生成
  let prov = null
  try { prov = await getJson(`https://geo.datav.aliyun.com/areas_v3/bound/${ad}_full.json`) } catch (e) { console.warn('skip', p.properties.name); continue }
  for (const f of prov.features) {
    const name = baseName(f.properties.name)
    if (!name || name === '省直辖' || name === '自治区直辖县级行政区划') continue
    const shape = largestRingShape(f.geometry)
    if (shape) { out[name] = shape; count++ }
  }
  console.log('done', p.properties.name, 'total', count)
}
console.log('china done', count, 'cities')

/* ===== 第二阶段:世界主要城市(Wikidata geoshape,OSM 真实边界) =====
 * 每个 QID 先经 Wikidata API 核对英文名,对不上一律丢弃(宁可缺不可错);
 * 键=小写英文名 + 中文名各一条,组件侧按 name/lowercase 双路查。 */
const WORLD = [
  // 美国
  ['Q60', 'New York City', '纽约'], ['Q65', 'Los Angeles', '洛杉矶'], ['Q1297', 'Chicago', '芝加哥'],
  ['Q16555', 'Houston', '休斯敦'], ['Q1345', 'Philadelphia', '费城'], ['Q16552', 'San Diego', '圣地亚哥'],
  ['Q16557', 'Dallas', '达拉斯'], ['Q16553', 'San Jose', '圣何塞'], ['Q16559', 'Austin', '奥斯汀'],
  ['Q975', 'San Antonio', '圣安东尼奥'], ['Q16568', 'Jacksonville', '杰克逊维尔'], ['Q5083', 'Seattle', '西雅图'],
  ['Q16554', 'Denver', '丹佛'], ['Q61', 'Washington', '华盛顿'], ['Q100', 'Boston', '波士顿'],
  ['Q23197', 'Nashville', '纳什维尔'], ['Q12439', 'Detroit', '底特律'], ['Q6106', 'Portland', '波特兰'],
  ['Q23768', 'Las Vegas', '拉斯维加斯'], ['Q5092', 'Baltimore', '巴尔的摩'], ['Q36091', 'Minneapolis', '明尼阿波利斯'],
  ['Q34968', 'San Francisco', '旧金山'], ['Q49245', 'Phoenix', '凤凰城'], ['Q16556', 'Fort Worth', '沃思堡'],
  ['Q128230', 'Columbus', '哥伦布'], ['Q50468', 'Indianapolis', '印第安纳波利斯'], ['Q37836', 'Milwaukee', '密尔沃基'],
  ['Q62', 'San Francisco', '旧金山'], ['Q16556', 'Phoenix', '凤凰城'], ['Q16558', 'Fort Worth', '沃思堡'],
  // 欧洲
  ['Q84', 'London', '伦敦'], ['Q90', 'Paris', '巴黎'], ['Q64', 'Berlin', '柏林'], ['Q2807', 'Madrid', '马德里'],
  ['Q220', 'Rome', '罗马'], ['Q1741', 'Vienna', '维也纳'], ['Q727', 'Amsterdam', '阿姆斯特丹'],
  ['Q1492', 'Barcelona', '巴塞罗那'], ['Q1726', 'Munich', '慕尼黑'], ['Q490', 'Milan', '米兰'],
  ['Q1794', 'Frankfurt', '法兰克福'], ['Q72', 'Zurich', '苏黎世'], ['Q1754', 'Stockholm', '斯德哥尔摩'],
  ['Q1748', 'Copenhagen', '哥本哈根'], ['Q1761', 'Dublin', '都柏林'], ['Q597', 'Lisbon', '里斯本'],
  ['Q239', 'Brussels', '布鲁塞尔'], ['Q270', 'Warsaw', '华沙'], ['Q1085', 'Prague', '布拉格'],
  ['Q1781', 'Budapest', '布达佩斯'], ['Q1524', 'Athens', '雅典'], ['Q649', 'Moscow', '莫斯科'],
  ['Q406', 'Istanbul', '伊斯坦布尔'],
  // 亚太
  ['Q1490', 'Tokyo', '东京'], ['Q35765', 'Osaka', '大阪'], ['Q8684', 'Seoul', '首尔'],
  ['Q334', 'Singapore', '新加坡'], ['Q1861', 'Bangkok', '曼谷'], ['Q3630', 'Jakarta', '雅加达'],
  ['Q1461', 'Manila', '马尼拉'], ['Q1865', 'Kuala Lumpur', '吉隆坡'], ['Q1156', 'Mumbai', '孟买'],
  ['Q1353', 'Delhi', '德里'], ['Q1355', 'Bangalore', '班加罗尔'],
  ['Q1867', 'Taipei', '台北'],
  ['Q3130', 'Sydney', '悉尼'], ['Q3141', 'Melbourne', '墨尔本'], ['Q34932', 'Brisbane', '布里斯班'],
  ['Q37100', 'Auckland', '奥克兰'], ['Q11341', 'Hanoi', '河内'],
  // 美洲/中东
  ['Q172', 'Toronto', '多伦多'], ['Q24639', 'Vancouver', '温哥华'], ['Q340', 'Montreal', '蒙特利尔'],
  ['Q36312', 'Calgary', '卡尔加里'], ['Q1489', 'Mexico City', '墨西哥城'], ['Q174', 'São Paulo', '圣保罗'],
  ['Q8678', 'Rio de Janeiro', '里约热内卢'], ['Q1486', 'Buenos Aires', '布宜诺斯艾利斯'],
  ['Q612', 'Dubai', '迪拜'], ['Q3692', 'Riyadh', '利雅得'], ['Q2940', 'Doha', '多哈'], ['Q85', 'Cairo', '开罗']
]

/* 批量核对:wbgetentities 单次最多50个QID,避免逐条请求触发限速(限速误杀曾致一半城市被跳) */
async function verifyQids (list) {
  const ok = new Set()
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50)
    const ids = chunk.map(c => c[0]).join('|')
    try {
      const j = await getJson(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids}&props=labels&languages=en&format=json`)
      for (const [qid, en] of chunk) {
        const actual = (j.entities?.[qid]?.labels?.en?.value || '').toLowerCase()
        if (actual === en.toLowerCase() || actual.startsWith(en.toLowerCase())) ok.add(qid)
        else console.error('QID mismatch, skip', qid, en, '->', actual)
      }
    } catch (e) { console.error('verify batch failed, skipping chunk') }
    await new Promise(r => setTimeout(r, 1500))
  }
  return ok
}

let wCount = 0
const verified = await verifyQids(WORLD)
for (const [qid, en, zh] of WORLD) {
  process.stdout.write('world ' + en + ' ... ')
  if (!verified.has(qid)) { console.error('not verified, skip'); continue }
  try {
    const gj = await getJson(`https://maps.wikimedia.org/geoshape?getgeojson=1&ids=${qid}`)
    const f = gj.features && gj.features[0]
    const shape = f && largestRingShape(f.geometry)
    if (!shape) { console.error('no shape', en); continue }
    // 别名:全小写英文名 + 去尾词别名("new york city"->"new york") + 中文名,组件侧多路命中
    out[en.toLowerCase()] = shape
    const trimmed = en.toLowerCase().replace(/\s+(city|county|municipality)$/, '')
    if (trimmed !== en.toLowerCase()) out[trimmed] = shape
    out[zh] = shape
    wCount++
    console.log('ok')
  } catch (e) { console.error('geoshape fail', en) }
  await new Promise(r => setTimeout(r, 2000)) // 礼貌限速
}

writeFileSync(OUT, '/** 城市轮廓内置数据集(生成于 scripts/build-city-shapes.mjs,勿手改):中国地级市(键=去后缀市名)+世界主要城市(键=小写英文名/中文名),值与 WeatherWidget 渲染格式一致 {d,vb} */\nexport default ' + JSON.stringify(out) + '\n')
console.log('written total', count + wCount, 'cities (china', count, '+ world', wCount, ')')