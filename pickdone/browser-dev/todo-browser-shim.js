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

  // bumpSnow 落点(与桌面 UPDATE todos SET focusMinutes = focusMinutes + @m 同款):找不到行 → missing,软删行 → deleted
  function shimBumpSnowApply (taskId, m) {
    const t = todos.find(x => x.taskId === taskId)
    if (!t) return { ok: false, reason: 'missing' }
    if (t.delete) return { ok: false, reason: 'deleted' }
    t.focusMinutes = (Number(t.focusMinutes) || 0) + m
    t.status = 'update'; t.updatedAt = Date.now()
    save(todos); broadcast()
    return { ok: true, minutes: m }
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
      case 'getById': {
        // 对齐桌面 db.js getById:按 taskId 查单行,无则 null(渲染端 getById 调用方依赖 null 判缺失)
        const id = typeof params === 'string' ? params : (params && params.taskId)
        const row = todos.find(t => t.taskId === String(id))
        return row ? clone(row) : null
      }
      case 'countAll': {
        // 对齐桌面 db.js countAll:全表行数含软删(Onboarding 向导计数调用,2026-09-11 审计补)
        return todos.length
      }
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
      case 'deleteMeta': {
        // 对齐 ALLOWED_RENDERER_OPS:clearSnapshot 等路径会调 deleteMeta,此前被静默吞掉返回 null
        const { key } = normalizeMetaArgs(params)
        if (!key) return false
        let m = {}
        try { m = JSON.parse(localStorage.getItem(META_KEY)) || {} } catch {}
        delete m[key]
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
        // 对齐桌面 src/main/db.js bumpSnow 契约(2026-09-28 此前三个洞):
        // 1) 600 分钟存储钳制(FOCUS_MAX_MINUTES, shared/limits.mjs —— 5175 无 ESM 管线,常量就地镜像并注明单一源)
        // 2) dedupKey 幂等:同 key 重放返回 { ok:true, minutes:0, deduped:true },不重复记账(模糊失败重放曾双倍入账)
        // 3) 落点 todos.focusMinutes += 分钟(此前只写 meta __shimSnow,统计页读 focusMinutes 永远 0)
        // 返回形状与 db.js 同:{ ok:true, minutes } / { ok:false, reason:'missing'|'deleted' }
        {
          const p = (Array.isArray(params) ? params[0] : params) || {}
          const m = Math.max(0, Math.min(600, Math.floor(Number(p.minutes) || 0)))
          if (p.dedupKey != null && p.dedupKey !== '') {
            const dkey = 'snowDedup:' + p.taskId + ':' + p.dedupKey
            let md = {}
            try { md = JSON.parse(localStorage.getItem(META_KEY)) || {} } catch {}
            md.__shimSnowDedup = md.__shimSnowDedup || {}
            if (md.__shimSnowDedup[dkey]) return { ok: true, minutes: 0, deduped: true }
            const r = shimBumpSnowApply(p.taskId, m)
            if (r.ok) {
              md.__shimSnowDedup[dkey] = Date.now()
              try { localStorage.setItem(META_KEY, JSON.stringify(md)) } catch {}
            }
            return r
          }
          return shimBumpSnowApply(p.taskId, m)
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
          // dateKey 无条件由 endTime 重导(与桌面端 db.js tomatoAppendMany 同款):调用方传入值不再被信任,跨午夜记录才不会与统计/时间轴 endTime 口径分裂
          const _d = new Date(rec.endTime)
          const _p = n => String(n).padStart(2, '0')
          rec.dateKey = `${_d.getFullYear()}-${_p(_d.getMonth() + 1)}-${_p(_d.getDate())}`
          if (!/^\d{4}-\d{2}-\d{2}$/.test(String(rec.dateKey))) throw new Error('tomatoAppendMany: dateKey derive failed')
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
      /* LAN 同步 (P3a) 5175 降级替身:lanSync.js 与设备中心 12 个 sync* op 裸调 dbCall。
         可用性优先(用户反馈:浏览器版同步页必须能点、能走完整流程,而不是开关即报错):
         整套做成有状态的模拟节点——开关/设备名/别名/配对码/配对/解除全部落地 localStorage,
         刷新不丢;预置 2 台模拟设备让设备中心开箱即"活"(用户说"创建几个假设备")。
         明确标注 mock:deviceId 带 -mock 后缀,不会与真实局域网语义混淆。 */
      case 'syncGetSettings': {
        let name = '浏览器调试设备'
        try { name = localStorage.getItem('appBrowserShim.syncDeviceName') || name } catch {}
        let on = false
        try { on = localStorage.getItem('appBrowserShim.syncEnabled') === '1' } catch {}
        let secret = false
        try { secret = localStorage.getItem('appBrowserShim.syncPaired') === '1' } catch {}
        return { enabled: on, deviceId: 'browser-shim', deviceName: name, hasPairingSecret: secret }
      }
      case 'syncGetStatus': {
        let on = false
        try { on = localStorage.getItem('appBrowserShim.syncEnabled') === '1' } catch {}
        let paired = false
        try { paired = localStorage.getItem('appBrowserShim.syncPaired') === '1' } catch {}
        // 预置模拟设备:未手动注入 syncPeers 时给两台(一台在线落后、一台离线已同步),开箱即可审查设备卡片
        let peers = null
        try { peers = JSON.parse(localStorage.getItem('appBrowserShim.syncPeers') || 'null') } catch {}
        if (!Array.isArray(peers)) {
          peers = paired ? [
            { deviceId: 'dev-desk-mock', deviceName: '书房台式机', host: '192.168.31.20', port: 58471, online: true, lastRoundAt: Date.now() - 120_000, pendingCount: 3, lastError: null, lastErrorAt: 0, alias: '' },
            { deviceId: 'dev-lap-mock', deviceName: 'MacBook', host: '192.168.31.35', port: 58471, online: false, lastRoundAt: Date.now() - 86_400_000, pendingCount: 0, lastError: null, lastErrorAt: 0, alias: '出门用的' },
          ] : []
        }
        // 附近设备(自动发现):开启且尚未配对时给两台"正在广播"的模拟设备,展示一键配对入口;
        // 配对完成后它们"变成"预置对端,发现列表清空——与真实 mDNS 语义一致
        let manualPeers = null
        try { manualPeers = JSON.parse(localStorage.getItem('appBrowserShim.syncPeers') || 'null') } catch {}
        const discovered = (on && !paired && !Array.isArray(manualPeers)) ? [
          { deviceId: 'dev-near-a-mock', deviceName: '客厅笔记本', host: '192.168.31.42', port: 58471, lastSeen: Date.now() - 5_000 },
          { deviceId: 'dev-near-b-mock', deviceName: 'NAS 工作机', host: '192.168.31.50', port: 58471, lastSeen: Date.now() - 12_000 },
        ] : []
        return { enabled: on, deviceId: 'browser-shim', deviceName: '浏览器调试设备', listening: on, port: on ? 58471 : 0, peers, discovered, lastRoundAt: on ? Date.now() - 65_000 : 0, lastError: null }
      }
      case 'syncSetEnabled': {
        try { localStorage.setItem('appBrowserShim.syncEnabled', params && params.enabled ? '1' : '0') } catch {}
        let name = '浏览器调试设备'
        try { name = localStorage.getItem('appBrowserShim.syncDeviceName') || name } catch {}
        return { enabled: !!(params && params.enabled), deviceId: 'browser-shim', deviceName: name, hasPairingSecret: false }
      }
      case 'syncGetPairingCode': {
        let on = false
        try { on = localStorage.getItem('appBrowserShim.syncEnabled') === '1' } catch {}
        if (!on) return { code: null, expiresAt: 0 }
        // 10 分钟有效(mock):与 shared/pairing-ttl.mjs 的 TTL 对齐,倒计时路径照常走
        const expiresAt = Date.now() + 10 * 60 * 1000
        try { localStorage.setItem('appBrowserShim.pairingCode', JSON.stringify({ code: '482913', expiresAt })) } catch {}
        return { code: '482913', expiresAt }
      }
      case 'syncPairWithCode': {
        // 模拟配对成功:标记已配对 → 下次 syncGetStatus 给出预置设备;真实语义(换密钥断旧对端)不需要在 mock 里复刻
        try { localStorage.setItem('appBrowserShim.syncPaired', '1') } catch {}
        return { ok: true }
      }
      case 'syncUnpairPeer': {
        // 从模拟设备表里摘掉被解除的那台;LS 未注入过则物化预置表再删
        let peers = null
        try { peers = JSON.parse(localStorage.getItem('appBrowserShim.syncPeers') || 'null') } catch {}
        if (!Array.isArray(peers)) {
          peers = [
            { deviceId: 'dev-desk-mock', deviceName: '书房台式机', host: '192.168.31.20', port: 58471, online: true, lastRoundAt: Date.now() - 120_000, pendingCount: 3, lastError: null, lastErrorAt: 0, alias: '' },
            { deviceId: 'dev-lap-mock', deviceName: 'MacBook', host: '192.168.31.35', port: 58471, online: false, lastRoundAt: Date.now() - 86_400_000, pendingCount: 0, lastError: null, lastErrorAt: 0, alias: '出门用的' },
          ]
        }
        peers = peers.filter(p => p.deviceId !== String((params && params.deviceId) || ''))
        try { localStorage.setItem('appBrowserShim.syncPeers', JSON.stringify(peers)) } catch {}
        return { ok: true }
      }
      case 'syncConflictBackupRestore':
        return { ok: true }
      case 'syncPairRequest':
        // 模拟出站配对:记录拨号参数(调试口)并以成功收尾——标记已配对,下次 getStatus 给出
        // 预置设备、发现列表清空。真实语义(对端 60s 确认窗)不在此复刻,但 UI 全流程可走通。
        window.__lastPairRequest = { host: params && params.host, port: params && params.port }
        try { localStorage.setItem('appBrowserShim.syncPaired', '1') } catch {}
        return { ok: true }
      case 'syncSetName':
        try { localStorage.setItem('appBrowserShim.syncDeviceName', String((params && params.name) || '')) } catch {}
        return { deviceName: String((params && params.name) || '') }
      case 'syncSetPeerAlias':
        return { ok: true, alias: String((params && params.alias) || '') }
      case 'syncPairRespond':
        // 模拟入站配对应答:接受 = 标记已配对(设备中心出预置设备),拒绝 = 仅返回 ok
        if (params && params.accept) { try { localStorage.setItem('appBrowserShim.syncPaired', '1') } catch {} }
        return { ok: true }
      case 'syncConflictBackupsList':
        return []
      default:
        // 未实现 op 显式失败(此前返回 null 假成功,调用方把 null 当真结果渲染/入库)。console.warn 曾被 UI 吞掉,排查不到
        throw new Error('[appBrowserShim] dbCall 未实现操作:' + op)
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
    updateSettings: async patch => {
      // 持久化到 LS settingsState(与上方 getSettings 同键):此前只 console.log,5175 改设置刷新即丢
      let cur = {}
      try { cur = JSON.parse(localStorage.getItem('settingsState') || '{}') || {} } catch {}
      localStorage.setItem('settingsState', JSON.stringify(Object.assign({}, cur, patch)))
      return true
    },
    writeCriticalStateBackup: async jsonText => { try { localStorage.setItem('appBrowserShim.criticalBackup', jsonText); return true } catch { return false } },
    readCriticalStateBackup: async () => localStorage.getItem('appBrowserShim.criticalBackup'),

    minimize: () => console.log('[shim] minimize'),
    maximize: () => console.log('[shim] maximize'),
    isMaximized: async () => false,
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
    openFile: () => {}, deleteFile: async url => {
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
    openExternal: url => window.open(url, '_blank'),
    pickAudioFile: async () => null,

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

  // 未知桥接调用的分治策略(d11 round 2):此前兜底对任意未实现方法返回 resolve(undefined) 假成功,
  // 与 dbCall 的"未实现显式 throw"自相矛盾——updateSettings 当年正是走此路径被吞。现改为:
  //   - 只读/UI 型白名单方法(缺了不丢数据)→ resolved no-op(对齐 preload 的 Promise 语义)
  //   - 其余(尤其写类)→ rejected Promise,调用方 catch 得到显式失败,不再静默丢写
  // then/Symbol 必须放行:Proxy 对任意 key 返回函数会让 await window.todoAPI 误判为 thenable
  const _warned = new Set()
  const warnOnce = (key, fn) => { if (!_warned.has(key)) { _warned.add(key); fn() } }
  const NOOP_SAFE = new Set([
    // 窗口/系统控制:5175 无窗口,print 级 no-op 已是既定能力差异
    'minimize', 'maximize', 'isMaximized', 'closeRequest',
    'openExternal', 'notification', 'exportXlsx',
    // 文件打开/导出调试替身(读向)
    'openFile', 'pickAudioFile',
    // 小组件:全是 5175 no-op 能力差异清单成员
    'widgetList', 'createWidget', 'openWidget', 'closeWidget', 'deleteWidget',
    'openCalendarWidget', 'closeCalendarWidget', 'setWidgetsBackground',
    // 事件订阅:返回 disposer 即可
    'onShortcutAction', 'onTomatoTaskbarCmd', 'onShortcutConflict', 'onSelectTodo',
    'onOpenSettings', 'onSecurityLock', 'onWidgetBackground',
    'onAppQuittingFlush', 'onCliTomatoCmd', 'onExternalHabitsChanged', 'onExternalSettingsChanged',
    'onPlaySound', 'onQuickAddFocus', 'onSecurityUnlock', 'onSyncEvent', 'onTomatoRecordsChanged',
    'onWhiteNoiseUpdated', 'onUpdaterEvent',
    // 能力差异清单(:上方 console.log 成员)——5175 无日志文件/自动备份调度/更新器/托盘/系统锁,
    // 这些通道的缺失早已是既定降级,保持 no-op;备份/清空等数据写不在白名单(fail-loud 走 catch)
    'logWrite', 'openLogsDir', 'setAppLocale', 'lockApp', 'setShortcutCapturing',
    'getMetaMany', // 只读批量 meta:与旧兜底一致返回 undefined,调用方已有 (rows||[]) 降级
    'checkForUpdates', 'downloadUpdate', 'quitAndInstall', 'updaterStatus',
    'ensureWindowWidth', 'restoreWindowWidth', 'quickAddHide', 'notifyQuitFlushDone',
    // 番茄浮窗/任务栏:纯窗口 UI,5175 无窗口面
    'showTomatoFloat', 'hideTomatoFloat', 'flushTomatoFloat', 'tomatoFloatPanel', 'tomatoFloatShown',
    'setTomatoFloatBounds', 'startTomatoFloatDrag', 'stopTomatoFloatDrag', 'showMainFromFloat',
    'pushTomatoTaskbar'
  ])
  window.todoAPI = new Proxy(window.todoAPI || {}, {
    get (t, k) {
      if (k in t) return t[k]
      if (k === 'then' || typeof k === 'symbol') return undefined
      if (NOOP_SAFE.has(String(k))) {
        warnOnce('api:' + String(k), () => console.warn('[appBrowserShim] todoAPI.' + String(k) + ' 未实现，返回 resolved no-op（对齐 preload 的 Promise 语义）'))
        return () => Promise.resolve(undefined)
      }
      // 写类/未知方法:显式失败(fail-loud),新桥接方法在桌面端落地前不会再被静默吞掉
      warnOnce('api:' + String(k), () => console.warn('[appBrowserShim] todoAPI.' + String(k) + ' 未实现，返回 rejected Promise（写类未知调用不允许假成功）'))
      return () => Promise.reject(new Error('[appBrowserShim] todoAPI.' + String(k) + ' 未实现(浏览器调试宿主)'))
    }
  })
})()
