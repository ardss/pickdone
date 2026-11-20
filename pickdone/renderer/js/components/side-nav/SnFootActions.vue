<template>
  <!-- Sidebar foot action row (sync / recycle-bin / theme / settings), extracted verbatim from SideNav.vue.
       Maint/dw-wave2 (domain-2): the expanded (sn-account) and collapsed (sn-collapsed-foot) blocks
       were two parallel near-verbatim copies (same check SVG path, same drag-into-trash bindings,
       same updateReady red dot); they are consolidated here on a `collapsed` prop.
       Pure presentational: sync/go/settings handlers stay in the parent via the events below.
       Theme toggle is the one self-contained action: it reads the settings store and dispatches
       settings/update itself (state lives in snThemeToggle.js — SideNav.vue is at its size cap). -->
  <template v-if="!collapsed">
    <!-- Icon cluster: the four actions sit in their own 4px-gap row so the added theme button
         costs the account name almost nothing — with the sidebar's 8px parent gap the 4th icon
         squeezed "离线用户" into "离线…" (measured in the beta.40 GUI: 48px box vs 52px text). -->
    <span class="sn-foot-cluster">
      <svg v-if="syncDone" class="sn-sync sn-sync--done" viewBox="0 0 24 24" role="img" :aria-label="$t('statsG.SideNav.syncDoneAria')">
        <path d="M20 6L9 17l-5-5" fill="none" stroke="#0c8172" stroke-width="2.4"
              stroke-linecap="round" stroke-linejoin="round" pathLength="1"/>
      </svg>
      <img v-else class="sn-sync" :class="{spinning}" src="app://app/assets/img/icon-sync3.svg" alt="" :title="$t('statsG.SideNav.syncTitle')"
           role="button" tabindex="0" :aria-label="$t('statsG.SideNav.syncAria')" data-act="sync"
           @click="$emit('sync')" @keydown="onActivateKey">
      <button class="sn-account-gear sn-account-trash" :class="{'drag-ready': dragReady, 'drag-over': trashHot}"
              :title="$t('statsG.SideNav.recycleBinBtn')" :aria-label="$t('statsG.SideNav.recycleBinBtn')"
              @click="$emit('recycle')" @keydown.enter.prevent="$emit('recycle')"
              @dragover="$emit('trash-dragover', $event)" @dragleave="$emit('trash-dragleave')" @drop.prevent="$emit('trash-drop')">
        <app-icon name="trash" :size="14"/>
        <em v-if="recycleCount" class="sn-badge">{{ recycleCount }}</em>
      </button>
      <button class="sn-account-gear sn-theme-toggle" data-act="theme"
              :title="$t(themeToggleLabelKey)" :aria-label="$t(themeToggleLabelKey)"
              :aria-pressed="isDark ? 'true' : 'false'" @click="toggleTheme" @keydown.enter.prevent="toggleTheme">
        <app-icon :name="isDark ? 'sun' : 'moon'" :size="14"/>
      </button>
      <button class="sn-account-gear" :title="$t('statsG.SideNav.settingsTitle')" :aria-label="$t('statsG.SideNav.settingsAria')" @click="$emit('settings')">
        <app-icon name="gear" :size="15"/>
        <i v-if="updateReady" class="sn-upd-dot" :title="$t('update.readyBadge')"></i>
      </button>
    </span>
  </template>
  <div v-else class="sn-collapsed-foot">
    <!-- Sync is also added to the collapsed state (user-finalized): the account row hides entirely when collapsed; sync/recycle bin/settings stack vertically -->
    <button class="sn-cog-btn" :title="$t('statsG.SideNav.syncTitle')" :aria-label="$t('statsG.SideNav.syncAria')"
            @click="$emit('sync')" @keydown.enter.prevent="$emit('sync')">
      <svg v-if="syncDone" class="sn-sync sn-sync--done" viewBox="0 0 24 24" role="img" :aria-label="$t('statsG.SideNav.syncDoneAria')">
        <path d="M20 6L9 17l-5-5" fill="none" stroke="#0c8172" stroke-width="2.4"
              stroke-linecap="round" stroke-linejoin="round" pathLength="1"/>
      </svg>
      <img v-else class="sn-sync" :class="{spinning}" src="app://app/assets/img/icon-sync3.svg" alt="">
    </button>
    <button class="sn-cog-btn" :class="{'drag-ready': dragReady, 'drag-over': trashHot}"
            :title="$t('statsG.SideNav.recycleBinBtn')" :aria-label="$t('statsG.SideNav.recycleBinBtn')"
            @click="$emit('recycle')" @keydown.enter.prevent="$emit('recycle')"
            @dragover="$emit('trash-dragover', $event)" @dragleave="$emit('trash-dragleave')" @drop.prevent="$emit('trash-drop')">
      <app-icon name="trash" :size="15"/>
    </button>
    <button class="sn-cog-btn sn-theme-toggle" data-act="theme"
            :title="$t(themeToggleLabelKey)" :aria-label="$t(themeToggleLabelKey)"
            :aria-pressed="isDark ? 'true' : 'false'" @click="toggleTheme" @keydown.enter.prevent="toggleTheme">
      <app-icon :name="isDark ? 'sun' : 'moon'" :size="15"/>
    </button>
    <button class="sn-cog-btn" :title="$t('statsG.SideNav.settingsTitle')" :aria-label="$t('statsG.SideNav.settingsAria')"
            @click="$emit('settings')" @keydown.enter.prevent="$emit('settings')">
      <app-icon name="gear" :size="15"/>
      <i v-if="updateReady" class="sn-upd-dot" :title="$t('update.readyBadge')"></i>
    </button>
  </div>
</template>

<script lang="ts">
import { roleButtonActivate } from '../../utils/roleButtonKey.js'
import { isDarkNow, themeLabelKey, toggleThemeMode, trackSystemScheme, untrackSystemScheme } from './themeToggle.js'

/** Sync / recycle-bin / theme / settings row for the sidebar foot, in both expanded (inside
 *  .sn-account) and collapsed (.sn-collapsed-foot) form. Sync/recycle/settings state + handlers
 *  live in the parent; the theme toggle owns its own store interaction (themeToggle.js) but
 *  declares its members here — the structure guard pins every template identifier to a
 *  declaration on the component. */
export default {
  name: 'SnFootActions',
  props: {
    /** false = expanded row inside the account card; true = the collapsed vertical stack */
    collapsed: { type: Boolean, default: false },
    /** sync icon spinning while the sync dispatch is in flight */
    spinning: { type: Boolean, default: false },
    /** brief post-sync checkmark state */
    syncDone: { type: Boolean, default: false },
    /** a category row is being dragged (arms the trash as a drop target) */
    dragReady: { type: Boolean, default: false },
    /** trash highlight while a category drag hovers it */
    trashHot: { type: Boolean, default: false },
    /** soft-deleted entry count (badge; expanded trash only) */
    recycleCount: { type: Number, default: 0 },
    /** updater "ready to install" red dot on the gear */
    updateReady: { type: Boolean, default: false }
  },
  emits: ['sync', 'recycle', 'settings', 'trash-dragover', 'trash-dragleave', 'trash-drop'],
  data: () => ({
    /** live OS scheme, only consulted while colorMode === 'system' */
    sysDark: false,
    sysMql: null,
    sysSchemeListener: null
  }),
  computed: {
    /** resolved theme right now (explicit mode wins; 'system' follows the Windows setting) */
    isDark () { return isDarkNow(this) },
    /** label names the destination, not the state: "switch to light/dark mode" */
    themeToggleLabelKey () { return themeLabelKey(this.isDark) }
  },
  mounted () { trackSystemScheme(this) },
  beforeUnmount () { untrackSystemScheme(this) },
  methods: {
    // [D15-A13] the expanded sync icon is a role="button" <img>: ARIA button pattern requires
    // Space as well as Enter (the surrounding trash/gear are real <button>s — natively fine)
    onActivateKey: roleButtonActivate(function (e) { this.$emit(e.currentTarget.getAttribute('data-act') || 'sync') }),
    toggleTheme () { return toggleThemeMode(this) }
  }
}
</script>

<style>
/* Four icons in one 250px row: the cluster carries its own 4px gap so the added theme button
   does not eat the account name (with the sidebar's 8px parent gap the 4th icon ellipsized
   "离线用户" to "离线…" — measured in the beta.40 GUI: 48px box vs 52px text).
   Deliberately unscoped: the repo pins against scoped SFC styles (global cascade contract).
   The class name is unique to this component, so a global rule is safe. */
.sn-foot-cluster { display: flex; align-items: center; gap: 4px; }
</style>
