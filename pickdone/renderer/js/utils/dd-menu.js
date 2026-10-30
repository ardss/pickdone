/**
 * [W8] Shared keyboard contract for the custom .dd-menu dropdown-select popovers
 * (role="listbox" ul + role="option" li pattern, same as TodoBoxView's dropdowns).
 *
 * Extracted from TodoBoxView.ddMenuKey (maint-0924 A8) so other views can reuse the exact
 * semantics without each hand-rolling a variant. TodoBoxView itself keeps its local copy for
 * now (regression-averse); a later wave can migrate it onto this util.
 *
 * Behavior:
 *  - ArrowDown/ArrowUp cycle focus across the menu items ([role="option"] or li), wrapping
 *    at both ends (items are tabindex="0", so Tab also works — arrows are the menu gesture).
 *  - Escape closes the popover (via the opts.onClose callback: hide the el-popover ref +
 *    null the open-state flag) and refocuses the trigger, because the popper content is
 *    teleported to body — the trigger must be recovered inside the component tree.
 */
export function ddMenuKey (e, { onClose } = {}) {
  const menu = e.currentTarget
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const items = Array.prototype.slice.call(menu.querySelectorAll('[role="option"], li'))
    if (!items.length) return
    const i = items.indexOf(document.activeElement)
    const j = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length
    if (items[j]) items[j].focus()
  } else if (e.key === 'Escape' && onClose) {
    e.stopPropagation()
    onClose()
  }
}
