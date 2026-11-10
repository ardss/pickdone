<script setup>
defineProps({
  tone: { type: String, default: 'primary', validator: value => ['primary', 'secondary', 'quiet', 'danger'].includes(value) },
  type: { type: String, default: 'button' },
  block: Boolean,
  disabled: Boolean
})
</script>
<template>
  <button class="pd-action" :class="[`pd-action--${tone}`, { 'pd-action--block': block }]" :type="type" :disabled="disabled"><slot /></button>
</template>
<style scoped>
.pd-action{display:inline-flex;align-items:center;justify-content:center;gap:var(--pd-space-2);min-height:44px;padding:var(--pd-space-2) var(--pd-space-4);border:1px solid transparent;border-radius:var(--pd-radius-md);font:600 14px var(--pd-font);cursor:pointer;transition:background-color .15s,border-color .15s,color .15s}
.pd-action--block{width:100%}
.pd-action--primary{background:var(--pd-brand-strong);color:var(--pd-on-brand)}
.pd-action--primary:hover{background:var(--pd-brand-hover)}
.pd-action--secondary{background:var(--pd-surface);border-color:var(--pd-border);color:var(--pd-text)}
.pd-action--quiet{background:var(--pd-brand-soft);color:var(--pd-brand-strong)}
.pd-action--danger{background:var(--pd-danger-soft);color:var(--pd-danger)}
.pd-action:focus-visible{outline:0;box-shadow:var(--pd-focus-ring)}
.pd-action:disabled{opacity:.5;cursor:not-allowed}
@media(prefers-reduced-motion:reduce){.pd-action{transition:none}}
</style>