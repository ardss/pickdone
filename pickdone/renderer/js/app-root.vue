<template>
<el-config-provider :locale="epLocale">
<router-view/>
</el-config-provider>
</template>

<script lang="ts">
/** App root shell — hosts only the router outlet (the three-pane layout lives in layout.js).
 *  el-config-provider keeps Element Plus internal copy reactive across in-app language switches
 *  (the app.use(ElementPlus, { locale }) in main.js only pins the first-boot value) */
const EP_LOCALES = {
  'zh-CN': window.ElementPlusLocaleZhCn,
  'en-US': window.ElementPlusLocaleEn
}
export default {
  name: 'AppShell',

  computed: {
    epLocale () {
      const loc = (this.$i18n && this.$i18n.locale) || 'zh-CN'
      return EP_LOCALES[loc] || EP_LOCALES['zh-CN']
    }
  },

  mounted () {
    // [H3 2026-10-25] ONE active warning per session when the auto backup write fails:
    // the honest-status line in Settings→Data is passive, so a user who never opens
    // Settings never learns backups stopped (rootcause audit "silent backup stall").
    // A persistent failure fires this once, not on every failed timer tick (no storm);
    // the full history stays in Settings→Data's status line + runtimeState.
    let backupDegradedShown = false
    window.addEventListener('pd:backup-degraded', (e) => {
      if (backupDegradedShown) return
      backupDegradedShown = true
      const err = (e && e.detail && e.detail.error) || ''
      try {
        this.$message.warning(this.$i18n.global.t('backupDegradedToast', { err }))
      } catch { /* toast must never throw from an event handler */ }
    })
  }
}
</script>
