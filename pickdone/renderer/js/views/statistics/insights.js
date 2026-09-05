/**
 * Insights · rule layer + composition layer —— consumes metrics.js output to produce local rule-based narrative.
 * Rule = { id, kind:'insight'|'advice', prio, when(m), weight(m), text(m) }:
 *   a rule enters the candidate pool only when `when` matches; weight is the magnitude of change (within the same priority, larger magnitudes rank first);
 *   text returns a { mainKey, mainParams, hlKey, hlParams } structure (i18n key + interpolation params),
 *   resolved into final copy by the consuming component (StatisticsView) via $t; hl marks the numeric fragment to highlight in the sentence.
 * compose(m): top 5 insights and top 2 pieces of advice, plus one headline sentence. Pure functions, deterministic output.
 */
import { pctDiff } from './metrics.js'

const K = 'statsA.Insights.'

/* Copy fragment builder: stores only key + params; no resolution in the pure-function layer (no component instance available) */
const msg = (key, params, hlKey, hlParams) => ({
  mainKey: K + key,
  mainParams: params,
  hlKey: hlKey ? K + hlKey : null,
  hlParams: hlParams || null
})

/** Significance threshold: below this magnitude counts as "about the same as usual" and produces no insight (avoids noise) */
const SIG = 15

const RULES = [
  {
    id: 'focus-delta', kind: 'insight', prio: 1,
    when: m => m.baseline.hasHistory && pctDiff(m.focusMins, m.baseline.focus) != null,
    weight: m => Math.abs(pctDiff(m.focusMins, m.baseline.focus)),
    text: m => {
      const d = pctDiff(m.focusMins, m.baseline.focus)
      return d >= SIG
        ? msg('focusDeltaUp', { d }, 'hlPct', { d })
        : msg('focusDeltaDown', { d: Math.abs(d) }, 'hlPct', { d: Math.abs(d) })
    }
  },
  {
    id: 'done-delta', kind: 'insight', prio: 2,
    when: m => m.baseline.hasHistory && pctDiff(m.done, m.baseline.done) != null && m.done > 0,
    weight: m => Math.abs(pctDiff(m.done, m.baseline.done)),
    text: m => {
      const d = pctDiff(m.done, m.baseline.done)
      return d >= SIG
        ? msg('doneDeltaUp', { d }, 'hlPct', { d })
        : msg('doneDeltaDown', { d: Math.abs(d) }, 'hlPct', { d: Math.abs(d) })
    }
  },
  {
    id: 'peak-hours', kind: 'insight', prio: 2,
    when: m => m.peakHours && m.peakHours.share >= 30,
    weight: m => m.peakHours.share,
    text: m => msg('peakHours',
      { sh: m.peakHours.startHour, eh: m.peakHours.endHour, share: m.peakHours.share },
      'hlHourRange', { sh: m.peakHours.startHour, eh: m.peakHours.endHour })
  },
  {
    id: 'attribution', kind: 'insight', prio: 2,
    when: m => m.catFocus.length && m.focusMins >= 60 && m.catFocus[0].value / m.focusMins >= 0.4,
    weight: m => m.catFocus[0].value / m.focusMins * 100,
    text: m => {
      const share = Math.round(m.catFocus[0].value / m.focusMins * 100)
      return msg('attribution', { share, label: m.catFocus[0].label }, 'hlPct', { d: share })
    }
  },
  {
    id: 'giveup-spike', kind: 'insight', prio: 3,
    when: m => m.baseline.hasHistory && m.giveUps >= 2 && pctDiff(m.giveUps, m.baseline.giveUps) >= 50,
    weight: m => pctDiff(m.giveUps, m.baseline.giveUps),
    text: m => msg('giveupSpike', { n: m.giveUps }, 'hlCount', { n: m.giveUps })
  },
  {
    // Give-up rate: no baseline needed; the absolute ratio itself is a health signal (threshold: at least 4 starts with a give-up rate of 30% or more)
    id: 'giveup-rate', kind: 'insight', prio: 3,
    when: m => (m.tomatoCount + m.giveUps) >= 4 && m.giveUps / (m.tomatoCount + m.giveUps) >= 0.3,
    weight: m => m.giveUps / (m.tomatoCount + m.giveUps) * 100,
    text: m => {
      const pct = Math.round(m.giveUps / (m.tomatoCount + m.giveUps) * 100)
      return msg('giveupRate', { pct, n: m.giveUps }, 'hlPct', { d: pct })
    }
  },
  {
    // Focus left no completion record: either tasks were finished without being checked off, or focus was fragmented
    id: 'focus-no-done', kind: 'insight', prio: 3,
    when: m => m.focusNoDoneDays >= 2,
    weight: m => m.focusNoDoneDays,
    text: m => msg('focusNoDone', { n: m.focusNoDoneDays }, 'hlDays', { n: m.focusNoDoneDays })
  },
  {
    // Cross-metric positive loop: on days with focus, completions noticeably outpace days without focus
    id: 'sync-up', kind: 'insight', prio: 4,
    when: m => m.focusDaysAvgDone != null && m.noFocusDaysAvgDone != null &&
               m.focusDaysAvgDone >= 1 && m.focusDaysAvgDone >= m.noFocusDaysAvgDone * 1.5,
    weight: m => m.focusDaysAvgDone,
    text: m => msg('syncUp',
      { a: m.focusDaysAvgDone.toFixed(1), b: m.noFocusDaysAvgDone.toFixed(1) },
      'hlCount', { n: m.focusDaysAvgDone.toFixed(1) })
  },
  {
    id: 'streak', kind: 'insight', prio: 4,
    when: m => m.streak >= 3,
    weight: m => m.streak,
    text: m => msg('streak', { n: m.streak }, 'hlDays', { n: m.streak })
  },
  {
    id: 'quiet', kind: 'insight', prio: 0,
    when: m => m.done === 0 && m.focusMins === 0,
    weight: () => 999,
    text: () => msg('quiet')
  },
  /* ---------- Advice rules: at most 2 per period ---------- */
  {
    id: 'overload', kind: 'advice', prio: 1,
    when: m => m.planned >= 3 && m.doneRate != null && m.doneRate <= 0.4,
    weight: m => (1 - m.doneRate) * 100,
    text: m => msg('overload', { planned: m.planned, rate: Math.round(m.doneRate * 100) })
  },
  {
    id: 'conservative', kind: 'advice', prio: 2,
    when: m => m.planned >= 5 && m.doneRate >= 0.95,
    weight: m => m.doneRate * 100,
    text: m => msg('conservative', { rate: Math.round(m.doneRate * 100) })
  },
  {
    id: 'backlog', kind: 'advice', prio: 2,
    when: m => m.added >= m.done + 5 && m.added >= 8,
    weight: m => m.added - m.done,
    text: m => msg('backlog', { added: m.added, done: m.done })
  },
  {
    id: 'use-peak', kind: 'advice', prio: 3,
    when: m => m.peakHours && m.focusMins >= 60 && m.peakHours.share >= 25 && m.peakHours.startHour >= 14,
    weight: m => m.peakHours.share,
    text: m => msg('usePeak', { h: m.peakHours.startHour })
  }
]

/** Headline verdict relative to the baseline: focus as the primary axis, completion as the secondary (returns key+params, resolved by the component via $t) */
function headline (m) {
  const fd = m.baseline.hasHistory ? pctDiff(m.focusMins, m.baseline.focus) : null
  const base = { key: K + 'headline', params: { label: m.label, done: m.done }, focusMins: m.focusMins }
  if (m.done === 0 && m.focusMins === 0) return { ...base, toneKey: K + 'headlineRest' }
  // No valid baseline or not significant: state the facts only, no empty talk like "about the same as baseline"
  if (fd == null || Math.abs(fd) < SIG) return { ...base, toneKey: null }
  return fd >= SIG ? { ...base, toneKey: K + 'headlineMore' } : { ...base, toneKey: K + 'headlineLess' }
}

/**
 * Composition: { headline:{key,params,focusMins,toneKey}, insights:[{id,mainKey,mainParams,hlKey,hlParams}], advice:[same shape] }
 * Insights sort by prio ascending (smaller = more important), then by magnitude descending within the same priority; top N of each.
 */
export function composeReview (m) {
  const hit = RULES.filter(r => r.when(m))
  const sortRules = (a, b) => a.prio - b.prio || b.weight(m) - a.weight(m)
  const insights = hit.filter(r => r.kind === 'insight').sort(sortRules).slice(0, 5).map(r => ({ id: r.id, ...r.text(m) }))
  const advice = hit.filter(r => r.kind === 'advice').sort(sortRules).slice(0, 2).map(r => ({ id: r.id, ...r.text(m) }))
  return { headline: headline(m), insights, advice }
}

/** Delta descriptor for the KPI comparison bars: { pct, dir }, dir: up|down|flat */
export function kpiDelta (cur, base, sig = SIG) {
  const d = pctDiff(cur, base)
  if (d == null || Math.abs(d) < sig) return null
  return { pct: (d > 0 ? '+' : '') + d + '%', dir: d > 0 ? 'up' : 'down' }
}
