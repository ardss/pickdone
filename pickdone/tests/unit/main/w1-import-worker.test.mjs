// W1 regression: csv-import parsing moved off the main thread into src/main/import-worker.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const workerPath = path.join(root, 'src', 'main', 'import-worker.js')

function runWorker (text, format = 'auto') {
  return new Promise((resolve, reject) => {
    const w = new Worker(workerPath, { workerData: { text, format } })
    w.on('message', m => { w.terminate(); m && m.ok ? resolve(m) : reject(new Error((m && m.error) || 'worker failed')) })
    w.on('error', reject)
    w.on('exit', code => { if (code !== 0) reject(new Error('worker exited ' + code)) })
  })
}

const TICKTICK_CSV = [
  'Date: 2024-01-01 12:00:00',
  'Version: 3.0',
  '"List Name","Title","Start Date","Due Date","Completed Time","Content","Priority","Tags"',
  '"Inbox","Buy milk",,,,"2 cartons",0,life',
  '"Inbox","Pay rent",,"2024-03-02","2024-03-02 10:00:00","",High,bills'
].join('\r\n')

test('import-worker: parses CSV off-thread with results identical to in-process rowsToItems', async () => {
  const importer = await import(pathToFileURL(path.join(root, 'cli', 'import.js')).href)
  const text = TICKTICK_CSV
  const expectedFormat = importer.detectFormat(text)
  const expected = importer.rowsToItems(text, expectedFormat)
  const res = await runWorker(text)
  assert.equal(res.ok, true)
  assert.equal(res.format, expectedFormat)
  assert.equal(res.format, 'ticktick')
  assert.equal(res.items.length, expected.length)
  assert.deepStrictEqual(res.items, expected)
})

test('import-worker: unknown format is reported (no silent hang), matching importFile validation', async () => {
  await assert.rejects(
    () => runWorker('this,is,not,a,real,format\r\n1,2,3,4,5,6\r\n'),
    /cannot recognize the CSV format/i
  )
})

test('import-worker: worker errors are surfaced as rejections (error propagation contract)', async () => {
  // null workerData text would throw inside detectFormat/rowsToItems — worker must report, not hang
  await assert.rejects(
    () => new Promise((resolve, reject) => {
      const w = new Worker(workerPath, { workerData: {} })
      w.on('message', m => { w.terminate(); m && m.ok ? resolve(m) : reject(new Error(m.error)) })
      w.on('error', reject)
    }),
    /err|Cannot/i
  )
})
