import { test } from 'node:test'
import { createRequire } from 'node:module'
import dayjs from 'dayjs'
test('DIAG tz probe (temporary, never merge)', () => {
  const req = createRequire(import.meta.url)
  const Database = req('better-sqlite3-multiple-ciphers')
  const db = new Database(':memory:')
  const now = Date.now()
  const row = db.prepare("SELECT CAST(strftime('%Y%m%d', ?/1000, 'unixepoch', 'localtime') AS INTEGER) ds").get(now)
  console.error('[tzprobe] TZenv=' + process.env.TZ +
    ' | Date.toString=' + new Date(now).toString() +
    ' | dayjs=' + dayjs(now).format() +
    ' | utcOffset=' + dayjs().utcOffset() +
    ' | sqliteLocaltimeDay=' + row.ds +
    ' | dayjsDay=' + dayjs(now).format('YYYYMMDD'))
})
