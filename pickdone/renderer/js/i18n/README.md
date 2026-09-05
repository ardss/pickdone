# i18n 渐进式引入（vue-i18n@9）

## 架构
- `assets/vendor-lib/vue-i18n.global.prod.js`（UMD，全局 `window.VueI18n`）
- `renderer/js/i18n/index.js`：createI18n（legacy:true 模板 $t / fallback zh-CN）
- 语言包：`renderer/js/i18n/zh-CN.json`（基线，逐字对齐现有 UI 文案）、`en-US.json`
- 持久化：localStorage `appLocale`；切换：`setLocale(locale)`（i18n/index.js）

## 组件迁移配方（渐进式，每个组件独立可做）
1. 模板/常量里的中文 → 换成 `$t('模块.元素')`；常量数组用 labelKey，渲染时 `$t(labelKey)`
2. zh-CN.json 补同名 key，值必须与现有中文逐字一致（像素级不变）
3. en-US.json 给英文翻译
4. 验证：语言切 English 看该组件、切回中文确认逐字不变

## 后续待办
- Element Plus 内置文案（"请选择"等）：main.js app.use(ElementPlus, { locale: zhCn/en }) 跟随 appLocale
- dayjs locale 跟随切换；document.title 跟随
- 语言切换器已位于：设置 → 通用 → 界面语言
