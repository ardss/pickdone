<script setup>
defineProps({ title: { type: String, default: '' }, description: { type: String, default: '' } })
</script>
<template>
  <div class="pd-empty" role="status"><slot name="icon" /><strong v-if="title">{{ title }}</strong><p v-if="description">{{ description }}</p><slot /><div v-if="$slots.action" class="pd-empty__action"><slot name="action" /></div></div>
</template>
<style scoped>
.pd-empty{display:flex;flex-direction:column;align-items:flex-start;gap:var(--pd-space-2);padding:var(--pd-space-6);border:1px dashed var(--pd-border);border-radius:var(--pd-radius-lg);background:var(--pd-surface);color:var(--pd-muted);font:13px/1.6 var(--pd-font)}
.pd-empty strong{color:var(--pd-text);font-size:14px}.pd-empty p{margin:0}.pd-empty__action{margin-top:var(--pd-space-2)}
</style>