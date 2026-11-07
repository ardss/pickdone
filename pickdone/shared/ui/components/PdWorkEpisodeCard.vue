<script setup>
import PdCard from './PdCard.vue'
</script>
<template>
  <PdCard class="pd-episode"><slot /></PdCard>
</template>
<style scoped>
.pd-episode{display:flex;flex-direction:column;gap:var(--pd-space-2)}
</style>