#!/usr/bin/env node
// Tag only the reviewed release commit already merged into protected main.
// Tag push triggers the existing Draft workflow. NEVER publishes a Release.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { isReleaseVersion } from './release-version.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const sh = args => execFileSync(args[0], args.slice(1), { cwd: ROOT, encoding: 'utf8' }).trim()
const fail = msg => { console.error('✗ release:tag: ' + msg); process.exit(1) }
const version = process.argv[2]
if (!isReleaseVersion(version)) fail('usage: npm run release:tag X.Y.Z[-prerelease]')
const tag = 'v' + version

if (sh(['git', 'branch', '--show-current']) !== 'main') fail('tagging requires checked-out main')
if (sh(['git', 'status', '--porcelain'])) fail('working tree must be clean')
sh(['git', 'fetch', 'origin', 'main'])
const head = sh(['git', 'rev-parse', 'HEAD'])
const remoteMain = sh(['git', 'rev-parse', 'origin/main'])
if (head !== remoteMain) fail('local main must exactly match reviewed origin/main')

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'))
if (pkg.version !== version || lock.version !== version ||
    (lock.packages && lock.packages[''] && lock.packages[''].version !== version)) {
  fail('package and lock versions must match the requested tag')
}
for (const file of ['CHANGELOG.md', 'CHANGELOG.zh.md']) {
  const content = fs.readFileSync(path.join(ROOT, '..', file), 'utf8')
  if (!content.includes('## [' + version + ']')) fail(file + ' missing the reviewed release notes')
}
if (sh(['git', 'tag', '--list', tag])) fail('local tag already exists: ' + tag)
if (sh(['git', 'ls-remote', '--tags', '--refs', 'origin', 'refs/tags/' + tag])) fail('remote tag already exists: ' + tag)

sh(['git', 'tag', '-a', tag, '-m', 'Draft release ' + tag])
try {
  sh(['git', 'push', 'origin', tag])
} catch (err) {
  fail('tag push failed: verify remote state before retrying, NEVER delete/replace tags blindly. ' + err.message)
}
console.log('Draft release workflow triggered by ' + tag + '. This is NOT public Publish.')
