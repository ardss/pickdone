import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Regression for the 0.3.0 in-app update failure ("restart to update" silently did
// nothing): customInit killed the app with `taskkill /T`, but electron-updater spawns
// the installer as a CHILD of the running app, so the tree-walk terminated the installer
// itself before the install section ever ran. Proven empirically on 2026-09-10:
// taskkill reported "terminated PID <installer> (child of PID <app>)".
// Guard: the pre-flight kill must stay image-name based (/IM ... /F) and never carry /T.

const here = path.dirname(fileURLToPath(import.meta.url))
const nsh = fs.readFileSync(path.join(here, '..', 'build', 'installer.nsh'), 'utf8')

test('customInit/customUnInit kill both historic product images (via the KillRunningInstance macro)', () => {
  assert.match(nsh, /!macro KillRunningInstance IMAGE ID[\s\S]*?taskkill \/IM "\$\{IMAGE\}" \/F/, 'the kill macro must use an image-name /F taskkill')
  assert.match(nsh, /!macro customInit[\s\S]*?!insertmacro KillRunningInstance "PickDone\.exe"/, 'customInit must kill PickDone.exe')
  assert.match(nsh, /!macro customInit[\s\S]*?!insertmacro KillRunningInstance "拾事\.exe"/, 'customInit must kill the <=0.2.1 image 拾事.exe')
  assert.match(nsh, /!macro customUnInit[\s\S]*?!insertmacro KillRunningInstance "PickDone\.exe"/, 'customUnInit must kill PickDone.exe')
  // Kill-failure visibility (2026-09-10 review P2): 0=terminated, 128=no process; anything else must
  // surface a MessageBox (no /SD so silent installs see it) and Abort before touching files.
  assert.match(nsh, /StrCmp \$R0 "0" /, 'exit code 0 must pass')
  assert.match(nsh, /StrCmp \$R0 "128" /, 'exit code 128 (no matching process) must pass')
  assert.match(nsh, /MessageBox MB_OK\|MB_ICONEXCLAMATION[\s\S]*?Abort/, 'other exit codes must surface a message and abort')
})

test('no taskkill line may carry /T — tree-kill reaches the updater-spawned installer and aborts the update', () => {
  const offenders = nsh.split('\n').filter(l => /taskkill/i.test(l) && /\/T(\s|$)/.test(l))
  assert.deepEqual(offenders, [], `taskkill /T found — the updater spawns this installer as a child of the app, /T walks the tree into us:\n${offenders.join('\n')}`)
})

test('post-kill settle window stays (file handles release before the install section)', () => {
  assert.match(nsh, /Sleep 800/, 'Sleep 800 after taskkill must stay')
})
