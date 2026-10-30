<template>
  <!-- W21 split (2026-10-30): markup only — restoreFromBin (with the [w20] flush-before-takeDirty
       comment block) stays in the host EditPanel.vue, which owns the save queue and the single
       todo/restoreFromRecycle entry. -->
  <div class="ep-recycle-banner">
    <i class="ico" style="--ico:url('app://app/assets/img/delete_black_48dp.svg');width:16px;height:16px"></i>
    <span>{{ $t('statsJ.EditPanel.recycleBinEditTip') }}</span>
    <button class="mini" @click="$emit('restore')">{{ $t('statsJ.EditPanel.restoreBtn') }}</button>
  </div>
</template>

<script lang="ts">
export default {
  name: 'EpBinBanner',
  emits: ['restore'] as any
}
</script>
