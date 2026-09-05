# PickDone 渲染层工程形态(SFC + Vite + TS)

> 2026-09-05 完成「字符串模板 + 预编译 render」到「标准 Vue3 SFC 工程」的迁移。
> 本文档是渲染层工程化的单一入口;行为规范/审查 SOP 见 `../docs/开发规范.md` 与 `../sop/`。

## 形态

- **Vue 3.5 + Element Plus,vendor 全局形态**:Vue/Vuex/Router/i18n/EP 仍是 `assets/vendor-lib/` 的经典脚本,挂 `window.*`;runtime-only 构建(无编译器),CSP 无 `unsafe-eval`。
- **Vite 构建**:`vite.config.mjs`(root=`renderer/`,base=`/renderer-dist/`)→ 产物 `renderer-dist/`(gitignore)。`app://app/<path>` 协议直接映射仓库根,因此产物绝对引用天然命中;主进程所有窗口 load `app://app/renderer-dist/index.html`。
- **`vue` 别名 → `renderer/js/vue-shim.js`**:plugin-vue 编译产物的 `import {..} from 'vue'` 落到 window.Vue 的命名桥,避免 npm full ESM 造成双 Vue 实例。browser-dev(5175 调试宿主)与主工程配置保持同构。
- **SFC**:模板唯一载体是 `.vue` 的 `<template>`;`<script lang="ts">` 选项式 API。`router.js` 是路由实例(非组件)特例。
- **TS**:`vue-tsc --noEmit` 是硬门禁;契约类型在 `renderer/js/contracts.d.ts`(`DbCallOp` 联合与主进程 `ALLOWED_RENDERER_OPS` 同源,新增 op 必须同步)、全局属性在 `vue-custom-props.d.ts`(**不放索引签名逃生口**)。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm start` / `npm run dev` | vite build(renderer-dist 新鲜时自动跳过,`--no-build` 强制跳过)→ 启动 Electron(隔离数据目录) |
| `npm run start:real` | 先构建再连真实用户库 |
| `npm run lint` | ESLint(.js+.vue,vue3-essential+@typescript-eslint/parser) |
| `npm run typecheck` | vue-tsc 全量类型检查(0 错误为绿) |
| `npm run build:renderer` | 仅构建渲染层 |
| `npm run check:all` | 25 项体检(含 build、typecheck、单测、UI 冒烟、e2e) |
| `npm run bump` | 同步 bump 两个宿主 index.html 的 `?v=`(改 vendor/css 后) |

## 铁律(迁移事故沉淀)

1. **不得回引 `template:` 字符串组件**——运行时 Vue 无编译器,SFC 是唯一模板载体(`tests/unit-render-gates.test.mjs` 会拦)。
2. **模板/脚本不得重新引入 `unsafe-eval`**;新依赖若需运行时编译直接否决。
3. **`contracts.d.ts` 的 `TodoAPI` 不加索引签名**;新 IPC 通道显式声明,op 联合与主进程白名单双向同步。
4. `renderer-dist/` 不进 git(构建产物),但**必须**进 electron-builder `files` 白名单;`renderer/**` 源码不随包分发。
5. 模板里引用模块级常量(`dayjs`/`FMT`)依赖 SFC render 闭包,类型层已在 `vue-custom-props.d.ts` 显式声明——新全局常量照此办理,勿用 `as any`。
