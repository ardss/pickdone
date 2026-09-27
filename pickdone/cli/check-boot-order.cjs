#!/usr/bin/env node
/* eslint-env node */
/**
 * Boot-order gate (D10 aftermath, 2026-09-27) — deterministic static scan of
 * pickdone/src/main top-level scope only (function bodies skipped).
 *
 * Catches the two boot TDZ crash shapes shipped by the D10 main-process extraction
 * that no live gate caught (8 live gates went red as a symptom, not a cause):
 *   (1) use-before-declaration of a top-level let/const: identifier read or
 *       assigned on a line ABOVE its own declaration line in the same module
 *       (assignment counts — `x = foo()` above `let x` is the classic shape).
 *   (2) require(...) destructuring placed BELOW the first top-level use of any
 *       name it binds (the "require below first use" shape).
 *
 * Pure static text/AST scan (acorn, already in node_modules). No electron, no
 * execution, no fixtures from the live app. Function bodies and class bodies are
 * skipped: a forward reference inside a function defined before the declaration
 * is legal and must not flag.
 *
 * Usage:
 *   node cli/check-boot-order.cjs           # full scan of src/main (check:all tier)
 *   node cli/check-boot-order.cjs --staged  # only git-staged src/main files (pre-commit tier)
 */
const fs = require('fs')
const path = require('path')
const acorn = require('acorn')

const ROOT = path.join(__dirname, '..')
const TARGET = path.join(ROOT, 'src', 'main')

function listFiles (dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
      listFiles(full, out)
    } else if (/\.(js|cjs|mjs)$/.test(e.name) && !e.name.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

function parse (code) {
  for (const sourceType of ['module', 'script']) {
    try {
      return acorn.parse(code, { ecmaVersion: 'latest', sourceType, locations: true })
    } catch { /* try next mode */ }
  }
  return null
}

// Nodes whose entire subtree is an inner scope: identifier references inside
// them resolve at call time, not at boot, so they are invisible to this gate.
const SCOPE_STOP = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ClassDeclaration', 'ClassExpression'])

// Identifiers that are property keys / member accesses, not variable references.
function isNonReference (node, parent) {
  if (!parent) return false
  if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return true
  if (parent.type === 'Property' && parent.key === node && !parent.computed) return true
  if ((parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && parent.key === node && !parent.computed) return true
  if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') return true
  return false
}

// Collect Identifier references in a subtree, skipping inner scopes and
// non-references. `skipIds` is a Set of AST nodes to ignore (declaration ids).
function collectUses (node, parent, skipIds, out) {
  if (!node || typeof node.type !== 'string') return
  if (SCOPE_STOP.has(node.type)) return
  if (node.type === 'Identifier') {
    if (!skipIds.has(node) && !isNonReference(node, parent)) out.push(node)
    return
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue
    const child = node[key]
    if (Array.isArray(child)) {
      for (const c of child) if (c && typeof c.type === 'string') collectUses(c, node, skipIds, out)
    } else if (child && typeof child.type === 'string') {
      collectUses(child, node, skipIds, out)
    }
  }
}

function declaratorIds (decl) {
  const ids = []
  const walk = n => {
    if (!n || typeof n.type !== 'string') return
    if (n.type === 'Identifier') { ids.push(n); return }
    for (const key of Object.keys(n)) {
      const child = n[key]
      if (Array.isArray(child)) child.forEach(walk)
      else if (child && typeof child.type === 'string') walk(child)
    }
  }
  for (const d of decl.declarations) walk(d.id)
  return ids
}

function checkFile (file, rel) {
  const code = fs.readFileSync(file, 'utf8')
  const ast = parse(code)
  if (!ast) return { parseError: true, findings: [] }
  const findings = []

  // Unwrap export wrappers so exported declarations count as top-level.
  const stmts = ast.body.map(s => {
    if (s.type === 'ExportNamedDeclaration' && s.declaration) return s.declaration
    if (s.type === 'ExportDefaultDeclaration' && s.declaration) return s.declaration
    return s
  })

  // Pass 0: top-level declaration registry (all kinds — used to disambiguate
  // require-binding names that are also locally declared).
  const declaredAnywhere = new Map() // name -> line
  const letConst = new Map() // name -> { line, kind, stmtIdx }
  stmts.forEach((stmt, idx) => {
    if (stmt.type !== 'VariableDeclaration') return
    for (const id of declaratorIds(stmt)) {
      if (!declaredAnywhere.has(id.name)) declaredAnywhere.set(id.name, stmt.loc.start.line)
      if (stmt.kind === 'let' || stmt.kind === 'const') {
        if (!letConst.has(id.name)) letConst.set(id.name, { line: stmt.loc.start.line, kind: stmt.kind, stmtIdx: idx })
      }
    }
  })

  // Pass 1: top-level identifier uses (declaration ids excluded, function and
  // class bodies skipped), per statement, in source order.
  const uses = [] // { name, line, stmtIdx }
  stmts.forEach((stmt, idx) => {
    const skipIds = new Set()
    if (stmt.type === 'VariableDeclaration') for (const id of declaratorIds(stmt)) skipIds.add(id)
    const found = []
    collectUses(stmt, null, skipIds, found)
    for (const u of found) uses.push({ name: u.name, line: u.loc.start.line, stmtIdx: idx })
  })

  // Check (1): let/const used (read OR assigned) textually above its declaration line.
  const firstUseLine = new Map() // name -> min use line
  for (const u of uses) {
    const prev = firstUseLine.get(u.name)
    if (prev === undefined || u.line < prev) firstUseLine.set(u.name, u.line)
  }
  for (const [name, decl] of letConst) {
    const useLine = firstUseLine.get(name)
    if (useLine !== undefined && useLine < decl.line) {
      findings.push(`[${rel}:${useLine}] '${name}' used before its '${decl.kind}' declaration at line ${decl.line} (top-level TDZ: boot-order crash)`)
    }
  }

  // Check (2): require destructuring below the first top-level use of a bound name.
  stmts.forEach((stmt, idx) => {
    if (stmt.type !== 'VariableDeclaration') return
    for (const d of stmt.declarations) {
      if (!d.init || d.init.type !== 'CallExpression') continue
      const callee = d.init.callee
      if (callee.type !== 'Identifier' || callee.name !== 'require') continue
      if (!d.init.arguments.length || d.init.arguments[0].type !== 'Literal') continue
      if (d.id.type !== 'ObjectPattern') continue
      // Set: shorthand pattern properties yield key+value twins — dedupe.
      const names = [...new Set(declaratorIds({ declarations: [d] }).map(n => n.name))]
      for (const name of names) {
        // If the name is also declared by another top-level declaration, the
        // earlier use may refer to that binding — ambiguous, do not flag.
        const otherDecls = [...declaredAnywhere.entries()].filter(([n, l]) => n === name && l !== stmt.loc.start.line)
        if (otherDecls.length) continue
        const useLine = firstUseLine.get(name)
        if (useLine !== undefined && useLine < stmt.loc.start.line) {
          findings.push(`[${rel}:${stmt.loc.start.line}] require destructuring binds '${name}', first top-level use is at line ${useLine} (require below first use)`)
        }
      }
    }
  })

  return { parseError: false, findings }
}

function main () {
  const args = process.argv.slice(2)
  let files
  if (args.includes('--staged')) {
    const { execFileSync } = require('child_process')
    const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], { cwd: ROOT, encoding: 'utf8' })
    files = out.split('\n').filter(Boolean)
      .filter(f => /^src[\\/]main[\\/]/.test(f))
      .map(f => path.join(ROOT, f)).filter(f => fs.existsSync(f))
  } else {
    files = listFiles(TARGET)
  }

  const errors = []
  let scanned = 0
  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/')
    const { parseError, findings } = checkFile(file, rel)
    if (parseError) { errors.push(`[${rel}] could not parse file (neither module nor script mode)`) ; continue }
    scanned++
    errors.push(...findings)
  }

  if (errors.length) {
    console.error('✗ 启动顺序门禁失败（top-level TDZ / require 位置）：')
    for (const e of errors) console.error('  ' + e)
    console.error('  修复：把 let/const 声明与 require 移到其首次顶层使用之前（函数体内前向引用不受限）。')
    process.exit(1)
  }
  console.log(`✓ 启动顺序门禁通过（扫描 src/main ${scanned} 个文件，use-before-declaration 0，require-below-first-use 0）`)
}

main()
