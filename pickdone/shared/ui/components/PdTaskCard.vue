<script setup>
import PdCard from './PdCard.vue'
defineProps({ done: Boolean })
</script>
<template>
  <PdCard class="pd-task" :class="{ 'pd-task--done': done }" interactive><slot /></PdCard>
</template>
<style scoped>
.pd-task{display:flex;align-items:center;gap:var(--pd-space-3);min-height:72px;padding:var(--pd-space-3) var(--pd-space-4)}
.pd-task--done{opacity:.8}
</style>