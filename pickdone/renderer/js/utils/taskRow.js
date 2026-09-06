/** Task-row shared kernel — the task rows of list TodoItem / matrix MatrixGrid / card deck DayDeck / timeline DayRail
 *  Action semantics were already funneled into completeAction.js / confirm.js; what's funneled here is the "same rule" parts:
 *  completion-check coloring, tomato selection. New row-level capabilities (tag/priority display etc.) must be added here — never write another copy in a single component. */
import { DEFAULT_CAT_COLOR } from './core.js'

/** Completion check background color: follows the category-color switch (setting isCompleteCheckboxColorFollow); falls back to brand color when off or uncategorized */
export function chkColor (store, t) {
  const cat = store.getters['category/byId'](t.categoryId)
  if (store.state.settings.isCompleteCheckboxColorFollow && cat) return cat.categoryColor
  return DEFAULT_CAT_COLOR
}

/** Tomato select/deselect: clicking the same task again deselects (goes through tomato/attach to guarantee persistence + cross-window broadcast) */
export function toggleTomatoAttach (store, t) {
  const st = store.state.tomato
  const attach = st.attachTodo && st.attachTodo.taskId === t.taskId ? null : t.taskId
  store.dispatch('tomato/attach', attach)
}

/** Inline coloring style for the completion check (td-check completed state: a white check needs a colored background, otherwise it's invisible) */
export function chkStyle (store, t) {
  if (!t.complete) return {}
  const c = chkColor(store, t)
  return { background: c, borderColor: c }
}
