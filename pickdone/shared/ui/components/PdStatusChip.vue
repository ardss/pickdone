<script setup>
defineProps({ tone: { type: String, default: 'neutral', validator: value => ['neutral', 'brand', 'success', 'warning', 'danger'].includes(value) } })
</script>
<template>
  <span class="pd-chip" :class="`pd-chip--${tone}`"><slot /></span>
</template>
<style scoped>
.pd-chip{display:inline-flex;align-items:center;max-width:100%;padding:var(--pd-space-1) var(--pd-space-2);border-radius:var(--pd-radius-sm);font:600 11px var(--pd-font);white-space:nowrap}
.pd-chip--neutral{color:var(--pd-text-secondary);background:var(--pd-background)}
.pd-chip--brand{color:var(--pd-brand-strong);background:var(--pd-brand-soft)}
.pd-chip--success{color:var(--pd-success);background:var(--pd-success-soft)}
.pd-chip--warning{color:var(--pd-warning);background:var(--pd-warning-soft)}
.pd-chip--danger{color:var(--pd-danger);background:var(--pd-danger-soft)}
</style>