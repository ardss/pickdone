#!/usr/bin/env node
/**
 * 提交身份门禁（SOP-02 §7）——公开仓的提交元数据不得携带个人身份。
 * 事故(2026-09-06):文本脱敏全绿,但 HEAD 提交作者邮箱是个人 QQ 邮箱,转公开即暴露。
 * 规则:最近 10 个提交的 author/committer 邮箱命中个人邮箱形态 = 红;GitHub noreply 形态 = 绿。
 * W21 (2026-10-30) 两处加固:
 *   1) 分隔符 `|` → ASCII 单元分隔符 %x1f（user.name 里带 `|` 可把字段打穿/错位出假绿）。
 *   2) 只查 HEAD 单提交 → 本地兜底逐提交扫最近 10 个（`git log -10`），单次误配置的
 *      脏提交藏进历史也能点名。
 * W28 (2026-11-01) 两处加固:
 *   1) 个人邮箱正则锚在域名末段，只匹配裸顶级域——`user@vip.qq.com` / `user@mail.163.com`
 *      子域形态整体逃逸（同构事故：文本脱敏绿、元数据漏）。改为允许任意深的子域链，
 *      域后缀仍须命中个人邮箱域白名单。
 *   2) git 子进程剥离 hook 注入的 GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE（共享
 *      lib-git-env.cjs，同 check-file-size/check-boot-order 的 W18 修复）。
 */
const { execFileSync } = require('child_process')
const ROOT = require('path').join(__dirname, '..')
// W28 fix(#2): git 子进程剥离 hook 注入的 GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE（同
// check-file-size/check-boot-order 的 W18 修复与 cli/lib-git-env.cjs 共享实现）。此处内联而非
// require 共享文件：本门禁是单文件自包含契约——tests/unit/cli/w21-gate-fixes.test.mjs 把它
// 单文件拷进 fixture 仓运行（无 GATE_ROOT,ROOT 由 __dirname 推导），多文件依赖会 MODULE_NOT_FOUND。
const gitEnv = () => {
  const e = { ...process.env }
  delete e.GIT_DIR; delete e.GIT_WORK_TREE; delete e.GIT_INDEX_FILE
  return e
}
const git = a => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', env: gitEnv() })
const PERSONAL = /@(?:[a-z0-9-]+\.)*(?:qq|foxmail|163|126|sina|gmail|outlook|hotmail|yahoo)\.(?:com|net|cn)$/i
const SEP = '\x1f' // %x1f: user.name/user.email cannot legally contain a unit separator

module.exports = { PERSONAL }

if (require.main !== module) return

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
