#!/usr/bin/env node
/**
 * Media language-pairing gate (SOP-05 §5, 2026-09-06 mixing-language audit follow-up).
 *
 * The English README once embedded a split-screen demo gif captured on a Chinese-UI app
 * window (the zh variant lived beside it under a -zh suffix). Images cannot be language-
 * checked automatically, so the enforceable rule is a naming/namespace convention:
 *
 *   - README.md (the ENGLISH surface) may only reference media under docs/media/en/
 *     or carrying an `-en`/`.en`/`_en` marker in its filename/parent dir.
 *   - No English-surface reference may point at zh/cn-marked media.
 *   - Every referenced media file must exist on disk (both READMEs).
 *
 * Chinese-side references are free-form (zh assets live both at docs/media root and in
 * platform-named dirs), so only existence is checked there.
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..', '..')
const README_EN = path.join(ROOT, 'README.md')
const README_ZH = path.join(ROOT, 'README.zh-CN.md')

function mediaRefs (file) {
  if (!fs.existsSync(file)) return []
  const src = fs.readFileSync(file, 'utf8')
  const refs = []
  const md = /!\[[^\]]*\]\(([^)\s]+)\)|<img[^>]+src=["']([^"']+)["']/g
  let m
  while ((m = md.exec(src))) refs.push(m[1] || m[2])
  return refs
}

const problems = []
for (const [file, isEn] of [[README_EN, true], [README_ZH, false]]) {
  for (const ref of mediaRefs(file)) {
    if (/^(https?:)?\/\//.test(ref)) continue // remote assets are out of scope
    const abs = path.resolve(ROOT, ref)
    if (!fs.existsSync(abs)) { problems.push(`missing file: ${ref} (referenced by ${path.basename(file)})`); continue }
    if (!isEn) continue
    const enMarked = /(?:^|\/)en(?:\/|[-_.])|[-_.]en[.\-/]/i.test(ref)
    if (!enMarked) problems.push(`EN README references non-en-marked media: ${ref} — put it under docs/media/en/ or add an -en suffix (SOP-05 §5)`)
    if (/zh|cn/i.test(path.basename(ref))) problems.push(`EN README references zh/cn-marked media: ${ref}`)
  }
}

if (problems.length) {
  console.error('[check-media-lang] FAIL')
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}
console.log('[check-media-lang] OK (README media language-pairing + existence)')
