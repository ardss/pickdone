#!/usr/bin/env node
/**
 * 提交身份门禁（SOP-02 §7）——公开仓的提交元数据不得携带个人身份。
 * 事故(2026-09-06):文本脱敏全绿,但 HEAD 提交作者邮箱是个人 QQ 邮箱,转公开即暴露。
 * 规则:最近 10 个提交的 author/committer 邮箱命中个人邮箱形态 = 红;GitHub noreply 形态 = 绿。
 * W21 (2026-10-30) 两处加固:
 *   1) 分隔符 `|` → ASCII 单元分隔符 %x1f（user.name 里带 `|` 可把字段打穿/错位出假绿）。
 *   2) 只查 HEAD 单提交 → 本地兜底逐提交扫最近 10 个（`git log -10`），单次误配置的
 *      脏提交藏进历史也能点名。
 */
const { execFileSync } = require('child_process')
const ROOT = require('path').join(__dirname, '..')
const git = a => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' })
const PERSONAL = /@(qq|foxmail|163|126|sina|gmail|outlook|hotmail|yahoo)\.(com|net|cn)$/i
const SEP = '\x1f' // %x1f: user.name/user.email cannot legally contain a unit separator
const out = git(['log', '-10', '--format=%an' + SEP + '%ae' + SEP + '%cn' + SEP + '%ce'])
const bad = []
for (const line of out.split('\n')) {
  if (!line) continue
  const [an, ae, , ce] = line.split(SEP)
  if ([ae, ce].some(e => PERSONAL.test(e || ''))) bad.push({ an, ae, ce })
}
if (bad.length) {
  console.error(`✗ 提交身份门禁:最近 10 个提交中 ${bad.length} 个的 author/committer 邮箱是个人邮箱（首个 HEAD(author=${bad[0].an}): ${[...new Set(bad.flatMap(b => [b.ae, b.ce]))].filter(e => PERSONAL.test(e)).join(',')}）——公开仓一律用 GitHub noreply`)
  console.error('  修复: git config user.email "92158419+ardss@users.noreply.github.com" && 对涉事提交 rebase --reset-author 后强推')
  process.exit(1)
}
const [headAn, headAe] = out.split('\n')[0].split(SEP)
console.log(`✓ 提交身份(最近 10 提交, HEAD ${headAn} <${headAe}>)不含个人邮箱`)
