/**
 * 浏览器调试用 todoAPI 降级实现 —— 仅用于在真实浏览器中做 UI/UX 调试，
 * Electron 环境下 preload 会注入同名对象，本文件自动让位不生效。
 * 数据保存在 localStorage（key: appBrowserShim.todos.v4），刷新后保留。
 *
 * 参数形态与渲染层实际调用一一对齐（勿随意改动）：
 *   dbCall('getMeta', 'todosVersion')          ← 裸字符串
 *   dbCall('setMeta', ['todosVersion', '3'])   ← [key, value] 数组
 *   dbCall('hardDelete', 'task-xxx')           ← 裸 id
 *   dbCall('upsert', todoRow)                  ← 裸行对象（camelCase 字段）
 *   dbCall('upsertMany', rowsArray)            ← 裸行数组
 *   dbCall('queryTodos', { deleted, repeatId, complete, categoryId })
 */
(function () {
  if (window.todoAPI) return // Electron preload 已注入，不覆盖
  const LS_KEY = 'appBrowserShim.todos.v4'
  const META_KEY = 'appBrowserShim.meta'
  // 旧键迁移（历史调试数据保留）
  try {
    const old = localStorage.getItem('eveBrowserShim.todos.v4')
    if (old && !localStorage.getItem(LS_KEY)) localStorage.setItem(LS_KEY, old)
    const oldMeta = localStorage.getItem('eveBrowserShim.meta')
    if (oldMeta && !localStorage.getItem(META_KEY)) localStorage.setItem(META_KEY, oldMeta)
  } catch { /* 忽略 */ }

  const load = () => {
    try {
      const rows = JSON.parse(localStorage.getItem(LS_KEY)) || null
      if (!Array.isArray(rows)) return null
      // 一次性迁移:字段语义化(standby*/snow* → 语义名),旧调试数据不丢
      let dirty = false
      for (const r of rows) {
        if ('standbyStr1' in r) { r.repeatId = r.standbyStr1; delete r.standbyStr1; dirty = true }
        if ('standbyStr2' in r) { r.subtasks = r.standbyStr2; delete r.standbyStr2; dirty = true }
        if ('standbyStr3' in r) { r.image = r.standbyStr3; delete r.standbyStr3; dirty = true }
        if ('standbyStr4' in r) { r.files = r.standbyStr4; delete r.standbyStr4; dirty = true }
        if ('standbyInt1' in r) { r.categoryId = r.standbyInt1; delete r.standbyInt1; dirty = true }
        if ('snowAdd' in r) { r.estimate = r.snowAdd; delete r.snowAdd; dirty = true }
        if ('snowAssess' in r) { r.difficulty = r.snowAssess; delete r.snowAssess; dirty = true }
      }
      if (dirty) { try { localStorage.setItem(LS_KEY, JSON.stringify(rows)) } catch { /* 忽略 */ } }
      return rows
    } catch { return null }
  }
  const save = rows => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(rows)) } catch (e) {
      console.error('[appBrowserShim] localStorage 写入失败（可能超配额）:', e)
    }
  }

  let todos = load()
  if (!todos) {
    const now = Date.now()
    const startOfDay = n => +window.dayjs().add(n, 'day').startOf('day')
    let seq = 0
    // 字段命名与渲染层一致（camelCase，同主进程蛇形→驼峰转换后的结果）
    // 分类 ID 与 store/category.js 初始示例一致：工作100001 学习100002 生活100003，0=未分类
    const mk = ({ content, describe = '', catId = 0, complete = false, dayOffset = null,
                  reminderOffsetMin = null, sort }) => ({
      taskId: 'seed_' + (++seq),
      userId: 840001,
      taskContent: content,
      taskDescribe: describe,
      complete: !!complete,
      delete: false,
      createTime: now - seq * 3600000,
      updateTime: now,
      syncTime: now,
      todoTime: dayOffset == null ? 0 : startOfDay(dayOffset),
      dayStart: dayOffset == null ? 0 : startOfDay(dayOffset),
      reminderTime: reminderOffsetMin == null ? 0 : now + reminderOffsetMin * 60000,
      taskSort: sort ?? seq * 10,
      estimate: 0,
      difficulty: null,
      repeatId: '',
      subtasks: '',
      image: '',
      files: '',
      categoryId: catId,
      status: 'sync',
      version: 1
    })
    todos = (function () {
      // 种子双语:跟随 appLocale(官网 demo 由注入脚本先行落键;5175 调试宿主默认中文)
      let en = false
      try { en = localStorage.getItem('appLocale') === 'en-US' } catch { /* 忽略 */ }
      const T = en ? {
        welcome: 'Welcome to the browser demo', welcomeD: 'Full app in your browser — data lives only in localStorage',
        morning: 'Morning sync — weekly plan', morningD: '10:00 online meeting',
        uiReview: 'Review UI fidelity issue list', daily: 'Write daily report',
        vue: 'Read "Deep into Vue.js" ch. 6', words: 'Memorize 30 words',
        run: 'Run 5 km in the afternoon', water: 'Water the plants',
        talk: 'Prepare Friday tech-talk outline', talkD: 'Topic: engineering practices for time management',
        algo: 'Algorithm practice: binary trees', checkup: 'Book a health checkup',
        okr: 'Draft quarterly OKR', books: 'Return library books (overdue)',
        retro: 'Weekly retro for last week', idea: 'A stray idea — drag it onto a day', ideaD: 'Jot it down now, drag it onto a day later'
      } : {
        welcome: '欢迎使用浏览器调试模式', welcomeD: '此页面由 browser-dev Vite 服务提供，数据仅存于 localStorage',
        morning: '晨会同步本周排期', morningD: '10:00 线上会议',
        uiReview: '评审 UI 还原度问题清单', daily: '写日报',
        vue: '阅读《深入浅出 Vue.js》第 6 章', words: '背 30 个单词',
        run: '下午跑步 5 公里', water: '给绿萝浇水',
        talk: '准备周五的技术分享提纲', talkD: '主题：时间管理工具的工程化实践',
        algo: '刷算法题：二叉树专题', checkup: '预约体检',
        okr: '整理季度 OKR 初稿', books: '还书到图书馆（已过期一天）',
        retro: '上周复盘总结', idea: '无日期的想法灵感', ideaD: '随手记一条，之后拖到具体日期'
      }
      return [
        mk({ content: T.welcome, describe: T.welcomeD, catId: 0 }),
        mk({ content: T.morning, describe: T.morningD, catId: 100001, dayOffset: 0, reminderOffsetMin: 30 }),
        mk({ content: T.uiReview, catId: 100001, dayOffset: 0, sort: 20 }),
        mk({ content: T.daily, catId: 100001, dayOffset: 0, complete: true, sort: 30 }),
        mk({ content: T.vue, catId: 100002, dayOffset: 0, sort: 40 }),
        mk({ content: T.words, catId: 100002, dayOffset: 0, complete: true, sort: 50 }),
        mk({ content: T.run, catId: 100003, dayOffset: 0, reminderOffsetMin: 120, sort: 60 }),
        mk({ content: T.water, catId: 100003, dayOffset: 0, complete: true, sort: 70 }),
        mk({ content: T.talk, describe: T.talkD, catId: 100001, dayOffset: 1 }),
        mk({ content: T.algo, catId: 100002, dayOffset: 1 }),
        mk({ content: T.checkup, catId: 100003, dayOffset: 2, reminderOffsetMin: 60 * 24 }),
        mk({ content: T.okr, catId: 100001, dayOffset: 4 }),
        mk({ content: T.books, catId: 100002, dayOffset: -1 }),
        mk({ content: T.retro, catId: 100001, dayOffset: -3, complete: true }),
        mk({ content: T.idea, describe: T.ideaD, catId: 0 })
      ]
    })()
    save(todos)
  }

  // 开发注入:?seed=today 用真实今日任务面(取自 2026-09-06 真库)覆盖 localStorage,并配几段
  // 今日番茄事实块,便于调试时间轴/账目/复盘。任意浏览器访问 http://localhost:5175/?seed=today 即得一致数据。
  if (new URLSearchParams(location.search).get('seed') === 'today') {
    const now = Date.now()
    const day0 = +window.dayjs().startOf('day')
    let q = 0
    const smk = (over) => Object.assign({
      taskId: 'seed_today_' + (++q), userId: 840001, taskDescribe: '', complete: false, delete: false,
      createTime: now - q * 3600000, updateTime: now, syncTime: now,
      todoTime: day0, dayStart: day0, reminderTime: 0, taskSort: q * 10,
      estimate: 0, difficulty: null, repeatId: '', subtasks: '', image: '', files: '', categoryId: 100001, status: 'sync'
    }, over)
    todos = [
      smk({ taskContent: '小红书备用图第二波发布 #D+3 #小红书 #拾事', taskDescribe: '素材任务里已配5张图,D+3发第二波(深色主题+四象限角度)' }),
      smk({ taskContent: '发布第2条《为什么越在乎越容易搞砸》到抖音', taskDescribe: '竖版1080x1920已就绪：视频/第02条' }),
      smk({ taskContent: '发布准备：定标题/封面/话题标签', taskDescribe: '候选标题见 竞品拆解/GGBond小课堂-头部拆解' }),
      smk({ taskContent: '发布后1小时：回评论+记录数据', taskDescribe: '赞/评/转/完播率,填进竞品拆解文档对比表' }),
      smk({ taskContent: '深度研究：GGBond 23条全量声学+句式拆解写档', taskDescribe: 'AI任务', categoryId: 100002 }),
      smk({ taskContent: '发掘金：单日25亿token实测——多代理流水线消耗全记录' }),
      smk({ taskContent: '晨间站会与今日排期同步', complete: true })
    ]
    save(todos)
    // 番茄事实块锚定「昨天」同一钟点(2026-09-07 视觉门禁实锤:锚今天则凌晨跑门禁时记录全在
    // 未来→统计聚合 0 分钟,白天记录逐个「成熟」→统计页数字随时间漂移,0.4% 阈值必破;
    // 昨天的记录在任何时刻都已完全成熟,当日任意时刻聚合恒定)。上午两个关联任务的专注番茄
    // + 下午自由专注一段 + 一段放弃(覆盖复盘/时间轴各形态)
    const dk = window.dayjs().subtract(1, 'day').format('YYYY-MM-DD')
    const at = (h, m) => day0 - 86400000 + h * 3600000 + m * 60000
    const rec = (id, h0, m0, h1, m1, over) => Object.assign({
      tomatoId: 'seed_rec_' + id, dateKey: dk, endTime: at(h1, m1),
      focusDuration: Math.round((at(h1, m1) - at(h0, m0)) / 60000) - 5,
      rest: 5, restDuration: 5, succeed: true, manual: false, status: 'local',
      focusTaskId: null, taskId: null, abandonReason: ''
    }, over)
    let m = {}
    try { m = JSON.parse(localStorage.getItem(META_KEY)) || {} } catch {}
    m.__shimTomatoRecords = [
      rec('a', 9, 10, 9, 35, { taskId: 'seed_today_6', focusTaskId: 'seed_today_6' }),
      rec('b', 9, 40, 10, 5, { taskId: 'seed_today_6', focusTaskId: 'seed_today_6' }),
      rec('c', 10, 20, 10, 45, { taskId: 'seed_today_3', focusTaskId: 'seed_today_3' }),
      rec('d', 11, 0, 11, 25, { taskId: 'seed_today_5', focusTaskId: 'seed_today_5', succeed: false, abandonReason: '切换去做发布素材' }),
      rec('e', 14, 5, 14, 30, { taskId: 'seed_today_2', focusTaskId: 'seed_today_2' }),
      rec('f', 15, 10, 15, 35, {})
    ]
    try { localStorage.setItem(META_KEY, JSON.stringify(m)) } catch {}
    console.log('[appBrowserShim] ?seed=today 已注入今日任务', todos.length, '条 + 番茄', m.__shimTomatoRecords.length, '段')
  }

  const clone = v => JSON.parse(JSON.stringify(v))

  function normalizeMetaArgs(params) {
    // 兼容 ('getMeta', 'key') / ('setMeta', ['key', value]) / ({key}) / ({key, value})
    if (typeof params === 'string') return { key: params, value: undefined }
    if (Array.isArray(params)) return { key: params[0], value: params[1] }
    return { key: params && params.key, value: params && params.value }
  }

  // 分类（camelCase 结构与渲染端 category store 一致；localStorage 持久化）
  // 每次读写都直接走 localStorage(多标签页并存时,解析期缓存的内存副本会把别的页写入的分类覆盖掉)
  const CAT_KEY = (() => { try { var o = localStorage.getItem('appShimCategories'); if (o) return 'appShimCategories'; var e = localStorage.getItem('eveShimCategories'); if (e) { localStorage.setItem('appShimCategories', e); return 'appShimCategories' } } catch (_) {} return 'appShimCategories' })()
  const readCategories = () => { try { return JSON.parse(localStorage.getItem(CAT_KEY) || '[]') } catch { return [] } }
  let categories = readCategories()
  const saveCategories = () => { try { localStorage.setItem(CAT_KEY, JSON.stringify(categories)) } catch {} }
  const syncCategories = () => { categories = readCategories() }
  // 空库时预置双语默认分类(与 store/category.js 初始示例同 id 同色,应用见库非空即不再灌其中文默认)
  if (!categories.length) {
    let en = false
    try { en = localStorage.getItem('appLocale') === 'en-US' } catch { /* 忽略 */ }
    const now = Date.now()
    const mkCat = (i, name, color) => ({ category_id: 100000 + i, user_id: 840001, category_name: name, category_color: color, create_time: now + i, list_sort: 100 * i, folder_is: 0, folder_id: 0, delete_flag: 0 })
    categories = en
      ? [mkCat(1, 'Work', '#0f9d8f'), mkCat(2, 'Study', '#f2a63b'), mkCat(3, 'Life', '#7ac74f')]
      : [mkCat(1, '工作', '#0f9d8f'), mkCat(2, '学习', '#f2a63b'), mkCat(3, '生活', '#7ac74f')]
    saveCategories()
  }

  async function dbCall(op, params) {
    if (op === 'getAllCategories' || op === 'upsertCategory') syncCategories()
    switch (op) {
      case 'getAllCategories':
        // 存储为 snake 行，返回 camelCase（与主进程 db.js rowToCategory 一致）
        return clone(categories.filter(c => !c.delete_flag).sort((a, b) => (a.list_sort || 0) - (b.list_sort || 0))
          .map(r => ({ categoryId: r.category_id, userId: r.user_id, categoryName: r.category_name, categoryColor: r.category_color, createTime: r.create_time, listSort: r.list_sort, folderIs: !!r.folder_is, folderId: r.folder_id || 0, delete: !!r.delete_flag })))
      case 'upsertCategory': {
        // 兼容 snake（渲染端 toRow）与 camel 两种入参
        const cid = params && (params.category_id != null ? params.category_id : params.categoryId)
        if (!params || cid == null) return false
        const row = params.category_id != null ? params : {
          category_id: params.categoryId, user_id: params.userId, category_name: params.categoryName,
          category_color: params.categoryColor, create_time: params.createTime, list_sort: params.listSort,
          folder_is: params.folderIs ? 1 : 0, folder_id: params.folderId || 0, delete_flag: params.delete ? 1 : 0
        }
        const i = categories.findIndex(c => c.category_id === cid)
        if (i >= 0) categories[i] = Object.assign({}, categories[i], row)
        else categories.push(Object.assign({ create_time: Date.now(), list_sort: 0, folder_is: 0, folder_id: 0, delete_flag: 0 }, row))
        saveCategories()
        return true
      }
      case 'getAll':
        return clone(todos)
      case 'queryTodos': {
        const q = typeof params === 'string' ? {} : (params || {})
        let rows = todos.filter(r => !r.delete)
        if (q.deleted != null && q.deleted !== -1) rows = rows.filter(r => !!r.delete === !!q.deleted)
        if (q.complete != null && q.complete !== -1) rows = rows.filter(r => !!r.complete === !!q.complete)
        if (q.categoryId != null && q.categoryId !== -1) rows = rows.filter(r => r.categoryId === q.categoryId)
        if (q.repeatId != null) rows = rows.filter(r => r.repeatId === q.repeatId)
        // 对齐主进程 db.js:dayStartFrom/To 范围过滤(addTodo 续期幂等检查依赖,缺了会误判已存在而跳过续期)
        if (q.dayStartFrom != null) rows = rows.filter(r => (r.dayStart || 0) >= q.dayStartFrom)
        if (q.dayStartTo != null) rows = rows.filter(r => (r.dayStart || 0) <= q.dayStartTo)
        return clone(rows)
      }
      case 'upsert':
      case 'upsertMany': {
        const rows = op === 'upsert' ? [params] : (Array.isArray(params) ? params : (params && params.rows) || [])
        for (const row of rows) {
          if (!row || !row.taskId) { console.warn('[appBrowserShim] upsert 缺少 taskId:', row); continue }
          const i = todos.findIndex(t => t.taskId === row.taskId)
          if (i >= 0) todos[i] = Object.assign({}, todos[i], row)
          else todos.push(Object.assign({ delete: false, complete: false, createTime: Date.now() }, row))
        }
        save(todos)
        broadcast()
        return true
      }
      case 'hardDelete': {
        // 渲染层传裸 id；兼容数组 / {ids}
        const ids = Array.isArray(params) ? params
          : (typeof params === 'string' ? [params]
          : ((params && (params.ids || params.taskIds)) || []))
        todos = todos.filter(t => !ids.includes(t.taskId))
        save(todos)
        broadcast()
        return true
      }
      case 'getMeta': {
        const { key } = normalizeMetaArgs(params)
        try { return JSON.parse(localStorage.getItem(META_KEY))?.[key] ?? null } catch { return null }
      }
      case 'setMeta': {
        const { key, value } = normalizeMetaArgs(params)
        if (!key) return false
        let m = {}
        try { m = JSON.parse(localStorage.getItem(META_KEY)) || {} } catch {}
        m[key] = String(value) // 与主进程 setMeta 的 String(v) 落库语义对齐
        localStorage.setItem(META_KEY, JSON.stringify(m))
        return true
      }
      case 'countSeedTodos':
        return todos.filter(t => String(t.taskId).startsWith('seed_')).length
      case 'purgeSeedTodos':
        todos = todos.filter(t => !String(t.taskId).startsWith('seed_'))
        save(todos); broadcast()
        return true
      case 'purgeRecycleBin':
        todos = todos.filter(t => !t.delete)
        save(todos); broadcast()
        return true
      case 'filterList': {
        try { return JSON.parse(localStorage.getItem(META_KEY))?.['__shimFilters'] || [] } catch { return [] }
      }
      case 'filterUpsert': {
        const f = Array.isArray(params) ? params[0] : params
        if (!f || !f.filterId) return null
        let m = {}
        try { m = JSON.parse(localStorage.getItem(META_KEY)) || {} } catch {}
        const list = m.__shimFilters || []
        const i = list.findIndex(x => x.filterId === f.filterId)
        if (i >= 0) list[i] = f; else list.push(f)
        m.__shimFilters = list
        localStorage.setItem(META_KEY, JSON.stringify(m))
        return f.filterId
      }
      case 'filterDelete': {
        const id = Array.isArray(params) ? params[0] : params
        let m = {}
        try { m = JSON.parse(localStorage.getItem(META_KEY)) || {} } catch {}
        m.__shimFilters = (m.__shimFilters || []).filter(x => x.filterId !== id)
        localStorage.setItem(META_KEY, JSON.stringify(m))
        return true
      }
      case 'bumpSnow':
        // 桌面端写SQLite雪球分钟;5175按已有taskSnow聚合累计存meta,保证统计页不与桌面分叉
        {
          const p = (Array.isArray(params) ? params[0] : params) || {}
          if (!p.taskId) return true
          let m = {}
          try { m = JSON.parse(localStorage.getItem(META_KEY)) || {} } catch {}
          m['__shimSnow'] = Object.assign({}, m.__shimSnow, { [p.taskId]: (m.__shimSnow?.[p.taskId] || 0) + (Number(p.minutes) || 0) })
          localStorage.setItem(META_KEY, JSON.stringify(m))
          return true
        }
      case 'tomatoAll':
        // 账本行表 shim:LS meta 桶存行集(桌面端为 SQLite tomato_records;5175 只求调试语义一致)
        {
          let m = {}
          try { m = JSON.parse(localStorage.getItem(META_KEY)) || {} } catch {}
          return (m.__shimTomatoRecords || []).slice().sort((a, b) => (b.endTime || 0) - (a.endTime || 0))
        }
      case 'tomatoAppendMany': {
        const list = Array.isArray(params) ? params : [params]
        let m = {}
        try { m = JSON.parse(localStorage.getItem(META_KEY)) || {} } catch {}
        const rows = m.__shimTomatoRecords || []
        const byId = {}; rows.forEach(r => { byId[r.tomatoId] = r })
        for (const raw of list) {
          if (!raw || !raw.tomatoId || !raw.endTime) throw new Error('tomatoAppendMany: tomatoId/endTime required')
          const rec = Object.assign({ dateKey: '', succeed: true, manual: false, rest: 0, restDuration: 0, focus: '', focusTaskId: null, status: 'local', abandonReason: '' }, raw)
          if (!/^\d{4}-\d{2}-\d{2}$/.test(String(rec.dateKey))) throw new Error('tomatoAppendMany: dateKey must be YYYY-MM-DD')
          byId[rec.tomatoId] = Object.assign(byId[rec.tomatoId] || {}, rec) // UPSERT 语义:后写胜,未知字段保全
        }
        m.__shimTomatoRecords = Object.values(byId)
        localStorage.setItem(META_KEY, JSON.stringify(m))
        return true
      }
      case 'tomatoUpdateById': {
        const arg = (Array.isArray(params) ? params[0] : params) || {}
        let m = {}
        try { m = JSON.parse(localStorage.getItem(META_KEY)) || {} } catch {}
        const rows = m.__shimTomatoRecords || []
        const i = rows.findIndex(r => r.tomatoId === String(arg.tomatoId))
        if (i < 0) return false
        const rec = Object.assign(rows[i], arg.patch || {})
        if (arg.patch && arg.patch.endTime != null) { const d = new Date(rec.endTime); rec.dateKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }
        rows[i] = rec
        m.__shimTomatoRecords = rows
        localStorage.setItem(META_KEY, JSON.stringify(m))
        return true
      }
      case 'tomatoRemoveByIds': {
        const ids = new Set((Array.isArray(params) ? params : [params]).map(String))
        let m = {}
        try { m = JSON.parse(localStorage.getItem(META_KEY)) || {} } catch {}
        m.__shimTomatoRecords = (m.__shimTomatoRecords || []).filter(r => !ids.has(String(r.tomatoId)))
        localStorage.setItem(META_KEY, JSON.stringify(m))
        return true
      }
      case 'tomatoMigrateFromMeta':
        return 0 // shim 无旧 meta blob 可迁
      // ===== 排程芯片 plan_chips 行存储 shim(2026-09-06 补齐:此前 5175 排程芯片整体不可用) =====
      case 'planAll':
        {
          let m = {}
          try { m = JSON.parse(localStorage.getItem(META_KEY)) || {} } catch {}
          return (m.__shimPlanChips || []).slice().sort((a, b) => (a.day + a.mm).localeCompare(b.day + b.mm))
        }
      case 'planAddMany': {
        const list = (Array.isArray(params) ? params : [params]).map(c => ({
          id: (c && c.id) || 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
          taskId: String(c.taskId || ''), day: String(c.day || ''), mm: String(c.mm || ''), sort: Number(c.sort) || 0
        }))
        for (const c of list) {
          if (!c.taskId) throw new Error('planAddMany: taskId required')
          if (!/^\d{4}-\d{2}-\d{2}$/.test(c.day)) throw new Error('planAddMany: day 必须 YYYY-MM-DD')
          if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(c.mm)) throw new Error('planAddMany: mm 必须 HH:mm')
        }
        let m = {}
        try { m = JSON.parse(localStorage.getItem(META_KEY)) || {} } catch {}
        const byId = {}; (m.__shimPlanChips || []).forEach(r => { byId[r.id] = r })
        list.forEach(c => { byId[c.id] = c })
        m.__shimPlanChips = Object.values(byId)
        localStorage.setItem(META_KEY, JSON.stringify(m))
        return list.map(c => c.id)
      }
      case 'planUpdateChip': {
        const { id, day, mm } = params || {}
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) throw new Error('planUpdateChip: day 必须 YYYY-MM-DD')
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(mm))) throw new Error('planUpdateChip: mm 必须 HH:mm')
        let m = {}
        try { m = JSON.parse(localStorage.getItem(META_KEY)) || {} } catch {}
        const rows = m.__shimPlanChips || []
        const i = rows.findIndex(r => r.id === String(id))
        if (i < 0) return false
        rows[i].day = String(day); rows[i].mm = String(mm)
        m.__shimPlanChips = rows
        localStorage.setItem(META_KEY, JSON.stringify(m))
        return true
      }
      case 'planRemoveIds': {
        const ids = new Set((Array.isArray(params) ? params : [params]).map(String))
        let m = {}
        try { m = JSON.parse(localStorage.getItem(META_KEY)) || {} } catch {}
        m.__shimPlanChips = (m.__shimPlanChips || []).filter(r => !ids.has(String(r.id)))
        localStorage.setItem(META_KEY, JSON.stringify(m))
        return true
      }
      case 'planMoveTask': {
        const { taskId, fromDay, toDay } = params || {}
        const okDay = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v))
        if (!okDay(fromDay) || !okDay(toDay)) return 0
        let m = {}
        try { m = JSON.parse(localStorage.getItem(META_KEY)) || {} } catch {}
        let n = 0
        ;(m.__shimPlanChips || []).forEach(r => { if (r.taskId === String(taskId) && r.day === String(fromDay)) { r.day = String(toDay); n++ } })
        if (n) localStorage.setItem(META_KEY, JSON.stringify(m))
        return n
      }
      case 'planDeleteTask': {
        let m = {}
        try { m = JSON.parse(localStorage.getItem(META_KEY)) || {} } catch {}
        m.__shimPlanChips = (m.__shimPlanChips || []).filter(r => r.taskId !== String(params))
        localStorage.setItem(META_KEY, JSON.stringify(m))
        return true
      }
      case 'planDeleteTaskDay': {
        const { taskId, day } = params || {}
        let m = {}
        try { m = JSON.parse(localStorage.getItem(META_KEY)) || {} } catch {}
        m.__shimPlanChips = (m.__shimPlanChips || []).filter(r => !(r.taskId === String(taskId) && r.day === String(day)))
        localStorage.setItem(META_KEY, JSON.stringify(m))
        return true
      }
      case 'planPrune': {
        const keep = ((params && params.keepDays) || []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(String(d)))
        if (!keep.length) return 0
        let m = {}
        try { m = JSON.parse(localStorage.getItem(META_KEY)) || {} } catch {}
        const before = (m.__shimPlanChips || []).length
        m.__shimPlanChips = (m.__shimPlanChips || []).filter(r => keep.includes(r.day))
        localStorage.setItem(META_KEY, JSON.stringify(m))
        return before - m.__shimPlanChips.length
      }
      default:
        warnOnce('dbCall:' + op, () => console.warn('[appBrowserShim] 未实现的 dbCall 操作:', op, params))
        return null
    }
  }

  const listeners = []
  // 广播带payload对齐真preload契约(onTodosChanged的(_e,p)=>fn(p)):未来渲染端一旦读参不与桌面分叉
  function broadcast() { const payload = { reason: 'local', at: Date.now() }; listeners.forEach(fn => { try { fn(payload) } catch (e) { console.error(e) } }) }

  window.todoAPI = {
    version: '0.1.0-browser-shim', // 与 package.json 同步,仅调试宿主展示用
    dbCall,

    // 对齐桌面语义(主进程读config.json):5175读LS里的settingsState,快捷键等设置与渲染端持久化一致,不再回残缺硬编码
    getSettings: async () => {
      try { return JSON.parse(localStorage.getItem('settingsState') || '{}') || {} } catch { return {} }
    },
    updateSettings: async patch => { console.log('[appBrowserShim] updateSettings', patch); return true },
    writeCriticalStateBackup: async jsonText => { try { localStorage.setItem('appBrowserShim.criticalBackup', jsonText); return true } catch { return false } },
    readCriticalStateBackup: async () => localStorage.getItem('appBrowserShim.criticalBackup'),

    minimize: () => console.log('[shim] minimize'),
    maximize: () => console.log('[shim] maximize'),
    isMaximized: async () => false,
    hideWindow: () => {},
    closeRequest: () => {},

    uploadAttachment: async ({ name, dataBase64, type }) => {
      // 浏览器调试：以 dataURL 形式保存到 localStorage，供预览/持久化
      const mime = type || 'application/octet-stream'
      const url = `data:${mime};base64,${dataBase64}`
      try {
        const files = JSON.parse(localStorage.getItem('appBrowserShim.files') || '[]')
        files.push({ url, name })
        localStorage.setItem('appBrowserShim.files', JSON.stringify(files))
      } catch { /* 配额满时仍返回 url，仅不持久化 */ }
      return { url, size: Math.round(dataBase64.length * 3 / 4) }
    },
    openFile: () => {}, downloadAndOpen: async () => {}, saveToDownloads: async () => {}, deleteFile: async url => {
      try {
        const files = JSON.parse(localStorage.getItem('appBrowserShim.files') || '[]').filter(f => f.url !== url)
        localStorage.setItem('appBrowserShim.files', JSON.stringify(files))
      } catch { /* 空 */ }
      return true
    },
    exportXlsx: async () => console.log('[shim] exportXlsx'),
    notification: opt => console.log('[shim] notification', opt),

    widgetList: async () => [], createWidget: async () => null, openWidget: async () => {},
    closeWidget: async () => {}, deleteWidget: async () => {},
    openCalendarWidget: async () => {}, closeCalendarWidget: async () => {},
    setWidgetsBackground: () => {},

    readOriginalData: async () => ({ ok: false, reason: '浏览器调试模式不支持参考实现数据迁移', tasks: [], categories: [] }),
    // 安全锁加密的5175本地替身:保持'enc1:'前缀契约,否则main.js会把undefined当密码持久化、迁移判定失效
    // (真实现为主进程级加密,5175的base64仅调试宿主内自洽,不得视为安全)
    encryptSecret: async pw => 'enc1:shim:' + btoa(unescape(encodeURIComponent(String(pw)))),
    decryptSecret: async enc => {
      const m = String(enc || '')
      if (!m.startsWith('enc1:shim:')) return m
      try { return decodeURIComponent(escape(atob(m.slice('enc1:shim:'.length)))) } catch { return '' }
    },
    syncNow: async () => ({ ok: false, reason: '浏览器调试模式下无云端同步' }),
    openExternal: url => window.open(url, '_blank'),
    pickAudioFile: async () => null,
    mimeByType: n => (n.endsWith('.html') ? 'text/html' : 'application/octet-stream'),

    onShortcutAction: () => () => {},
    onTomatoTaskbarCmd: () => () => {},
    onShortcutConflict: () => () => {},
    onSelectTodo: () => () => {},
    onOpenSettings: () => () => {},
    onSecurityLock: () => () => {},
    onTodosChanged: fn => { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1) } },
    onWidgetBackground: () => () => {}
  }
  console.log('%c[appBrowserShim] 浏览器降级 API 已启用（localStorage 存储）', 'color:#67c23a')
  // 能力差异清单:防「5175上跑不出桌面行为」被误判为功能bug(历史:日志文件/自动备份/更新器均为此类)
  console.log('%c[appBrowserShim] 桌面有而5175为no-op的能力: logWrite文件日志 / runAutoBackup系列 / setAppLocale / 更新器 / 窗口控制(最小化等仅打印) / 托盘 / 安全锁系统级加密(用shim替身)', 'color:#67c23a')

  // 未知桥接调用统一降级为安全 no-op（如番茄浮窗等新增能力），避免 UI 因缺方法而报错。
  // then/Symbol 必须放行：Proxy 对任意 key 返回函数会让 await window.todoAPI 误判为 thenable
  const _warned = new Set()
  const warnOnce = (key, fn) => { if (!_warned.has(key)) { _warned.add(key); fn() } }
  window.todoAPI = new Proxy(window.todoAPI || {}, {
    get (t, k) {
      if (k in t) return t[k]
      if (k === 'then' || typeof k === 'symbol') return undefined
      warnOnce('api:' + String(k), () => console.warn('[appBrowserShim] todoAPI.' + String(k) + ' 未实现，返回 resolved no-op（对齐 preload 的 Promise 语义）'))
      return () => Promise.resolve(undefined)
    }
  })
})()
