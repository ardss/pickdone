/**
 * Insights · achievements wall —— milestone badge system. Pure functions:
 * takes the full todos/records and outputs { earned:[unlocked], inProgress:[next tier + progress per family] }.
 * Badges span five families (total completions/total focus/consecutive days/single-day peak/morning focus), each with its own tier ladder;
 * icons are inline SVG (stroke currentColor, automatically follows the theme color); no emoji.
 * Name/description copy is stored as i18n keys (statsA.Achievements.*), resolved by the consuming component via $t.
 */
import { dayjs, DAY_MS, FMT } from '../../utils/core.js'
import { doneTsOf } from './metrics.js'

/* 24x24 line icons (Feather/Lucide style standard paths, stroke=currentColor follows the theme color) */
const svg = inner => '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>'
const ICONS = {
  done: svg('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>'),
  focus: svg('<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>'),
  streak: svg('<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>'),
  daypeak: svg('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'),
  early: svg('<path d="M17 18a5 5 0 0 0-10 0"/><line x1="12" y1="2" x2="12" y2="9"/><line x1="4.22" y1="10.22" x2="5.64" y2="11.64"/><line x1="1" y1="18" x2="3" y2="18"/><line x1="21" y1="18" x2="23" y2="18"/><line x1="18.36" y1="11.64" x2="19.78" y2="10.22"/><line x1="23" y1="22" x2="1" y2="22"/><polyline points="8 6 12 2 16 6"/>')
}

const A = 'statsA.Achievements.'
const tier = (v, name, desc) => ({ v, nameKey: A + name, descKey: A + desc })

const FAMILIES = [
  {
    id: 'done', icon: ICONS.done, unitKey: A + 'unitCount',
    nameKey: A + 'famDone',
    tiers: [
      tier(25, 'doneT1Name', 'doneT1Desc'),
      tier(100, 'doneT2Name', 'doneT2Desc'),
      tier(500, 'doneT3Name', 'doneT3Desc'),
      tier(1000, 'doneT4Name', 'doneT4Desc')
    ]
  },
  {
    id: 'focus', icon: ICONS.focus, unitKey: A + 'unitHour',
    nameKey: A + 'famFocus',
    tiers: [
      tier(25, 'focusT1Name', 'focusT1Desc'),
      tier(50, 'focusT2Name', 'focusT2Desc'),
      tier(100, 'focusT3Name', 'focusT3Desc'),
      tier(500, 'focusT4Name', 'focusT4Desc')
    ]
  },
  {
    id: 'streak', icon: ICONS.streak, unitKey: A + 'unitDay',
    nameKey: A + 'famStreak',
    tiers: [
      tier(3, 'streakT1Name', 'streakT1Desc'),
      tier(7, 'streakT2Name', 'streakT2Desc'),
      tier(21, 'streakT3Name', 'streakT3Desc'),
      tier(60, 'streakT4Name', 'streakT4Desc')
    ]
  },
  {
    id: 'daypeak', icon: ICONS.daypeak, unitKey: A + 'unitPerDay',
    nameKey: A + 'famDaypeak',
    tiers: [
      tier(5, 'peakT1Name', 'peakT1Desc'),
      tier(10, 'peakT2Name', 'peakT2Desc'),
      tier(20, 'peakT3Name', 'peakT3Desc')
    ]
  },
  {
    id: 'early', icon: ICONS.early, unitKey: A + 'unitTimes',
    nameKey: A + 'famEarly',
    tiers: [
      tier(10, 'earlyT1Name', 'earlyT1Desc'),
      tier(50, 'earlyT2Name', 'earlyT2Desc')
    ]
  }
]

export function buildAchievements ({ todos, records }) {
  // Full totals
  let doneTotal = 0
  const byDay = new Map()
  todos.forEach(t => {
    if (t.delete || !t.complete) return
    const ts = doneTsOf(t)
    if (!ts) return
    doneTotal++
    const k = dayjs(ts).format(FMT.date)
    byDay.set(k, (byDay.get(k) || 0) + 1)
  })
  let focusMins = 0
  let earlyCount = 0
  records.forEach(r => {
    if (r.succeed === false) return
    focusMins += r.focusDuration || 0
    const end = Number(r.endTime) || 0
    if (end && new Date(end).getHours() < 9) earlyCount++
  })
  // Current streak (today being unfinished doesn't break it; counting continues from yesterday)
  let streak = 0
  for (let i = byDay.has(dayjs().format(FMT.date)) ? 0 : 1; i < 3650; i++) {
    if (byDay.has(dayjs(Date.now() - i * DAY_MS).format(FMT.date))) streak++
    else break
  }
  const dayPeak = Math.max(0, ...byDay.values())

  const curOf = {
    done: doneTotal,
    focus: Math.floor(focusMins / 60),
    streak,
    daypeak: dayPeak,
    early: earlyCount
  }

  const families = []
  const earnedBadges = []
  for (const fam of FAMILIES) {
    const cur = curOf[fam.id]
    let hit = 0
    for (const t of fam.tiers) {
      if (cur >= t.v) {
        hit++
        earnedBadges.push({ id: fam.id + t.v, icon: fam.icon, nameKey: t.nameKey, descKey: t.descKey, level: hit })
      }
    }
    const maxed = hit >= fam.tiers.length
    const next = maxed ? null : fam.tiers[hit]
    families.push({
      id: fam.id,
      icon: fam.icon,
      famNameKey: fam.nameKey,
      unitKey: fam.unitKey,
      cur,
      nextV: next ? next.v : fam.tiers[fam.tiers.length - 1].v,
      nextNameKey: next ? next.nameKey : null,
      level: hit,                                   // highest tier reached (0 = none yet)
      totalTiers: fam.tiers.length,
      maxed,
      pct: maxed ? 100 : Math.min(100, Math.round(cur / (next ? next.v : 1) * 100)),
      earnedBadgesOfFam: hit
    })
  }

  return {
    families,                                       // one progress card per family (the UI's main structure)
    earnedBadges,                                   // unlocked badge wall (compact)
    earnedCount: earnedBadges.length,
    totals: { done: doneTotal, focusHours: Math.floor(focusMins / 60), streak }
  }
}
