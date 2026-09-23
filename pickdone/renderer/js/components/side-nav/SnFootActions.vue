<template>
  <!-- Sidebar foot action trio (sync / recycle-bin / settings), extracted verbatim from SideNav.vue.
       Maint/dw-wave2 (domain-2): the expanded (sn-account) and collapsed (sn-collapsed-foot) blocks
       were two parallel near-verbatim copies (same check SVG path, same drag-into-trash bindings,
       same updateReady red dot); they are consolidated here on a `collapsed` prop.
       Pure presentational: sync/go/settings handlers stay in the parent via the events below. -->
  <template v-if="!collapsed">
    <svg v-if="syncDone" class="sn-sync sn-sync--done" viewBox="0 0 24 24" role="img" :aria-label="$t('statsG.SideNav.syncDoneAria')">
      <path d="M20 6L9 17l-5-5" fill="none" stroke="#0c8172" stroke-width="2.4"
            stroke-linecap="round" stroke-linejoin="round" pathLength="1"/>
    </svg>
    <img v-else class="sn-sync" :class="{spinning}" src="app://app/assets/img/icon-sync3.svg" :title="$t('statsG.SideNav.syncTitle')"
         role="button" tabindex="0" :aria-label="$t('statsG.SideNav.syncAria')" @click="$emit('sync')" @keydown.enter.prevent="$emit('sync')">
    <button class="sn-account-gear sn-account-trash" :class="{'drag-ready': dragReady, 'drag-over': trashHot}"
            :title="$t('statsG.SideNav.recycleBinBtn')" :aria-label="$t('statsG.SideNav.recycleBinBtn')"
            @click="$emit('recycle')" @keydown.enter.prevent="$emit('recycle')"
            @dragover="$emit('trash-dragover', $event)" @dragleave="$emit('trash-dragleave')" @drop.prevent="$emit('trash-drop')">
      <app-icon name="trash" :size="14"/>
      <em v-if="recycleCount" class="sn-badge">{{ recycleCount }}</em>
    </button>
    <button class="sn-account-gear" :title="$t('statsG.SideNav.settingsTitle')" :aria-label="$t('statsG.SideNav.settingsAria')" @click="$emit('settings')">
      <app-icon name="gear" :size="15"/>
      <i v-if="updateReady" class="sn-upd-dot" :title="$t('update.readyBadge')"></i>
    </button>
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
    <button class="sn-cog-btn" :title="$t('statsG.SideNav.settingsTitle')" :aria-label="$t('statsG.SideNav.settingsAria')"
            @click="$emit('settings')" @keydown.enter.prevent="$emit('settings')">
      <app-icon name="gear" :size="15"/>
      <i v-if="updateReady" class="sn-upd-dot" :title="$t('update.readyBadge')"></i>
    </button>
  </div>
</template>

<script lang="ts">
/** Sync / recycle-bin / settings trio for the sidebar foot, in both expanded (inside .sn-account)
 *  and collapsed (.sn-collapsed-foot) form. State + handlers live in the parent. */
export default {
  name: 'SnFootActions',
  props: {
    /** false = expanded trio inside the account row; true = the collapsed vertical stack */
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
  emits: ['sync', 'recycle', 'settings', 'trash-dragover', 'trash-dragleave', 'trash-drop']
}
</script>
