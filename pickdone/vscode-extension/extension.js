/**
 * PickDone VS Code extension — MVP (PD20, 2026-11-08).
 *
 * Security contract (mirrors the browser extension's door, NEVER bypassed):
 *   - loopback endpoint only: the configured endpoint host must be 127.0.0.1/localhost;
 *     anything else is refused before a single request is built.
 *   - the access key lives in VS Code SecretStorage (never settings.json, never disk);
 *     every request carries it as the X-PickDone-Key handshake header (fail closed: a
 *     missing key refuses the command instead of firing an anonymous request).
 *   - no private code collection: SourceRef payloads carry ONLY a repo-relative path and
 *     a git commit sha — never file contents (the desktop door rejects content-bearing
 *     payloads anyway; see capture-endpoint/handlers.js linkSource).
 *   - revocation: 'PickDone: Revoke Access Key' deletes the stored key and thereby ends
 *     every capability (the desktop side can also regenerate its key in settings, which
 *     invalidates this one on the next request).
 */
const vscode = require('vscode')
const crypto = require('crypto')
const { execFile } = require('child_process')
const path = require('path')

const KEY_HEADER = 'X-PickDone-Key'
const SECRET_KEY = 'pickdone.captureKey'
const MAX_TASKS_SHOWN = 200

function isLoopback (endpoint) {
  try {
    const u = new URL(endpoint)
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')
  } catch {
    return false
  }
}

function endpointBase () {
  const cfg = vscode.workspace.getConfiguration('pickdone').get('endpoint') || 'http://127.0.0.1:7789'
  if (!isLoopback(cfg)) throw new Error('PickDone: endpoint must be a loopback http:// URL (refused: ' + cfg + ')')
  return cfg.replace(/\/+$/, '')
}

async function request (context, method, path, body = null) {
  const key = await context.secrets.get(SECRET_KEY)
  if (!key) throw new Error('PickDone is not paired: set the access key first ("PickDone: Set Access Key"). Refusing to talk to the door without it.')
  const res = await fetch(endpointBase() + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, { [KEY_HEADER]: key }),
    body: body == null ? undefined : JSON.stringify(body)
  })
  let json = null
  try { json = await res.json() } catch { /* non-JSON error body */ }
  if (res.status === 401) throw new Error('PickDone rejected the access key (401): regenerate it in PickDone settings and set it again.')
  if (res.status === 503) throw new Error('PickDone capture door is disabled (503): enable it in PickDone settings first.')
  if (!res.ok) throw new Error('PickDone door answered ' + res.status + (json && json.error ? ': ' + json.error : ''))
  return json
}

function git (cwd, args) {
  return new Promise(resolve => {
    execFile('git', args, { cwd, timeout: 5000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim())
    })
  })
}

function activate (context) {
  const requireKey = async () => {
    const key = await context.secrets.get(SECRET_KEY)
    if (!key) {
      const picked = await vscode.window.showErrorMessage('PickDone is not paired: no access key stored.', 'Set Access Key')
      if (picked) await vscode.commands.executeCommand('pickdone.setKey')
      return null
    }
    return key
  }

  context.subscriptions.push(vscode.commands.registerCommand('pickdone.setKey', async () => {
    const key = await vscode.window.showInputBox({
      prompt: 'Paste the PickDone capture access key (Settings → Capture endpoint). Stored in VS Code SecretStorage only.',
      password: true,
      ignoreFocusOut: true
    })
    if (key && key.trim()) await context.secrets.store(SECRET_KEY, key.trim())
  }))

  context.subscriptions.push(vscode.commands.registerCommand('pickdone.revokeKey', async () => {
    await context.secrets.delete(SECRET_KEY)
    vscode.window.showInformationMessage('PickDone access key revoked from this machine.')
  }))

  context.subscriptions.push(vscode.commands.registerCommand('pickdone.listTasks', async () => {
    if (!await requireKey()) return
    try {
      const tasks = await request(context, 'GET', '/tasks')
      if (!tasks.length) { vscode.window.showInformationMessage('PickDone: no open tasks.'); return }
      const picked = await vscode.window.showQuickPick(tasks.slice(0, MAX_TASKS_SHOWN).map(t => ({
        label: t.content.length > 90 ? t.content.slice(0, 90) + '…' : t.content,
        description: t.complete ? 'done' : '',
        detail: 'task ' + t.taskId,
        taskId: t.taskId
      })), { placeHolder: 'PickDone open tasks' })
      if (picked) await vscode.commands.executeCommand('pickdone.showHandoff', picked.taskId)
    } catch (e) {
      vscode.window.showErrorMessage(String(e.message || e))
    }
  }))

  context.subscriptions.push(vscode.commands.registerCommand('pickdone.listProjects', async () => {
    if (!await requireKey()) return
    try {
      const projects = await request(context, 'GET', '/projects')
      if (!projects.length) { vscode.window.showInformationMessage('PickDone: no projects.'); return }
      const picked = await vscode.window.showQuickPick(projects.map(p => ({ label: p.name, categoryId: p.categoryId })), { placeHolder: 'PickDone projects' })
      if (picked) {
        const tasks = await request(context, 'GET', '/tasks')
        const inProject = tasks.filter(t => t.categoryId === picked.categoryId)
        vscode.window.showQuickPick(inProject.map(t => t.content) , { placeHolder: picked.label + ': ' + inProject.length + ' open task(s)' })
      }
    } catch (e) {
      vscode.window.showErrorMessage(String(e.message || e))
    }
  }))

  context.subscriptions.push(vscode.commands.registerCommand('pickdone.linkSource', async () => {
    if (!await requireKey()) return
    const editor = vscode.window.activeTextEditor
    if (!editor) { vscode.window.showErrorMessage('PickDone: open a file first.'); return }
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri)
    if (!workspaceFolder) { vscode.window.showErrorMessage('PickDone: the file is not inside a workspace folder.'); return }
    try {
      const tasks = await request(context, 'GET', '/tasks')
      if (!tasks.length) { vscode.window.showInformationMessage('PickDone: no open tasks to link to.'); return }
      const picked = await vscode.window.showQuickPick(tasks.slice(0, MAX_TASKS_SHOWN).map(t => ({
        label: t.content.length > 90 ? t.content.slice(0, 90) + '…' : t.content,
        taskId: t.taskId
      })), { placeHolder: 'Link this file/commit to which PickDone task?' })
      if (!picked) return
      // privacy: repo-relative path + commit sha ONLY — never the file content
      const relPath = path.relative(workspaceFolder.uri.fsPath, editor.document.uri.fsPath).replace(/\\/g, '/')
      const commit = await git(workspaceFolder.uri.fsPath, ['rev-parse', 'HEAD'])
      const payload = {
        taskId: picked.taskId,
        canonicalUri: 'file:///' + relPath,
        sourceTitle: relPath,
        externalId: commit ? 'git:' + relPath + ':' + commit.slice(0, 12) : 'file:///' + relPath
      }
      await request(context, 'POST', '/link-source', payload)
      vscode.window.showInformationMessage('PickDone: linked ' + relPath + (commit ? ' @ ' + commit.slice(0, 8) : '') + ' → ' + picked.label)
    } catch (e) {
      vscode.window.showErrorMessage(String(e.message || e))
    }
  }))

  context.subscriptions.push(vscode.commands.registerCommand('pickdone.showHandoff', async (taskIdArg) => {
    if (!await requireKey()) return
    let taskId = taskIdArg
    if (!taskId) {
      const tasks = await request(context, 'GET', '/tasks')
      if (!tasks.length) { vscode.window.showInformationMessage('PickDone: no open tasks.'); return }
      const picked = await vscode.window.showQuickPick(tasks.slice(0, MAX_TASKS_SHOWN).map(t => ({
        label: t.content.length > 90 ? t.content.slice(0, 90) + '…' : t.content,
        taskId: t.taskId
      })), { placeHolder: 'Show handoff for which task?' })
      if (!picked) return
      taskId = picked.taskId
    }
    try {
      const h = await request(context, 'GET', '/handoff?taskId=' + encodeURIComponent(taskId))
      const doc = await vscode.workspace.openTextDocument({ content: (h && h.text) || '', language: 'markdown' })
      await vscode.window.showTextDocument(doc, { preview: true })
    } catch (e) {
      vscode.window.showErrorMessage(String(e.message || e))
    }
  }))
}

function deactivate () {}

module.exports = { activate, deactivate, isLoopback }
