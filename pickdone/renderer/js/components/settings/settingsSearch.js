/**
 * Settings search: pure core of the cross-tab settings filter (VS Code/TickTick convention).
 * Extracted from SettingsModal.vue (W5 wave 1). The DOM-level filter walks the expanded
 * .tab-panel nodes and matches rows on "owning section title + own text"; clearing restores
 * the current tab view. The parent keeps the thin wrapper (owns searchQ/searching/searchEmpty
 * state and the nextTick timing); this module is the deterministic filtering logic.
 *
 * @param {NodeList|Array<Element>} panels - the .tab-panel elements inside .settings-modal-body
 * @param {string} q - raw query string (trimmed/lowercased here)
 * @returns {number} totalHits - number of matching rows across all panels
 */
export function filterSettingsPanels (panels, q) {
  q = String(q || '').trim().toLowerCase()
  let totalHits = 0
  panels.forEach(p => {
    const kids = [...p.querySelectorAll('.form-item, .form-label, .hr')]
    // First pass: a form-item hits if "its owning section title + its own text" matches
    let sectionText = ''
    const kind = kids.map(function (el) {
      if (el.classList.contains('form-label')) { sectionText = el.textContent.trim(); return 'label' }
      if (el.classList.contains('hr')) return 'hr'
      return (sectionText + ' ' + el.textContent).toLowerCase().indexOf(q) >= 0 ? 'hit' : 'miss'
    })
    // Second pass: a section title is visible only if a hit exists between it and the next title
    kids.forEach(function (el, idx) {
      if (kind[idx] === 'label') {
        let has = false
        for (let j = idx + 1; j < kids.length && kind[j] !== 'label'; j++) if (kind[j] === 'hit') { has = true; break }
        el.style.display = has ? '' : 'none'
      } else if (kind[idx] === 'hr') {
        el.style.display = 'none'
      } else {
        el.style.display = kind[idx] === 'hit' ? '' : 'none'
        if (kind[idx] === 'hit') totalHits++
      }
    })
    // Third pass: a form shell with no visible rows left collapses too (otherwise search leaves empty card strips behind)
    p.querySelectorAll(':scope > .form').forEach(function (shell) {
      const any = [...shell.querySelectorAll('.form-item, .form-label')].some(el => el.style.display !== 'none')
      shell.style.display = any ? '' : 'none'
    })
  })
  return totalHits
}
