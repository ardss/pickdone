<script setup>
import PdCard from './PdCard.vue'
</script>
<template>
  <PdCard class="pd-project"><slot /></PdCard>
</template>
<style scoped>
.pd-project{display:flex;align-items:center;gap:var(--pd-space-3);min-height:76px}
</style>