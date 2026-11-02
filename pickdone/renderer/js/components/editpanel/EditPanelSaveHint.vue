<template>
  <!-- [w30 P0] weak "保存未确认" hint: the edit IS in the safeUpsert retry queue (quit-flush will
       land it) but SQLite has not confirmed the write — warning tint, NOT the hard danger banner. -->
  <div v-if="show" class="ep-save-failed ep-save-unconfirmed" role="status">{{ $t('statsJ.EditPanel.saveUnconfirmed') }}<span class="ep-save-retry" role="button" tabindex="0" :aria-label="$t('statsJ.EditPanel.saveRetry')" @click="$emit('retry')" @keydown.enter.prevent="$emit('retry')">{{ $t('statsJ.EditPanel.saveRetry') }}</span></div>
</template>

<script lang="ts">
/** W30 split: the enqueue-vs-persisted weak hint's markup (keeps EditPanel.vue at its ratchet
 *  bound; same doctrine as EpBinBanner — host owns the state, child owns the markup). */
export default {
  name: 'EpSaveHint',
  props: { show: { type: Boolean as any, default: false } },
  emits: ['retry']
}
</script>
