#!/usr/bin/env node
/**
 * 发布级全功能覆盖走查 —— 用户可达面逐条真实交互断言。
 * 覆盖面：搜索筛选(稳定键) / 已达成 / 标签页 / 视图切换 / 回收站UI流 / 重复任务生成 /
 *         设置项生效(专注时长) / 习惯打卡 / 项目+警示徽标 / 空日空态 / EditPanel番茄账目 / 桌面浮窗。
 * 已知自动化边界：白噪音音频输出、安装器首启——保留人工走查（不造假覆盖）。
 * 运行：node tests/run-interactions-gated.mjs tests/ui-coverage.mjs（check:all 调用）
 */
import { spawnApp, stopApp, connectCdp, evalJson, sleep } from './lib/runtime.mjs'

let pass = 0
let fail = 0
const fails = []
const ctx = await spawnApp({ name: 'coverage' })
try {
  await connectCdp(ctx)
  await evalJson(ctx, '1')
  await sleep(1800)

  // 赋值后必须等 hash 真正变更：完成任务触发的 router.replace（日期归一）会顶回刚赋的 hash
  const goto = async h => {
    const path = h.replace(/^#/, '')
    for (let i = 0; i < 6; i++) {
      await evalJson(ctx, `location.hash='${h}';'ok'`)
      await sleep(500)
      if ((await evalJson(ctx, 'location.hash')) === h) { await sleep(400); return }
    }
    // hash 通道被顶回时改走 router.push（捕获路由错误）
    const r = await evalJson(ctx, `(async()=>{try{await window.appUI.$router.push('${path}');return 'ok'}catch(e){return 'err:'+(e&&e.message)}})()`)
    await sleep(700)
    const now = await evalJson(ctx, 'location.hash')
    if (now !== h) {
      const forensic = await evalJson(ctx, `JSON.stringify({appShell:!!document.querySelector('.app-shell'),appUI:typeof window.appUI,ready:document.readyState,errors:(window.__lastVueErr?window.__lastVueErr.msg:null)})`)
      console.error('  ⚠ goto 双通道仍未生效: ' + h + ' ← ' + now + ' push=' + r + ' forensic=' + forensic)
    }
  }
  const click = async sel => evalJson(ctx, `(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return 'nosel';el.click();return 'ok'})()`)
  const exists = async sel => evalJson(ctx, `!!document.querySelector(${JSON.stringify(sel)})`)
  const bodyHas = async t => evalJson(ctx, `document.body.innerText.includes(${JSON.stringify(t)})`)
  const textOf = async sel => evalJson(ctx, `(document.querySelector(${JSON.stringify(sel)})||{}).textContent ?? null`)
  const storeGet = async expr => evalJson(ctx, `(function(){const $s=window.appUI.$store; return ${expr}})()`)
  const storeRun = async expr => evalJson(ctx, `(function(){const $s=window.appUI.$store; ${expr}; return 'ok'})()`)
  // 作用域限定输入（页面内元素与侧边栏同名类并存,必须 scope）
  const typeIn = async (sel, text) => evalJson(ctx, `(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return 'nosel';
    el.focus();el.value=${JSON.stringify(text)};
    el.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'})()`)
  const enterIn = async sel => evalJson(ctx, `(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return 'nosel';
    el.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',bubbles:true}));return 'ok'})()`)
  const clickText = async (sel, text) => evalJson(ctx, `(()=>{const els=[...document.querySelectorAll(${JSON.stringify(sel)})];
    const el=els.find(x=>x.textContent.includes(${JSON.stringify(text)}));if(!el)return 'nomatch';el.click();return 'ok'})()`)
  const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log('  ✓ ' + name) } else { fail++; fails.push(name); console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')) }
  }

  console.log('[1] 任务种子（快捷添加真实输入链）')
  await goto('#/todo-list/today')
  for (const name of ['苹果搜索甲', '苹果搜索乙 #测试标签', '重复模板甲']) {
    await typeIn('.qa-input', name)
    await enterIn('.qa-input')
    await sleep(500)
  }
  ok('快捷添加创建 3 条任务', (await storeGet(`$s.state.todo.todoList.filter(t=>!t.delete&&t.dayStart===new Date().setHours(0,0,0,0)).length`)) >= 3)
  ok('按文本完成 苹果搜索乙', (await evalJson(ctx, `(()=>{const c=[...document.querySelectorAll('.td-item')].find(e=>e.textContent.includes('苹果搜索乙'));if(!c)return 'no';const k=c.querySelector('.td-check');if(!k)return 'nochk';k.click();return 'ok'})()`)) === 'ok')
  await sleep(600)

  console.log('[2] 搜索页（稳定键筛选链）')
  await goto('#/todo-list/search')
  console.log('   [probe] errors so far:', JSON.stringify((ctx.consoleErrors||[]).slice(0,3)), '| hash:', await evalJson(ctx, 'location.hash'), '| search-page:', await exists('.search-page'))
  await typeIn('.search-page .main-nav-search__input', '苹果')
  await sleep(900)
  const cntAll = (await textOf('.result-count')) || ''
  ok('搜索「苹果」命中 2 条', cntAll.includes('2'), JSON.stringify(cntAll))
  await storeRun(`$s.commit('settings/updateSettings',{searchComplete:'undone'})`)
  await sleep(600)
  const cntUndone = (await textOf('.result-count')) || ''
  ok('状态筛选=未完成 → 只剩 1 条（稳定键生效）', cntUndone.includes('1'), JSON.stringify(cntUndone))
  await storeRun(`$s.commit('settings/updateSettings',{searchComplete:'done',searchDateRange:'last7'})`)
  await sleep(600)
  const cntDone = (await textOf('.result-count')) || ''
  ok('状态筛选=已完成+最近7天 → 1 条', cntDone.includes('1'), JSON.stringify(cntDone))
  await storeRun(`$s.commit('settings/updateSettings',{searchComplete:'',searchDateRange:''})`)

  console.log('[3] 已达成页')
  await goto('#/todo-list/completed')
  ok('已达成页包含已完成的 苹果搜索乙', await bodyHas('苹果搜索乙'))

  console.log('[4] 标签页（#测试标签）')
  await goto('#/todo-list/tag/测试标签')
  ok('标签页渲染出带标签任务', await bodyHas('苹果搜索乙'))

  console.log('[5] 今日页视图切换（四象限/卡片）')
  await goto('#/todo-list/today')
  ok('四象限视图渲染', (await click('button[aria-label="四象限"]')) === 'ok' && (await evalJson(ctx, `document.querySelector('.today-list').innerHTML.includes('matrix')`)))
  await sleep(400)
  ok('卡片视图渲染', (await click('button[aria-label="卡片"]')) === 'ok' && (await exists('.today-list .pd-day-deck, .today-list [class*=day-deck]')))
  ok('切回列表视图', (await click('button[aria-label="列表"]')) === 'ok' && (await exists('.today-list .td-groups')))

  console.log('[6] 回收站 UI 流')
  const beforeCnt = await storeGet(`$s.state.todo.todoList.filter(t=>!t.delete).length`)
  await storeRun(`const t=$s.state.todo.todoList.find(x=>x.taskContent.includes('重复模板甲')); $s.dispatch('todo/deleteTodo',t)`)
  await sleep(700)
  ok('删除后活跃任务 -1', (await storeGet(`$s.state.todo.todoList.filter(t=>!t.delete).length`)) === beforeCnt - 1)
  await goto('#/todo-list/recycle-bin')
  ok('回收站页显示被删任务', await bodyHas('重复模板甲'))
  ok('回收站提供 移到今天/彻底删除 按钮', await bodyHas('移到今天') && await bodyHas('彻底删除'))
  ok('回收站行内 移到今天 还原点击', (await clickText('.recycle-page .btn', '移到今天')) === 'ok')
  await sleep(700)
  ok('还原后活跃任务恢复', (await storeGet(`$s.state.todo.todoList.filter(t=>!t.delete).length`)) === beforeCnt)

  console.log('[7] 重复任务 UI 生成')
  const cntBeforeRepeat = await storeGet(`$s.state.todo.todoList.filter(t=>!t.delete).length`)
  await storeRun(`const t=$s.state.todo.todoList.find(x=>x.taskContent.includes('苹果搜索甲'));
    if(t&&!t.todoTime){$s.commit('todo/updateTodoFields',{taskId:t.taskId,patch:{todoTime:new Date().setHours(9,0,0,0)}})}`)
  await storeRun(`const t=$s.state.todo.todoList.find(x=>x.taskContent.includes('苹果搜索甲')); $s.commit('ui/openEdit', t)`)
  await sleep(800)
  ok('编辑栏打开', await exists('.ep-inner'))
  ok('重复规则弹窗打开', (await click('.ep-repeat-row')) === 'ok' && await exists('.modal-container'))
  await sleep(600)
  const gen = await evalJson(ctx, `(()=>{const b=[...document.querySelectorAll('.modal-container button')].find(x=>x.textContent.includes('生成'));if(!b)return 'nobtn';if(b.disabled)return 'disabled';b.click();return 'ok'})()`)
  await sleep(1500)
  const cntAfterRepeat = await storeGet(`$s.state.todo.todoList.filter(t=>!t.delete).length`)
  ok('重复生成产出新任务', gen === 'ok' && cntAfterRepeat > cntBeforeRepeat, `gen=${gen} ${cntBeforeRepeat}→${cntAfterRepeat}`)
  await evalJson(ctx, `(()=>{const b=document.querySelector('.modal-container .modal__close');if(b)b.click()})()`)
  await sleep(500)

  console.log('[8] 设置项实际生效（专注时长 25→30）')
  await goto('#/todo-list/today')
  await storeRun(`$s.commit('ui/toggleSettings',true)`)
  await sleep(900)
  ok('设置弹窗打开', await exists('.modal-container'))
  const setLen = await evalJson(ctx, `(()=>{const inp=document.querySelector('input[aria-label="专注时长（分钟）："]');if(!inp)return 'nosel';
    const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    setter.call(inp,'30');inp.dispatchEvent(new Event('input',{bubbles:true}));
    inp.dispatchEvent(new Event('change',{bubbles:true}));inp.blur();return 'ok'})()`)
  await sleep(900)
  ok('专注时长写入设置', setLen === 'ok' && (await storeGet(`$s.state.settings.tomatoTime`)) === 30, String(await storeGet(`$s.state.settings.tomatoTime`)))
  ok('同步到番茄面板 store（会话内即生效）', (await storeGet(`$s.state.tomato.tomatoTime`)) === 30, String(await storeGet(`$s.state.tomato.tomatoTime`)))
  await evalJson(ctx, `(()=>{const b=document.querySelector('.modal-container .modal__close');if(b)b.click()})()`)
  await sleep(600)
  const timerText = (await textOf('.tomato-timer__time')) || ''
  ok('番茄条计时器显示 30:00（UI 生效）', timerText.includes('30:00'), timerText + ' | store=' + String(await storeGet(`$s.state.tomato.tomatoTime`)) + ' | els=' + String(await evalJson(ctx, `document.querySelectorAll('.tomato-timer__time').length`)))

  console.log('[9] 习惯（dev 门控开 → 建卡 → 打卡）')
  await storeRun(`$s.commit('settings/updateSettings',{developerMode:true,showHabitModule:true,showProjectsModule:true})`)
  await sleep(500)
  await goto('#/todo-list/habit')
  await typeIn('.habit-add-input', '跑步')
  ok('习惯「新建」按钮点击', (await clickText('button', '新建')) === 'ok')
  await sleep(700)
  ok('新建习惯卡片出现', await bodyHas('跑步') && (await exists('.habit-card')))
  ok('习惯打卡点击', (await clickText('.habit-card span', '✓')) === 'ok')

  console.log('[10] 项目 + 警示徽标')
  await goto('#/todo-list/projects')
  ok('项目页工具栏渲染', await exists('.proj-toolbar'))
  await storeRun(`$s.commit('category/addCategory',{categoryName:'审计项目'});const c=$s.state.category.list.find(x=>x.categoryName==='审计项目');
    $s.commit('category/setProject',{id:c.categoryId,flag:true});
    window.todoAPI.dbCall('setMeta',['projectDeadline:'+c.categoryId,String(Date.now()+3*86400000)])`)
  await sleep(800)
  await storeRun(`$s.dispatch('category/loadProjectMeta')`)
  await sleep(900)
  await goto('#/todo-list/today')
  ok('项目警示徽标出现（临近截止）', await exists('.sn-badge.warn'))

  console.log('[11] 空日空态')
  await goto('#/todo-list/today')
  await goto('#/todo-list/today?date=2027-01-01')
  await sleep(400)
  const emptyDetail = await evalJson(ctx, `JSON.stringify({hash:location.hash,sel:window.appUI.$store.state.ui.daySelectedTs,empty:!!document.querySelector('.empty-state'),groups:document.querySelectorAll('.tg-group').length,body:document.body.innerText.replace(/\\s+/g,' ').slice(0,160)})`)
  ok('无安排日显示空态文案', await bodyHas('这一天没有安排'), emptyDetail)

  console.log('[12] EditPanel 番茄账目行')
  await goto('#/todo-list/today')
  await sleep(600)
  await storeRun(`const t=$s.state.todo.todoList.find(x=>x.taskContent.includes('苹果搜索甲')); $s.commit('ui/openEdit', t)`)
  await sleep(800)
  ok('编辑栏打开', await exists('.ep-inner'))
  const estBefore = (await textOf('.ep-tom-num')) || ''
  const steps = await evalJson(ctx, `document.querySelectorAll('.ep-tom-step').length`)
  if (steps >= 2) {
    await evalJson(ctx, `document.querySelectorAll('.ep-tom-step')[1].click()`)
    await sleep(400)
    const estAfter = (await textOf('.ep-tom-num')) || ''
    ok('预计番茄 + 步进生效', parseInt(estAfter) === parseInt(estBefore) + 1, `${estBefore}→${estAfter}`)
  } else ok('预计番茄步进器存在', false, 'steps=' + steps)

  console.log('- 浮窗验证拆分为 tests/_float-check.mjs（需要真实弹窗,不在无焦点门禁内）')
  console.log(`\nresults: ${pass} passed, ${fail} failed`)
  if (fail) { console.error('FAILURES:\n  - ' + fails.join('\n  - ')); process.exit(1) }
  process.exit(0)
} catch (e) {
  console.error('[coverage] fatal:', e.message)
  process.exit(1)
} finally {
  await stopApp(ctx).catch(() => {})
}
