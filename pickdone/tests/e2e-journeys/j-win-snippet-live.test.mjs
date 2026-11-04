/**
 * pd20 REAL screen-capture paste chain — j-win-snippet-live.test.mjs
 * The one leg no synthetic paste event can prove: the user presses Win+Shift+S, drags a
 * region, the OS snip lands in the clipboard, they focus the app and press Ctrl+V, save,
 * reopen the panel, and RESTART the app — the image must still be there.
 *
 * Real OS input is injected via SendInput (keys + mouse drag); the app runs with real focus
 * (allowFocus) so the keystrokes land in it. This is a MANUAL live stage: it moves the real
 * mouse and takes over the real clipboard, so it never runs in a gate pool — run it only
 * with TODO_WIN_SNIPPET_LIVE=1 on a box where the desktop is interactive:
 *   TODO_WIN_SNIPPET_LIVE=1 node --test tests/e2e-journeys/j-win-snippet-live.test.mjs
 * Evidence (screenshots + assertions) lands in tests/artifacts/.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { spawnApp, stopApp, connectCdp, evalJson, send, sleep } from '../lib/runtime.mjs'

const RUN = process.env.TODO_WIN_SNIPPET_LIVE === '1'
const ART = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'artifacts')
fs.mkdirSync(ART, { recursive: true })
const storeQ = `(()=>{if(window.appUI&&window.appUI.$store)return window.appUI.$store;const a=document.getElementById('app')&&document.getElementById('app').__vue_app__;return a&&a._instance&&a._instance.proxy?a._instance.proxy.$store:null})()`

let ctx = null
const shot = async name => {
  try {
    const r = await send(ctx, 'Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(ART, name), Buffer.from(r.data, 'base64'))
  } catch { /* best-effort evidence */ }
}
const untilJson = async (expr, tries = 14, gap = 500) => {
  for (let i = 0; i < tries; i++) {
    const v = await evalJson(ctx, expr)
    if (v) return v
    await sleep(gap)
  }
  return null
}

// ---- OS input (SendInput): Win+Shift+S, drag, Ctrl+V ----
// All PowerShell runs from a written .ps1 file (-File): -Command quoting through a JS
// template is a lint/escape minefield. Button events must NOT carry the ABS flag (dx=dy=0
// with ABS would click the top-left corner) — MB() below moves nothing.
const PS_INPUT = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PDInput {
  [DllImport("user32.dll")] public static extern void SendInput(int n, INPUT[] inputs, int size);
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT m; [FieldOffset(0)] public KEYBDINPUT k; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extraInfo; }
  public const uint KEYDOWN = 0, KEYUP = 2, MOUSEMOVE = 1, LEFTDOWN = 2, LEFTUP = 4, ABS = 0x8000;
  static INPUT K(ushort vk, uint flags) { return new INPUT { type = 1, u = new InputUnion { k = new KEYBDINPUT { wVk = vk, dwFlags = flags } } }; }
  static INPUT M(int dx, int dy, uint flags) { return new INPUT { type = 0, u = new InputUnion { m = new MOUSEINPUT { dx = dx, dy = dy, dwFlags = flags | ABS } } }; }
  static INPUT MB(uint flags) { return new INPUT { type = 0, u = new InputUnion { m = new MOUSEINPUT { dx = 0, dy = 0, dwFlags = flags } } }; }
  public static void Key(ushort vk, bool up) { var i = new INPUT[] { K(vk, up ? KEYUP : KEYDOWN) }; SendInput(1, i, Marshal.SizeOf(typeof(INPUT))); }
  public static void MoveTo(int x, int y) { var i = new INPUT[] { M(x * 65535 / ScreenW(), y * 65535 / ScreenH(), MOUSEMOVE) }; SendInput(1, i, Marshal.SizeOf(typeof(INPUT))); }
  public static void Mouse(bool down) { var i = new INPUT[] { MB(down ? LEFTDOWN : LEFTUP) }; SendInput(1, i, Marshal.SizeOf(typeof(INPUT))); }
  public static int ScreenW() { return System.Windows.Forms.Screen.PrimaryScreen.Bounds.Width; }
  public static int ScreenH() { return System.Windows.Forms.Screen.PrimaryScreen.Bounds.Height; }
}
'@ -ReferencedAssemblies System.Windows.Forms,System.Drawing
function Tap($vk) { [PDInput]::Key($vk, $false); Start-Sleep -Milliseconds 60; [PDInput]::Key($vk, $true) }
`
// runPs: write the script to the artifacts dir and execute it via -File (no shell quoting)
const runPs = body => {
  const f = path.join(ART, 'pd-input.ps1')
  fs.writeFileSync(f, PS_INPUT + '\n' + body)
  return execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${f}"`, { encoding: 'utf8' }).trim()
}

test('WIN-SNIPPET live: real Win+Shift+S region snip -> Ctrl+V -> save -> reopen -> restart', { skip: !RUN ? 'manual live stage: set TODO_WIN_SNIPPET_LIVE=1 on an interactive desktop' : (process.platform !== 'win32' ? 'windows-only' : false) }, async () => {
  ctx = await spawnApp({ name: 'win-snippet-live', allowFocus: true })
  await connectCdp(ctx)
  assert.ok(await untilJson(`document.querySelectorAll('.sn-nav-item').length > 0`, 40, 1000), 'app did not boot')
  // dismiss onboarding through the authoritative store chain, then create the target task
  await evalJson(ctx, `(()=>{const s=${storeQ};return s.dispatch('settings/update',{onboardingToursSeen:{today:1,editpanel:1,pips:1}}).then(()=>'ok')})()`)
  await sleep(2500)
  await send(ctx, 'Page.reload')
  assert.ok(await untilJson(`document.querySelectorAll('.sn-nav-item').length > 0`, 40, 1000), 'app did not come back after settings reload')
  await evalJson(ctx, `(()=>{const i=document.querySelector('.qa-input');i.focus();const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,'WIN SNIP live task');i.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'})()`)
  await sleep(400)
  await evalJson(ctx, `(()=>{const i=document.querySelector('.qa-input');i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,bubbles:true}));return 'ok'})()`)
  const taskId = await untilJson(`(async () => { const rows = await window.todoAPI.dbCall('queryTodos', { deleted: 0 }); const hit = rows.find(r => r.taskContent === 'WIN SNIP live task'); return hit ? hit.taskId : null })()`)
  assert.ok(taskId, 'the target task was not created')

  // focus the app, open the edit panel, focus the description editor (the real paste target)
  await shot('win-snip-1-boot.png')
  const rowSel = `[...document.querySelectorAll('.td-item')].find(el => el.textContent.includes('WIN SNIP live task'))`
  assert.ok(await untilJson(`!!(${rowSel})`, 10, 500), 'the task row is not visible on the today list')
  await evalJson(ctx, `(()=>{const el=(${rowSel});el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));return 'ok'})()`)
  assert.ok(await untilJson(`!!document.querySelector('.edit-panel')`, 8, 600), 'the edit panel did not open')
  // the description editor is the paste target
  await evalJson(ctx, `(()=>{const el=document.querySelector('.edit-panel textarea, .edit-panel [contenteditable], .ep-desc-input');if(el){el.focus()};return 'focused'})()`)

  // REAL Win+Shift+S -> drag a region -> the OS puts the snip on the clipboard
  const clip = runPs(String.raw`
[PDInput]::Key(0x5B, $false); [PDInput]::Key(0x2B, $false); Tap 0x53; [PDInput]::Key(0x2B, $true); [PDInput]::Key(0x5B, $true);
Start-Sleep -Milliseconds 2500;
[PDInput]::MoveTo(300,300); Start-Sleep -Milliseconds 200; [PDInput]::Mouse($true); Start-Sleep -Milliseconds 120;
[PDInput]::MoveTo(900,650); Start-Sleep -Milliseconds 120; [PDInput]::Mouse($false);
Start-Sleep -Milliseconds 3000;
Add-Type -AssemblyName System.Windows.Forms;
$img = [System.Windows.Forms.Clipboard]::GetImage();
if ($img) { 'CLIP-IMAGE:' + $img.Width + 'x' + $img.Height } else { 'CLIP-EMPTY' }`)
  assert.ok(clip.startsWith('CLIP-IMAGE:'), 'the OS snip did not land an image on the clipboard: ' + clip)

  // focus the app window again (the snip overlay stole focus) and REALLY press Ctrl+V
  runPs(String.raw`
$sig = '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);'
Add-Type -MemberDefinition $sig -Name FG -Namespace W;
$p = Get-Process | Where-Object { $_.MainWindowTitle -like '*PickDone*' -or $_.MainWindowTitle -like '*拾事*' } | Select-Object -First 1;
if ($p) { [W.FG]::SetForegroundWindow($p.MainWindowHandle) | Out-Null };
Start-Sleep -Milliseconds 800;
[System.Windows.Forms.SendKeys]::SendWait('^v');
'sent'`)
  await sleep(2500)
  await shot('win-snip-2-pasted.png')
  // the REAL upload chain must have landed a local:// entry in the task image field
  const pasted = await untilJson(`(async () => {
    const rows = await window.todoAPI.dbCall('queryTodos', { deleted: 0 })
    const hit = rows.find(r => r.taskId === ${JSON.stringify(taskId)})
    const img = hit && hit.taskImage ? hit.taskImage : (hit && hit.image ? hit.image : '')
    return (img && String(img).startsWith('local://')) ? img : null
  })()`)
  assert.ok(pasted, 'the real Ctrl+V never landed a local:// image entry on the task')
  // save through the panel's own save path (the description save queue), then REOPEN
  await evalJson(ctx, `(()=>{const b=document.querySelector('.edit-panel .ep-save, .edit-panel [class*=save]');if(b){b.click();return 'ok'};return 'no-save-btn'})()`)
  await sleep(2000)
  await evalJson(ctx, `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
  await sleep(1500)
  await evalJson(ctx, `(()=>{const el=(${rowSel});if(el){el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))};return 'ok'})()`)
  await sleep(1500)
  const afterReopen = await untilJson(`(async () => {
    const rows = await window.todoAPI.dbCall('queryTodos', { deleted: 0 })
    const hit = rows.find(r => r.taskId === ${JSON.stringify(taskId)})
    const img = hit && hit.taskImage ? hit.taskImage : (hit && hit.image ? hit.image : '')
    return (img && String(img).startsWith('local://')) ? img : null
  })()`)
  assert.equal(afterReopen, pasted, 'the image entry changed after close/reopen')
  await shot('win-snip-3-reopen.png')
  // RESTART: real process stop -> respawn on the same userDataDir
  const dir = ctx.userDataDir
  await stopApp(ctx)
  ctx = await spawnApp({ name: 'win-snippet-live-restart', userDataDir: dir, allowFocus: true })
  await connectCdp(ctx)
  assert.ok(await untilJson(`document.querySelectorAll('.sn-nav-item').length > 0`, 40, 1000), 'app did not come back')
  const afterRestart = await untilJson(`(async () => {
    const rows = await window.todoAPI.dbCall('queryTodos', { deleted: 0 })
    const hit = rows.find(r => r.taskId === ${JSON.stringify(taskId)})
    const img = hit && hit.taskImage ? hit.taskImage : (hit && hit.image ? hit.image : '')
    return (img && String(img).startsWith('local://')) ? img : null
  })()`)
  assert.equal(afterRestart, pasted, 'the pasted image did not survive a real app restart')
  await shot('win-snip-4-restart.png')
})

after(async () => { try { if (ctx) await stopApp(ctx) } catch {} })
