/**
 * [A1] Fixed-position pop clamping shared by ViewMoreMenu's ⋮ menu (and reusable by any
 * clientX/Y-anchored popover). Pure so the boundary math is unit-testable without a DOM.
 *
 * Left keeps the legacy maint-0925 A13 formula (clamp clientX-190 into [0, innerWidth-220]).
 * Top is the new fix: near a window's bottom edge the old `clientY + 8` let items fall below
 * the viewport; clamp to innerHeight - popHeight - margin so the whole menu stays reachable.
 *
 * @param {number} clientX pointer X
 * @param {number} clientY pointer Y
 * @param {number} popH measured pop height (offsetHeight)
 * @param {number} innerW window.innerWidth
 * @param {number} innerH window.innerHeight
 * @returns {{left:number, top:number}} px values for el.style
 */
export function clampPopPosition (clientX, clientY, popH, innerW, innerH) {
  const left = Math.max(0, Math.min(clientX - 190, innerW - 220))
  const top = Math.max(0, Math.min(clientY + 8, innerH - popH - 8))
  return { left, top }
}
