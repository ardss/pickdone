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
  }
}
</script>
