/**
 * D1 pilot entry (docs/test-runner-modernization-design.md) — opt-in only,
 * wired to NO gate. Runs the pilot dir under vitest with a TAP reporter and
 * saves the stream for the summary gate's parser (acceptance 3).
 *
 * Usage: node tests/run-pilot.mjs
 *   env PILOT_TAP=<path>  also write the TAP stream there (default:
 *                         tests/.artifacts/pilot.tap)
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = process.env.PILOT_TAP || path.join(ROOT, 'tests', '.artifacts', 'pilot.tap')
fs.mkdirSync(path.dirname(OUT), { recursive: true })
const out = fs.openSync(OUT, 'w')

const t0 = Date.now()
const child = spawn(process.execPath, [
  'node_modules/vitest/vitest.mjs', 'run', '--reporter=tap', '--silent',
], { cwd: ROOT, stdio: ['ignore', out, out] })
child.on('exit', (code) => {
  fs.closeSync(out)
  // Normalize vitest's NESTED TAP (per-file entries with indented subtests,
  // no trailing `# tests/# fail` summary) into the flat shape the summary
  // gate's plan-anchored parser expects (acceptance 3: the gate parses the
  // pilot TAP UNMODIFIED — the adapter lives HERE, not in the gate).
  const raw = fs.readFileSync(OUT, 'utf8')
  const entries = []
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^(ok|not ok) \d+ - (tests\/\S+?\.test\.mjs)/)
    if (m) entries.push({ ok: m[1] === 'ok', file: m[2] })
  }
  const fail = entries.filter(e => !e.ok).length
  const flat = [
    'TAP version 13',
    `1..${entries.length}`,
    ...entries.map((e, i) => `${e.ok ? 'ok' : 'not ok'} ${i + 1} - ${e.file}`),
    `# tests ${entries.length}`,
    `# pass ${entries.length - fail}`,
    `# fail ${fail}`,
    '# cancelled 0',
    '# skipped 0',
    '',
  ].join('\n')
  fs.writeFileSync(OUT, flat)
  console.log(`[run-pilot] vitest exit=${code} wall=${((Date.now() - t0) / 1000).toFixed(1)}s files=${entries.length} fail=${fail} tap=${path.relative(ROOT, OUT)}`)
  process.exit(code ?? 1)
})
