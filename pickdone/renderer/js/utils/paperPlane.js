/**
 * Paper plane fly animation — after task completion/reschedule, flies from the task row to the corresponding sidebar entry (Achieved / Today's todos / Todo box …).
 * Design decisions (finalized by users on 2026-08-29): 650ms arc, brand-colored paper plane, on by default;
 * automatically skipped when prefers-reduced-motion or settings taskFlyAnimation=false.
 */

/** Settings switch: settingsState.taskFlyAnimation !== false (on by default) */
function flyEnabled () {
  try {
    const st = JSON.parse(localStorage.getItem('settingsState') || '{}')
    return st.taskFlyAnimation !== false
  } catch { return true }
}

/**
 * Fly a paper plane from fromPoint (viewport coordinates) to the sidebar entry matching targetText.
 * Silently skipped when fromPoint is missing or the target doesn't exist — animation failure never affects business logic.
 */
export function flyPaperPlane (fromPoint, targetText) {
  try {
    if (!fromPoint || !flyEnabled()) return
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let tEl = null
    const nodes = document.querySelectorAll('.sn-nav-item, .sn-foot-btn')
    for (const el of nodes) {
      if (el.textContent.replace(/\s+/g, '').includes(targetText)) { tEl = el; break }
    }
    if (!tEl) return
    const tr = tEl.getBoundingClientRect()
    const fx = fromPoint.x, fy = fromPoint.y
    const tx = tr.x + tr.width / 2, ty = tr.y + tr.height / 2
    if (fx === tx && fy === ty) return

    const mx = (fx + tx) / 2, my = Math.min(fy, ty) - 140 // lift the arc midpoint upward
    const ang = (a, b) => Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI
    const p0 = { x: fx, y: fy }, p1 = { x: mx, y: my }, p2 = { x: tx, y: ty }

    const plane = document.createElement('div')
    plane.className = 'paper-fly'
    plane.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M2 21 L23 12 L2 3 L6 12 Z" fill="#fff" stroke="var(--brand, #0f9d8f)" stroke-width="1.6" stroke-linejoin="round"/></svg>'
    document.body.appendChild(plane)

    const anim = plane.animate([
      { transform: `translate(${p0.x - 9}px, ${p0.y - 9}px) rotate(${ang(p0, p1)}deg) scale(1)`, opacity: 1, offset: 0 },
      { transform: `translate(${p1.x - 9}px, ${p1.y - 9}px) rotate(${ang(p1, p2)}deg) scale(1.12)`, opacity: 1, offset: 0.55 },
      { transform: `translate(${p2.x - 9}px, ${p2.y - 9}px) rotate(${ang(p1, p2)}deg) scale(.5)`, opacity: 0, offset: 1 }
    ], { duration: 650, easing: 'cubic-bezier(.3,.7,.4,1)' })
    const cleanup = () => { try { plane.remove() } catch {} }
    anim.onfinish = cleanup
    anim.oncancel = cleanup
  } catch (e) { /* the animation is purely decorative, any exception is silently ignored */ }
}
