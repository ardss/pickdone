/**
 * Named usage scenarios — deep-partial patches over the default config.
 * Multipliers are relative to whatever the base config carries so a user-edited
 * base still gets a coherent pessimistic/heavy spread.
 */
import { mergeDeep } from './cost-model.mjs'

export const SCENARIOS = {
  neutral: { label: 'Neutral — as configured' },
  pessimistic: {
    label: 'Pessimistic — half the paid share, 1.5x volume, slower growth',
    patch: {
      users: { paidShare: null }, // resolved relative to base at apply time (see below)
      growth: { monthly: null },
    },
  },
  heavy: {
    label: 'Heavy — 3x change volume, 2x payload, +1 device per user',
    patch: {},
  },
}

/** Applies a scenario relative to a base config (relative multipliers). */
export function applyScenario(base, name) {
  if (!SCENARIOS[name]) throw new Error(`unknown scenario "${name}" (have: ${Object.keys(SCENARIOS).join(', ')})`)
  if (name === 'neutral') return { config: base, label: SCENARIOS.neutral.label }
  const u = base.usage
  if (name === 'pessimistic') {
    const config = mergeDeep(base, {
      users: { paidShare: base.users.paidShare * 0.5 },
      usage: { changesPerDeviceActiveDay: u.changesPerDeviceActiveDay * 1.5, payloadBytesPerChange: u.payloadBytesPerChange * 1.5 },
      growth: { monthly: base.growth.monthly * 0.5 },
    })
    return { config, label: SCENARIOS.pessimistic.label }
  }
  const config = mergeDeep(base, {
    usage: {
      changesPerDeviceActiveDay: u.changesPerDeviceActiveDay * 3,
      payloadBytesPerChange: u.payloadBytesPerChange * 2,
      devicesPerUser: u.devicesPerUser + 1,
    },
  })
  return { config, label: SCENARIOS.heavy.label }
}
