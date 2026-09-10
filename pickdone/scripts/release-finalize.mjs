#!/usr/bin/env node
/**
 * 发版收尾(与 scripts/release.mjs 配对):
 *   npm run release:finalize X.Y.Z
 * 代码化 SOP-06 的"人工三查",并自动完成其中两查:
 *   1. Release 工作流已 success(未完=提示等待;失败=给出日志入口)
 *   2. draft 存在且四产物齐(Setup/Portable/latest.yml/SHA256SUMS)
 *   3. 正文非空——为空则自动从 CHANGELOG [X.Y.Z] 段提取填入
 * 剩下唯一人工动作:Releases 页面过目后点 Publish。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const sh = (cmd) => execFileSync(cmd[0], cmd.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const die = msg => { console.error('✗ finalize: ' + msg); process.exit(1) }
const say = msg => console.log('• ' + msg)
// owner/repo derived from the actual origin remote instead of hardcoded, so a repo rename/transfer (or a
// fork checkout) keeps working; fall back to the historical location when git/origin is unavailable.
// Covers https://github.com/owner/repo(.git) and git@github.com:owner/repo(.git); anything more exotic
// (ssh:// with a port) fails to parse and lands on the fallback too.
function repoFromOrigin () {
  try {
    const url = sh(['git', 'remote', 'get-url', 'origin'])
    const m = url.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i)
    return m ? `${m[1]}/${m[2]}` : null
  } catch { return null }
}
const REPO = repoFromOrigin() || 'ardss/pickdone'
const ghApi = (path) => sh(['gh', 'api', path])           // api 调用:repo 写在路径里
const gh = (args) => sh(['gh', ...args, '--repo', REPO])  // 人类命令(release view/edit 等)

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+$/.test(version || '')) die('用法: npm run release:finalize X.Y.Z')
const TAG = 'v' + version

// 1. 工作流状态
// Match runs by workflow FILE name (release.yml), not the human display name: renaming `name:` in the
// YAML used to silently break an `r.name === 'Release'` match and made finalize a no-op. The
// workflows/release.yml/runs endpoint is the API equivalent of `gh run list --workflow release.yml`.
const runs = JSON.parse(ghApi(`repos/${REPO}/actions/workflows/release.yml/runs?per_page=10`))
const run = (runs.workflow_runs || []).find(r => r.head_branch === TAG)
if (!run) die(`${TAG} 的 Release 工作流不存在——tag 推了吗?`)
if (run.status !== 'completed') die(`工作流还在 ${run.status}——稍等再跑 finalize`)
if (run.conclusion !== 'success') die(`工作流结论 ${run.conclusion}——修 main 重发(见 SOP-06 §2.4),日志: gh run view ${run.id} --log-failed`)
say(`工作流 success(run ${run.id})`)

// 2. draft + 四产物
// 草稿态 release 不在 tags 端点下(tag 未落)——从列表按 tag_name 匹配
const rel = JSON.parse(ghApi(`repos/${REPO}/releases?per_page=20`)).find(r => r.tag_name === TAG)
if (!rel) die(`${TAG} 无 release 条目——工作流失败或产物未上传`)
if (!rel.draft) { say('已发布状态——finalize 无事可做'); process.exit(0) }
const names = (rel.assets || []).map(a => a.name)
for (const need of [`PickDone-Setup-${version}.exe`, `PickDone-Portable-${version}.exe`, 'latest.yml', 'SHA256SUMS.txt']) {
  if (!names.includes(need)) die(`产物缺件: ${need}(现有: ${names.join(', ')})`)
}
say(`四产物齐全(${names.length} 个 assets)`)

// 3. 正文非空——空则自动从 CHANGELOG 提取(双语:CHANGELOG.zh.md 中文段在前,缺中文降级单语并告警)
if ((rel.body || '').trim().length < 30) {
  const extract = (file, ver) => {
    if (!fs.existsSync(file)) return null
    const m = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').match(new RegExp(`## \\[${ver}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n## \\[)`))
    return (m && m[1].trim()) ? m[1].trim() : null
  }
  const en = extract(path.join(ROOT, '..', 'CHANGELOG.md'), version)
  if (!en) die(`CHANGELOG 缺 [${version}] 段正文,请手工填写 release notes`)
  const zh = extract(path.join(ROOT, '..', 'CHANGELOG.zh.md'), version)
  const body = zh ? (zh + '\n\n---\n\n' + en) : en
  if (!zh) say('WARNING: CHANGELOG.zh.md 无对应段——本次发布单语(英文),补中文版属流程违规')
  const tmp = path.join(os.tmpdir(), `rel-notes-${version}.md`)
  fs.writeFileSync(tmp, "## What's Changed\n\n" + body + '\n')
  gh(['release', 'edit', TAG, '--notes-file', tmp])
  say(`正文为空,已自动从 CHANGELOG 填入(${body.length} 字符${zh ? ',双语' : ',仅英文'})`)
} else {
  say(`正文已有(${(rel.body || '').length} 字符)`)
}

// 4. 标题规范
if (rel.name !== `PickDone ${version}`) {
  gh(['release', 'edit', TAG, '--title', `PickDone ${version}`])
  say(`标题统一为 PickDone ${version}`)
}

console.log(`
✓ finalize 完成。剩最后一步(刻意保留人工): 
  gh release view ${TAG} --repo ${REPO}   # 过目正文与产物
  gh release edit ${TAG} --repo ${REPO} --draft=false   # 或网页上点 Publish
`)
