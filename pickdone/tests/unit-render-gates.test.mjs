// SFC + Vite 工程化门禁(2026-09-05 迁移后形态)
//  1. 每个 .vue 必须有 <template> 且 <script lang="ts">(TS 逻辑层形态)
//  2. renderer 的 .js 里不得再出现 template: 字符串(模板唯一载体是 .vue)
//  3. CSP 禁 unsafe-eval 回潮 + vendor Vue 必须 runtime-only 锁版(SFC 编译在构建期完成)
//  4. index.html 的模块入口必须是 Vite 产物形态(/js/main.js 源入口 → dist 注入 hash 资产)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function walk (dir, acc = []) {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) return acc
  for (const f of fs.readdirSync(abs)) {
    const p = path.join(dir, f)
    if (fs.statSync(path.join(ROOT, p)).isDirectory()) walk(p, acc)
    else if (f.endsWith('.vue') || f.endsWith('.js')) acc.push(p)
  }
  return acc
}

test('sfc-gate: every .vue carries <template> and <script lang="ts">', () => {
  const broken = []
  for (const f of walk('renderer/js')) {
    if (!f.endsWith('.vue')) continue
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
    if (!/<template>\r?\n[\s\S]*?\r?\n<\/template>/.test(src)) broken.push(`${f}: missing <template>`)
    if (!/<script lang="ts">/.test(src)) broken.push(`${f}: script is not lang="ts"`)
  }
  assert.deepEqual(broken, [], broken.join('\n'))
})

test('sfc-gate: no template: string components remain in renderer js (SFC is the only template carrier)', () => {
  const offenders = []
  for (const f of walk('renderer/js')) {
    if (!f.endsWith('.js') || f.endsWith('.render.js') || f.endsWith('router.js')) continue
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
    if (/\btemplate:\s*[`']/.test(src)) offenders.push(f)
  }
  assert.deepEqual(offenders, [], 'runtime template strings must not return; offenders: ' + offenders.join(', '))
})

test('sfc-gate: CSP stays free of unsafe-eval and vendor Vue stays runtime-only', () => {
  const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8')
  assert.ok(!html.includes('unsafe-eval'), 'CSP must not re-introduce unsafe-eval (SFC templates are compiled at build time)')
  const vendor = fs.readFileSync(path.join(ROOT, 'assets/vendor-lib/vue3.global.prod.js'), 'utf8')
  const runtimeDist = fs.readFileSync(path.join(ROOT, 'node_modules/vue/dist/vue.runtime.global.prod.js'), 'utf8')
  assert.equal(vendor, runtimeDist, 'vendor vue3.global.prod.js must be the runtime-only build in lockstep with @vue/compiler-dom')
})

test('sfc-gate: renderer entry is the Vite module source form', () => {
  const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8')
  assert.ok(html.includes('<script type="module" src="/js/main.js">'), 'entry must be the Vite-processed module source (/js/main.js)')
})
