// W22 生产库只读检查（副本上操作，绝不碰原库）
const os = require('os'), path = require('path'), fs = require('fs')
const T = path.join(os.tmpdir(), 'w22-prod-inspect')
fs.mkdirSync(T, { recursive: true })
for (const f of ['todos.db', 'todos.db-wal', 'todos.db-shm', 'db.key'])
  fs.copyFileSync(path.join(process.env.APPDATA, 'PickDone', f), path.join(T, f))
const Driver = require(path.join(__dirname, '..', 'vendor', 'better-sqlite3-multiple-ciphers'))
const key = fs.readFileSync(path.join(T, 'db.key'), 'utf8').trim()
const db = new Driver(path.join(T, 'todos.db'))
db.pragma(`key='${key}'`)
db.pragma('cipher_memory_security=OFF')
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
console.log('tables:', tables.join(','))
try {
  const rows = db.prepare('SELECT COUNT(*) n FROM sqlite_master').get()
  console.log('ok, master rows:', rows.n)
} catch (e) { console.log('OPEN-FAIL:', e.message); process.exit(1) }
for (const t of ['todos']) {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name)
  console.log('cols:', cols.join(','))
  const contentCol = cols.find(c => /content|title|text/i.test(c)) || cols[1]
  console.log(`table ${t}:`, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 'rows')
  console.log('  deleted=1:', db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE deleted=1`).get().n)
  const like = cols.filter(c => c === contentCol).map(c => `${c} LIKE '%测试%' OR ${c} LIKE '%E2E%' OR ${c} LIKE '%集成%' OR ${c} LIKE '%test%'`).join(' OR ')
  console.log('  test-like:', db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${like}`).get().n)
  const samples = db.prepare(`SELECT rowid, substr(${contentCol},1,50) c, deleted FROM ${t} WHERE ${like} ORDER BY rowid DESC LIMIT 20`).all()
  for (const s of samples) console.log('   ', JSON.stringify(s))
  const recent = db.prepare(`SELECT rowid, substr(${contentCol},1,50) c, deleted, datetime(rowid/1000,'unixepoch') d FROM ${t} ORDER BY rowid DESC LIMIT 10`).all()
  console.log('  recent rows:')
  for (const s of recent) console.log('   ', JSON.stringify(s))
}
