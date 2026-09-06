#!/usr/bin/env node
/**
 * 提交身份门禁（SOP-02 §7）——公开仓的提交元数据不得携带个人身份。
 * 事故(2026-09-06):文本脱敏全绿,但 HEAD 提交作者邮箱是个人 QQ 邮箱,转公开即暴露。
 * 规则:HEAD 的 author/committer 邮箱命中个人邮箱形态 = 红;GitHub noreply 形态 = 绿。
 */
const { execFileSync } = require('child_process')
const ROOT = require('path').join(__dirname, '..')
const git = a => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim()
const PERSONAL = /@(qq|foxmail|163|126|sina|gmail|outlook|hotmail|yahoo)\.(com|net|cn)$/i
const out = git(['log', '-1', '--format=%an|%ae|%cn|%ce'])
const [an, ae, cn, ce] = out.split('|')
const bad = [ae, ce].filter(e => PERSONAL.test(e))
if (bad.length) {
  console.error(`✗ 提交身份门禁:HEAD(${an}) 的提交邮箱是个人邮箱(${[...new Set(bad)].join(',')})——公开仓一律用 GitHub noreply`)
  console.error('  修复: git config user.email "92158419+ardss@users.noreply.github.com" && git commit --amend --reset-author --no-edit && 强推')
  process.exit(1)
}
console.log(`✓ 提交身份(${an} <${ae}>)不含个人邮箱`)
