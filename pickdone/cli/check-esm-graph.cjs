#!/usr/bin/env node
/* ESM import/export matching gate — SFC+Vite 形态(2026-09-05 重写适配):
 * 历史锚点:noisePlayer.js 只有命名导出而 main.js 默认导入 → 整链白屏(4fddf5f 修复后立此门禁)。
 * 检查:
 *   1. 每条 import 目标文件存在(含 Windows 大小写核对)
 *   2. 命名导入存在于目标导出集;默认导入要求目标有 export default
 *   3. 动态 import() 目标存在(逃逸 renderer/js 的目标按白名单)
 * SFC 适配:.vue 取 <script> 体,经 typescript.transpileModule 剥掉类型注解再交 acorn;
 * 'vue'/'solarlunar' 裸名是 vite.config 的合法别名(编译期解析,运行时由 Vite 产物保证)。
 */
const fs = require('fs')
const path = require('path')
const acorn = require('acorn')
const ts = require('typescript')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'renderer', 'js')
const ENTRY = path.join(SRC, 'main.js')
// Dynamic imports may escape renderer/js only to these targets (runtime dependencies, not part of the source module graph)
const EXTERNAL_PREFIXES = ['node_modules']
const ALIAS_BARE = new Set(['vue', 'solarlunar'])

const errors = []
const visited = new Set()

function listFiles (dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    const st = fs.statSync(p)
    if (st.isDirectory()) listFiles(p, out)
    else if (f.endsWith('.js') || f.endsWith('.vue')) out.push(p)
  }
  return out
}

function vueScript (file, src) {
  if (!file.endsWith('.vue')) return src
  const m = src.match(/<script[^>]*>\r?\n([\s\S]*?)\r?\n<\/script>/)
  return m ? m[1] : ''
}

/** Resolve an import specifier to an absolute path (tries .js/.vue completion); returns null when missing */
function resolveImport (fromFile, spec) {
  if (ALIAS_BARE.has(spec)) return { external: true }
  if (!spec.startsWith('.')) return { external: true } // bare specifier (should be zero under this architecture; any occurrence is reported)
  const base = path.resolve(path.dirname(fromFile), spec)
  const candidates = [base, base + '.js', base + '.vue', path.join(base, 'index.js')]
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return { file: c }
  }
  return { file: null }
}

/** Windows case check: compare each path segment against the real on-disk directory entry */
function caseMatches (file) {
  let cur = path.parse(file).root
  const segs = file.slice(cur.length).split(path.sep)
  for (const seg of segs) {
    const real = fs.readdirSync(cur).find(s => s === seg)
    if (real !== seg) return false
    cur = path.join(cur, seg)
  }
  return true
}

function collectExports (file) {
  const src = fs.readFileSync(file, 'utf8')
  const names = new Set()
  let hasDefault = false
  for (const node of parse(file, src)) {
    if (node.type === 'ExportDefaultDeclaration') hasDefault = true
    else if (node.type === 'ExportNamedDeclaration') {
      for (const s of node.specifiers) names.add(s.exported.name || s.exported.value)
      if (node.declaration) {
        const d = node.declaration
        if (d.id) names.add(d.id.name)
        else if (d.declarations) for (const decl of d.declarations) walkNames(decl.id, names)
      }
    }
  }
  // .vue 模块由 @vitejs/plugin-vue 隐式提供组件默认导出
  if (file.endsWith('.vue')) hasDefault = true
  return { names, hasDefault }
}

function walkNames (id, set) {
  if (!id) return
  if (id.type === 'Identifier') set.add(id.name)
  else if (id.type === 'ObjectPattern') for (const p of id.properties) walkNames(p.value || p.argument, set)
  else if (id.type === 'ArrayPattern') for (const el of id.elements) walkNames(el, set)
}

function parse (file, src) {
  let code = vueScript(file, src)
  if (file.endsWith('.vue')) {
    code = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESLatest } }).outputText
  }
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' })
  return ast.body
}

function checkFile (file) {
  if (visited.has(file)) return
  visited.add(file)
  const src = fs.readFileSync(file, 'utf8')
  let body
  try { body = parse(file, src) } catch (e) {
    errors.push(`${path.relative(ROOT, file)}: 解析失败 ${e.message}`)
    return
  }
  for (const node of body) {
    let spec = null, isDynamic = false
    if (node.type === 'ImportDeclaration') spec = node.source.value
    else if (node.type === 'ImportExpression' && typeof node.source.value === 'string') { spec = node.source.value; isDynamic = true }
    if (!spec) continue
    const r = resolveImport(file, spec)
    if (r.external) {
      if (!ALIAS_BARE.has(spec)) {
        errors.push(`${path.relative(ROOT, file)}: 裸名导入 "${spec}"（本架构无 bundler,禁止 node_modules 裸导入）`)
      }
      continue
    }
    if (!r.file) {
      if (isDynamic && EXTERNAL_PREFIXES.some(p => spec.includes(p))) continue
      errors.push(`${path.relative(ROOT, file)}: import 目标不存在 "${spec}"`)
      continue
    }
    if (!caseMatches(r.file)) errors.push(`${path.relative(ROOT, file)}: import 大小写与磁盘不符 "${spec}"`)
    if (isDynamic) continue // dynamic imports only check existence
    const exp = collectExports(r.file)
    for (const imp of node.specifiers) {
      if (imp.type === 'ImportDefaultSpecifier' && !exp.hasDefault) {
        errors.push(`${path.relative(ROOT, file)}: 默认导入 "${spec}" 但目标无 export default（白屏级）`)
      } else if (imp.type === 'ImportSpecifier') {
        const want = imp.imported.name || imp.imported.value
        if (!exp.names.has(want)) errors.push(`${path.relative(ROOT, file)}: 命名导入 { ${want} } 不在 "${spec}" 的导出中（白屏级）`)
      }
    }
    checkFile(r.file)
  }
}

checkFile(ENTRY)
// Whole-graph backstop: modules not referenced from the entry also get the export-parse health check
for (const f of listFiles(SRC)) {
  if (!visited.has(f)) {
    try { parse(f, fs.readFileSync(f, 'utf8')) } catch (e) { errors.push(`${path.relative(ROOT, f)}: 解析失败 ${e.message}`) }
  }
}

if (errors.length) {
  console.error('[check-esm-graph] FAIL')
  for (const e of errors) console.error('  ' + e)
  process.exit(1)
}
console.log(`[check-esm-graph] OK (${visited.size} modules from entry, full-tree parse OK)`)
