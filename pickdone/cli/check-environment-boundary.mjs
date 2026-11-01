#!/usr/bin/env node
// Prevent personal machine settings from entering the product repository.
// Run locally and in existing CI; do not duplicate the project's release process.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const rules = [
  ['machine-specific Windows path', /\b[A-Z]:[\\/](?:Users|AIControl|ZPROJECT|pickdone-drill|PickDone)(?:[\\/]|(?=['"\s]|$))/i],
  ['private LAN address', /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/],
  ['personal Windows computer name', /\bDESKTOP-[A-Z0-9-]{5,}\b/i],
  ['absolute personal home path', /\/(?:home|Users)\/[A-Za-z0-9._-]+\/[A-Za-z0-9._~\/-]+/i]
]

// Ignore generated dependencies and tests (which may contain negative fixtures).
// Cover source, ops scripts, workflows, agent instructions and public documentation.
export const isScannedPath = name => {
  const p = name.replaceAll('\\', '/')
  if (/^(?:pickdone\/(?:tests|test|vendor|node_modules)\/|tests\/|node_modules\/)/.test(p)) return false
  if (!/\.(?:md|mjs|cjs|js|json|ya?ml|sh|ps1|ts|vue)$/.test(p)) return false
  return /^(?:pickdone\/|\.github\/|docs\/|CONTRIBUTING\.md$|README\.md$)/.test(p)
}

export const findLeaks = (name, source) => {
  const found = []
  for (const [label, re] of rules) {
    // Locale placeholders intentionally show a generic LAN IP to guide the user.
    if (label === 'private LAN address' && /\/renderer\/js\/i18n\//.test(name)) continue
    const match = re.exec(source)
    if (match) {
      const line = source.slice(0, match.index).split('\n').length
      found.push(name + ':' + line + ': ' + label)
    }
  }
  return found
}
export const checkPrTitle = title =>
  /^(?:feat|fix|chore|docs|refactor|test|ci|perf|build)(?:\([a-z0-9-]+\))?: .{6,}$/.test(title)

export function auditRepository (repoRoot = root) {
  const names = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0').filter(Boolean).filter(isScannedPath)
  if (names.length === 0) throw new Error('No tracked source files found; refusing a false-green check')
  const staged = new Set(execFileSync('git', ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], { cwd: repoRoot, encoding: 'utf8' }).split('\0').filter(Boolean))
  const violations = []
  for (const name of names) {
    try {
      const source = staged.has(name) ? execFileSync('git', ['show', ':' + name], { cwd: repoRoot, encoding: 'utf8' }) : readFileSync(path.join(repoRoot, name), 'utf8')
      violations.push(...findLeaks(name, source))
    } catch (err) {
      if (err && err.code === 'ENOENT') continue // staged deletion, checked in CI after commit
      throw err
    }
  }
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    const eventFile = process.env.GITHUB_EVENT_PATH
    if (!eventFile) violations.push('PR title: GITHUB_EVENT_PATH missing (fail closed)')
    else {
      const pr = JSON.parse(readFileSync(eventFile, 'utf8')).pull_request
      if (!pr || !checkPrTitle(pr.title || '')) violations.push('PR title: must use type(scope): description')
    }
  }
  return { inspected: names.length, violations }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = auditRepository()
    if (result.violations.length) {
      console.error('Project boundary check FAILED:\n' + result.violations.join('\n'))
      process.exitCode = 1
    } else console.log('Project boundary check PASS (' + result.inspected + ' tracked source files)')
  } catch (err) {
    console.error('Project boundary check FAILED: ' + err.message)
    process.exitCode = 1
  }
}
