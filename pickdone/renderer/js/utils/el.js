/**
 * Resolve a component ref to its nearest host Element.
 *
 * Element Plus component refs expose `$el`, which may be a comment or text node
 * (single-root components rendered inside slots/fragments), so `ref.$el.querySelector`
 * can be missing. Callers should not re-implement per-site defensive branches; this
 * is the single contract: return the element when the ref renders one, its parent
 * element for comment/text nodes, and null when there is nothing usable.
 * Uses nodeType rather than `instanceof Element` so it also runs under node --test.
 */
export function $elOf (ref) {
  const el = ref && ref.$el
  if (!el) return null
  return el.nodeType === 1 ? el : (el.parentElement || null)
}
