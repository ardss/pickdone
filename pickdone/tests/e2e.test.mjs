/**
 * End-to-end tests - drive the really running app via CDP (electron . --no-focus --remote-debugging-port=9333).
 * Covers user flows corresponding to real pre-release incidents: settings modal opening (unclosed template div incident),
 * tab underline alignment (EP nth-child(2)/last-child misalignment), and the quick-add full lifecycle.
 * The whole group SKIPs when the app has no debug port; the gate spawns its own instance via run-interactions-gated (eliminating skip=pass). Run: npm run test:e2e
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const CDP = process.env.TODO_CDP || 'http://127.0.0.1:9333'

// 隔离门:附着实例必须是隔离数据目录(启动时注入 TODO_USER_DATA_DIR,preload 暴露 isDataIsolated),
// 否则本组用例的增删改会落在真实用户库上。安全附着方式: npm run app:dev -- --remote-debugging-port=9333
let available = false
let isolated = false
try {
  const list = await (await fetch(CDP + '/json', { signal: AbortSignal.timeout(1500) })).json()
  const page = list.find(t => t.type === 'page' && !t.url.includes('__tomato-float'))
  available = !!page
  if (page) {
    const ws2 = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws2.onopen = res; ws2.onerror = rej })
    const env = await new Promise(res => {
      ws2.onmessage = e => { const m = JSON.parse(e.data); if (m.id === 1) res(m.result?.result?.value) }
      ws2.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'JSON.stringify({iso: !!(window.todoAPI && window.todoAPI.isDataIsolated)})', returnByValue: true } }))
      setTimeout(() => res(null), 3000)
    })
    try { ws2.close() } catch {}
    try { isolated = JSON.parse(env).iso === true } catch { isolated = false }
  }
} catch { /* no debug port */ }

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Watchdog: WS handles keep the event loop alive; force-exit after 120s no matter what (results are already on stderr/stdout)
const watchdog = setTimeout(() => { console.error('E2E watchdog forced exit (counted as failure)'); try { ws?.close() } catch {} process.exit(1) }, 120000)
watchdog.unref?.()
process.on('exit', () => { try { ws?.close() } catch {} })

let ws = null
let id = 0
const pending = new Map()
const send = (method, params = {}) => new Promise(res => {
  const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }))
})
const evalJson = async expression => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: `(async () => JSON.stringify(await (${expression})))()`, returnByValue: true, awaitPromise: true }),
    sleep(10000).then(() => null)
  ])
  return r ? JSON.parse(r.result?.result?.value ?? 'null') : null
}

test('E2E precondition: connect CDP and wait for the app to be ready', { skip: !available ? 'no debug port on ' + CDP : (!isolated ? 'attached instance is NOT data-isolated; refusing writes on real user data' : false) }, async () => {
  const targets = await (await fetch(CDP + '/json')).json()
  // Exclude the pomodoro float (the 132x44 index.html#/__tomato-float page once stole the match and sent every assertion sideways)
  const page = targets.find(t => t.type === 'page' && !t.url.includes('__tomato-float') && /#\/todo-list/.test(t.url)) ||
    targets.find(t => t.type === 'page' && t.url.includes('index.html') && !t.url.includes('__tomato-float'))
  assert.ok(page, 'no page target')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
  await send('Runtime.enable'); await send('Page.enable')
  // Locale pin: assertions target the en-US surface — pin before any text-dependent check (CI runners boot en, dev boxes zh)
  await send('Runtime.evaluate', { expression: "try{localStorage.setItem('appLocale','en-US');localStorage.setItem('onboardingToursSeen', JSON.stringify({today:1,editpanel:1}))}catch(e){}" })
  await send('Page.reload', { ignoreCache: true })
  let booted = false
  for (let i = 0; i < 30 && !booted; i++) {
    booted = (await evalJson('document.querySelectorAll(".sn-nav-item").length')) > 0
    if (!booted) await sleep(1000)
  }
  assert.ok(booted, 'the app did not finish booting within 30s')
})

test('E2E: settings modal opens (regression: an unclosed template div once broke it plus all page clicks)', { skip: !available || !isolated }, async () => {
  await evalJson(`document.querySelector('.sn-account-gear:not(.sn-account-trash)')?.click()`)
  // Poll for the modal to mount (a first-launch instance may still be initializing; a single evaluation can time out)
  let st = null
  for (let i = 0; i < 10 && !st; i++) {
    await sleep(1000)
    st = await evalJson(`({
      open: !!document.querySelector('.modal-container--settings'),
      tabs: [...document.querySelectorAll('.setting_tabs .el-tabs__item')].map(e => e.textContent.trim())
    })`)
  }
  assert.ok(st, 'modal state evaluation timed out')
  assert.equal(st.open, true, 'the settings modal did not appear')
  // The widget tab was removed in an earlier iteration - this assertion rotted unnoticed while e2e was out of the gate (now wired into check:all it cannot rot again)
  // 关于 tab added (2282a78): standalone About+Feedback tab, appended before 数据管理
  assert.deepEqual(st.tabs, ['General', 'Appearance', 'Calendar', 'Shortcuts', 'Pomodoro', 'Data Management', 'Feedback & About'])
})

test('E2E: settings tab underline strictly aligns with text (regression: EP nth-child(2)/last-child padding misalignment)', { skip: !available || !isolated }, async () => {
  // f6ff114 起弃用 EP 移动条(el-tabs__active-bar display:none),改用活动页签自身 ::after;
  // 设置弹窗为左导航竖排版式,下划线是页签左缘的竖条(left:0 width:2px top/bottom:9px)。
  const check = await evalJson(`(() => {
    const items = [...document.querySelectorAll('.setting_tabs .el-tabs__item')];
    if (!items.length) return [{ error: 'tabs 未渲染' }];
    return items.map(el => {
      el.click();
      const r = el.getBoundingClientRect();
      const af = getComputedStyle(el, '::after');
      return {
        name: el.textContent.trim(),
        active: el.classList.contains('is-active'),
        shown: af.content !== 'none' && af.content !== '',
        w: parseFloat(af.width), h: parseFloat(af.height),
        dl: +(parseFloat(af.left) + parseFloat(r.x) - r.x).toFixed(1) // bar left edge vs item left edge
      };
    });
  })()`)
  await sleep(300)
  // Restore the first tab
  await evalJson(`document.querySelector('.setting_tabs .el-tabs__item')?.click()`)
  for (const r of check) {
    if (!r.active) continue // 非活动页签不画条,只校验活动页签
    assert.ok(!r.error && r.shown && Math.abs(r.w - 2) <= 1 && Math.abs(r.dl) <= 1 && r.h >= 10,
      `tab ${r.name || '?'} vertical underline misaligned: w=${r.w}, leftDiff=${r.dl}, h=${r.h}, shown=${r.shown}`)
  }
})

test('E2E: close the settings modal', { skip: !available || !isolated }, async () => {
  await evalJson(`document.querySelector('.modal__close')?.click()`)
  await sleep(400)
  assert.equal(await evalJson(`!!document.querySelector('.modal-container--settings')`), false)
})

test('E2E: quick add -> delete to recycle bin -> hard purge (self-created self-cleaned, no user data left behind)', { skip: !available || !isolated }, async () => {
  await evalJson(`location.hash='#/todo-list/today'`); await sleep(800)
  const name = 'E2E全生命周期 ' + Math.random().toString(36).slice(2, 6)
  const added = await evalJson(`(async () => {
    const i = document.querySelector('.qa-input');
    if (!i) return 'no-input';
    i.focus(); i.value = ${JSON.stringify(name)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    i.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
    await new Promise(r => setTimeout(r, 600));
    return document.body.innerHTML.includes(${JSON.stringify(name)}) ? 'ok' : 'missing';
  })()`)
  assert.equal(added, 'ok', 'the task was not seen in the list after adding')

  const cleanup = await evalJson(`(async () => {
    // Vue 3: the store comes from app.config.globalProperties (element-level __vue__ is a Vue 2 mechanism, unavailable here)
    const app = document.querySelector('#app')?.__vue_app__;
    const store = app && app.config && app.config.globalProperties && app.config.globalProperties.$store;
    if (!store) return 'no-store';
    const t = store.state.todo.todoList.find(x => x.taskContent && x.taskContent.includes(${JSON.stringify(name)}));
    if (!t) return 'not-found';
    const recBefore = store.state.todo.recycleList.length;
    await store.dispatch('todo/updateTodoFields', { taskId: t.taskId, patch: { delete: true, deletedAt: Date.now(), status: 'delete' } });
    await store.dispatch('todo/computeViews');
    const inBin = store.state.todo.recycleList.length === recBefore + 1;
    await store.dispatch('todo/purgeIds', [t.taskId]);
    await store.dispatch('todo/computeViews');
    const purged = !store.state.todo.todoList.some(x => x.taskId === t.taskId) &&
                   !store.state.todo.recycleList.some(x => x.taskId === t.taskId);
    return inBin && purged ? 'cleaned' : 'cleanup-incomplete';
  })()`)
  assert.equal(cleanup, 'cleaned', 'the test task was not fully cleaned up')
})

// Teardown: close the WS handle so the event loop drains naturally (previously the 120s watchdog exit(0) finished things - a hang disguised as a pass;
// 现在看门狗 exit(1) 只兜真正的挂死）
after(() => { try { ws?.close() } catch {} })
