/**
 * Unified task context-menu builder: all views (card / four-quadrant / timeline / calendar / todo box / filter) share one action set,
 * trimmed per view capability via caps (e.g. views without sorting don't get move-up/move-down items).
 * Inline action semantics all go through the unified utils-layer exits: deleteWithUndo (includes repeating-task confirmation) / tomato attach.
 */
import { dayjs, FMT } from './core.js'
import { deleteWithUndo, moveWithUndo } from './confirm.js'
import { toggleCompleteWithUndo } from './completeAction.js'

/**
 * @param {Object} vm component instance (needs $t/$store/$message)
 * @param {Object} t task object (the raw record in the store)
 * @param {Object} [caps] capability switches: { edit, complete, move, tomato, copy, del }, all on by default
 */
export function buildTaskMenu (vm, t, caps = {}, extra = []) {
  const c = { edit: true, complete: true, move: true, tomato: true, copy: true, del: true, recycle: false, ...caps }
  // recycle view passes rows with t.delete=true: skip the soft-delete guard; menu items come entirely from extra (restore/purge)
  if (!t || (t.delete && !c.recycle)) return []
  const raw = () => vm.$store.state.todo.todoList.find(x => x.taskId === t.taskId) || t
  const items = []
  if (c.edit) {
    items.push({ icon: 'edit', label: vm.$t('statsE.TodoItem.openEditor'), fn: () => vm.$store.commit('ui/openEdit', raw()) })
  }
  if (c.complete) {
    items.push({
      icon: 'check',
      label: t.complete ? vm.$t('statsE.TodoItem.markIncomplete') : vm.$t('statsJ.TodoItem.markDone'),
      fn: () => toggleCompleteWithUndo({ store: vm.$store, message: vm.$message, todo: raw(), announce: m => vm.$announce && vm.$announce(m) })
    })
  }
  if (c.move) {
    // Same semantics as TodoItem.moveDay: the target date lands on todoTime (dayStart derived by updateTodoFields);
    // menu click = explicit operation, must carry the 5s undo toast (same layer as row-inline moveDay; drag stays silent by design)
    const move = (offset) => {
      const cur = raw()
      const base = cur.todoTime ? dayjs(cur.todoTime) : dayjs().startOf('day')
      const target = offset === 0
        ? +dayjs().startOf('day')
        : Math.max(+dayjs().add(offset, 'day').startOf('day'), +base.add(offset, 'day').startOf('day'))
      const orig = cur.todoTime
      moveWithUndo(vm, {
        label: vm.$t(offset === 0 ? 'statsJ.TodoItem.movedToToday' : 'statsJ.TodoItem.movedToTomorrow'),
        apply: () => vm.$store.dispatch('todo/updateTodoFields', { taskId: cur.taskId, patch: { todoTime: target, status: 'update' } }),
        revert: () => vm.$store.dispatch('todo/updateTodoFields', { taskId: cur.taskId, patch: { todoTime: orig, status: 'update' } })
      })
    }
    items.push({ icon: 'calendar', label: vm.$t('statsE.TodoItem.moveToToday'), fn: () => move(0) })
    items.push({ icon: 'clock', label: vm.$t('statsE.TodoItem.postponeToTomorrow'), fn: () => move(1) })
  }
  if (c.tomato && !t.complete) {
    items.push({
      icon: 'clock',
      label: vm.$t('statsE.TodoItem.togglePomodoroFocus'),
      fn: () => {
        const st = vm.$store.state.tomato
        const attach = st.attachTodo && st.attachTodo.taskId === t.taskId ? null : t.taskId
        vm.$store.dispatch('tomato/attach', attach)
      }
    })
  }
  if (c.tomato) {
    // One-step backfill (user feedback: "actual" in the panel is read-only, missed focus needs an entry point) — creates a real record already linked to this task; actual tomatoes +1 and reconcilable on the timeline
    const backfill = (min) => {
      const cur = raw()
      const min2 = Math.max(1, Math.min(240, min))
      const startTs = Math.max(+dayjs().startOf('day'), Date.now() - min2 * 60000)
      vm.$store.commit('tomato/addRecord', {
        tomatoId: 'tmt_m_' + startTs + '_' + min2, endTime: startTs + min2 * 60000,
        dateKey: dayjs(startTs).format(FMT.date),
        focus: cur.taskContent || '', focusTaskId: cur.taskId, focusDuration: min2, rest: 0, restDuration: 0,
        succeed: true, status: 'local', manual: true
      })
      vm.$message.success(vm.$t('statsJ.TodoItem.backfilled', { n: min2, name: cur.taskContent || vm.$t('statsJ.TodoItem.untitled') }))
    }
    items.push({
      icon: 'timer',
      label: vm.$t('statsG.DayRail.manualAdd'),
      fn: () => {
        vm.$prompt(vm.$t('statsG.DayRail.manualPrompt'), vm.$t('statsG.DayRail.manualAdd'), {
          inputValue: '25',
          inputPattern: /^\d{1,3}$/,
          inputErrorMessage: vm.$t('statsG.DayRail.manualInvalid')
        }).then(({ value }) => backfill(parseInt(value, 10))).catch(() => {})
      }
    })
  }
  if (c.copy) {
    items.push({
      icon: 'copy',
      label: vm.$t('statsE.TodoItem.copyTitleDesc'),
      fn: async () => {
        await navigator.clipboard.writeText((t.taskContent || '') + '\n' + (t.taskDescribe || ''))
        vm.$message.success(vm.$t('statsE.TodoItem.copiedMsg'))
      }
    })
  }
  if (c.del) {
    items.push({ sep: true })
    items.push({ icon: 'trash', label: vm.$t('statsE.TodoItem.moveToRecycleBin'), danger: true, fn: () => deleteWithUndo(vm, vm.$store, raw()) })
  }
  if (extra.length && items.length) items.push({ sep: true })
  items.push(...extra)
  return items
}

/** Generic @contextmenu handler for view rows: builds the menu and opens it */
export function taskContextMenu (vm, t, e, caps, extra) {
  e.preventDefault()
  const items = buildTaskMenu(vm, t, caps, extra)
  if (!items.length) return
  vm.$store.commit('ui/openMenu', { x: e.clientX + 2, y: e.clientY + 2, items })
}
