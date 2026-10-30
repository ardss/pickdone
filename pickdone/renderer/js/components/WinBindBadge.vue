<template>
  <!-- win-bind badge (T8): shown only when this task has a bound window.
       Chip language follows td-proj/td-tag in the meta strip; the ✕ rides the
       unified .close-x system (base.css) — no hand-made glyph. -->
  <span v-if="ref" class="td-winbind">
    <button type="button" class="td-winbind__main"
            :title="tip" :aria-label="tip"
            @click.stop="activate">
      <app-icon name="float" :size="12"></app-icon><span class="td-winbind__name">{{ ref.processName }}</span>
    </button>
    <button type="button" class="close-x close-x--sm td-winbind__x"
            :title="$t('statsJ.winbind.unbindTip')" :aria-label="$t('statsJ.winbind.unbindTip')"
            @click.stop="unbind"></button>
  </span>
</template>

<script lang="ts">
/**
 * WinBindBadge — per-row window-binding chip (win-bind T8).
 * Visible ⟺ the task has a binding in the winbind store. Click = one-click
 * window wake-up (winbind/activate); ✕ = unbind (winbind/unbind). All failure
 * copy/toasts are owned by the store actions — the badge stays presentational.
 */
export default {
  name: 'WinBindBadge',
  props: {
    taskId: { type: String, required: true }
  },
  computed: {
    // Defensive read: older stub stores in unit tests may lack the winbind module entirely
    ref (): any {
      const wb = this.$store.state.winbind
      return (wb && wb.bindings && wb.bindings[this.taskId]) || null
    },
    activating (): boolean {
      const wb = this.$store.state.winbind
      return !!(wb && wb.activating === this.taskId)
    },
    tip (): string {
      return this.$t('statsJ.winbind.badgeTip', { name: this.ref.processName || '' })
    }
  },
  methods: {
    activate () { this.$store.dispatch('winbind/activate', this.taskId) },
    unbind () { this.$store.dispatch('winbind/unbind', this.taskId) }
  }
}
</script>
<style>
/* win-bind badge: follows the td-proj chip language (gray pill, brand hover);
   the ✕ stays a bare close-x--sm inline so it never inflates row height */
.td-winbind { display: inline-flex; align-items: center; gap: 1px; vertical-align: middle; }
.td-winbind__main {
  display: inline-flex; align-items: center; gap: 4px; max-width: 140px;
  border: 0; border-radius: var(--radius-sm); padding: 1px 6px;
  font-size: var(--fs-xs); color: var(--text-2); background: var(--gray-bg); cursor: pointer;
  transition: background-color var(--dur-fast), color var(--dur-fast);
}
.td-winbind__main:hover { color: var(--text-1); background: var(--brand-light); }
.td-winbind__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.td-winbind__x { opacity: 0; transition: opacity var(--dur-fast); }
.td-winbind:hover .td-winbind__x, .td-winbind__x:focus-visible { opacity: 1; }
</style>
