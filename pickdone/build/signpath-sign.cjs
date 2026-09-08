/** SignPath custom signing hook (electron-builder `win.sign`).
 *  预埋给 SignPath Foundation 的免费开源签名(https://signpath.org)。
 *  用法:仓库 Secrets 配置 SIGNPATH_API_TOKEN + SIGNPATH_ORGANIZATION_ID 后,
 *  打包期每个待签 exe(应用/卸载器/安装器)自动送签并回写;未配置时本钩子是
 *  no-op,发布保持现状(不签名)。
 *  签名必须发生在打包管线内——latest.yml 的 sha512 在此之后计算,事后替换
 *  签名文件会导致全量用户自动更新哈希校验失败。
 *  API: https://signpath.io/docs (submit signing request → poll → download)。
 *  注意:Foundation 批准并建项目后,ProjectKey/SigningPolicyKey 按其分配值核对。 */
const crypto = require('crypto')

const API_BASE = 'https://app.signpath.io/api/v1'
const PROJECT_KEY = process.env.SIGNPATH_PROJECT_KEY || 'PickDone'
const POLICY_KEY = process.env.SIGNPATH_SIGNING_POLICY_KEY || 'release'
const POLL_INTERVAL_MS = 10 * 1000
const TIMEOUT_MS = 10 * 60 * 1000

async function submitAndAwaitSigned (orgId, token, filePath) {
  const auth = { Authorization: `Bearer ${token}` }
  const artifact = new Uint8Array(require('fs').readFileSync(filePath))
  const form = new FormData()
  form.append('ProjectKey', PROJECT_KEY)
  form.append('SigningPolicyKey', POLICY_KEY)
  form.append('Description', `PickDone ${path.basename(filePath)}`)
  form.append('Artifact', new Blob([artifact]), path.basename(filePath))

  const submit = await fetch(`${API_BASE}/${orgId}/signing-requests?projectKey=${encodeURIComponent(PROJECT_KEY)}&signingPolicyKey=${encodeURIComponent(POLICY_KEY)}`, {
    method: 'POST', headers: { Authorization: auth.Authorization }, body: form
  })
  if (!submit.ok) throw new Error(`SignPath submit failed: HTTP ${submit.status} ${await submit.text().catch(() => '')}`)
  const requestId = (await submit.text()).replace(/"/g, '').trim()

  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    const poll = await fetch(`${API_BASE}/${orgId}/signing-requests/${requestId}`, { headers: auth })
    if (!poll.ok) throw new Error(`SignPath poll failed: HTTP ${poll.status}`)
    const { Status: status } = await poll.json()
    if (status === 'Failed') throw new Error(`SignPath rejected signing request ${requestId} — check the signing policy and artifact configuration`)
    if (status === 'Completed') {
      const signed = await fetch(`${API_BASE}/${orgId}/signing-requests/${requestId}/SignedArtifact`, { headers: auth })
      if (!signed.ok) throw new Error(`SignPath download failed: HTTP ${signed.status}`)
      return Buffer.from(await signed.arrayBuffer())
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error(`SignPath signing timed out after ${TIMEOUT_MS / 60000} min (request ${requestId})`)
}

module.exports = async function sign (configuration) {
  const token = process.env.SIGNPATH_API_TOKEN
  const orgId = process.env.SIGNPATH_ORGANIZATION_ID
  if (!token || !orgId) return // secrets 未配置:保持未签名现状,绝不阻塞发布
  const file = configuration.path
  const before = crypto.createHash('sha256').update(require('fs').readFileSync(file)).digest('hex')
  const signed = await submitAndAwaitSigned(orgId, token, file)
  require('fs').writeFileSync(file, signed)
  const after = crypto.createHash('sha256').update(signed).digest('hex')
  console.log(`[signpath] signed ${path.basename(file)} (sha256 ${before.slice(0, 12)}… → ${after.slice(0, 12)}…)`)
}
