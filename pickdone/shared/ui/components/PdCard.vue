<script setup>
defineProps({ as: { type: String, default: 'article' }, interactive: Boolean })
</script>
<template>
  <component :is="as" class="pd-card" :class="{ 'pd-card--interactive': interactive }"><slot /></component>
</template>
<style scoped>
.pd-card{display:block;padding:var(--pd-space-4);background:var(--pd-surface);color:var(--pd-text);border:1px solid var(--pd-border);border-radius:var(--pd-radius-lg);box-shadow:var(--pd-shadow-card)}
.pd-card--interactive:focus-within{border-color:var(--pd-brand);box-shadow:var(--pd-focus-ring)}
</style>