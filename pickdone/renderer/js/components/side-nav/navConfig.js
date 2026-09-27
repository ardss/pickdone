/**
 * SideNav main-nav constants, extracted verbatim from SideNav.vue (size-ratchet split).
 * Icons/copy/order are all derived from views/registry.js (single source of truth); labelKey is resolved via navLabel() at render time -- there is no component context at module top level, calling this.$t directly would blow up the whole module (white screen)
 */
import { NAV_ITEMS } from '../../views/registry.js'

export const NAV_ICON = Object.fromEntries(NAV_ITEMS.map(n => [n.route, n.icon]))
export const NAV_LABEL = Object.fromEntries(NAV_ITEMS.map(n => [n.route, { i18n: n.labelKey }]))
export const NAV_ORDER = NAV_ITEMS.map(n => n.route)
