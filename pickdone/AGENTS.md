# AGENTS — 工程铁律速览

完整规范见 `docs/开发规范.md`；本文件是给人和 AI 的最小铁律集。与规范冲突时以 `docs/开发规范.md` 为准。

## 工程形态（2026-09-05 起）

- 渲染端 = 真实 `.vue` SFC（`<script lang="ts">` options API）+ Vite 构建（`npm run build:renderer` → `renderer-dist/`，gitignored）。
- 主进程 = `src/main/`（CommonJS）；preload = `src/preload/index.js`（TodoAPI 显式枚举，禁止索引签名逃生口，契约在 `renderer/js/contracts.d.ts`）。
- `vue` 导入由 `renderer/js/vue-shim.js` 桥到 vendor `window.Vue`；升级 Vue 版本须重新生成 shim 并跑门禁。

## 三禁止

1. 禁止把 `.vue`/`.ts` 文件当 `.js` 引用（检查/台账/脚本路径必须与实际后缀一致）。
2. 禁止绕过门禁写死路径/颜色/序号：颜色用 token（`--brand` 等），z-index/space/radius 用变量。
3. 禁止在渲染端出现 Node 能力/私有 IPC 逃生口；一切持久化经 `dbCall` 白名单（30 op，与 `ALLOWED_RENDERER_OPS` 三方对齐）。

## 高频坑（历史事故沉淀）

- CSS 改动必 bump 缓存戳 `?v=`（`scripts/bump-cache.mjs`）；CSS 禁控制字符。
- 关闭/取消/移除按钮一律用 `.close-x` 体系，禁自造 ✕。
- el-date/time-picker 只发 `update:model-value`；el-select 只发 `change`。
- 动态目录/产物：`renderer-dist/assets*` 由构建生成，别手工塞文件；强杀加载中的 Electron 会腐化产物目录（K 盘曾出坏名目，绕障见 `scripts/clean-renderer-dist.mjs`）。
- 主窗可销毁重建：taskbar/updater/shortcuts 都必须在重建路径 re-init；任何"启动时挂一次"的全局状态都要问一句"重建后还在吗"。
- 每个可验证里程碑立即分批提交；并行期禁 `git add -u`，提交后 `git show --stat` 核对。
- **语言纪律（2026-09-06 定稿）**：提交信息/代码注释/标识符一律英文（国际接轨）；中文只允许出现在 `i18n` 语言包文案里。测试断言不得依赖 OS locale——活体门禁已统一钉 `localStorage.appLocale='en-US'` 后用英文断言；新增门禁必须沿用此范式。git 作者邮箱用 GitHub noreply（`92158419+ardss@users.noreply.github.com`），个人邮箱有 identity 门禁拦（`cli/check-commit-identity.js`）。

## 体检

- `npm run check:all`（25 项）是唯一合入门槛；a11y 加 `--a11y`；UI 实测用隔离实例（`TODO_USER_DATA_DIR`）。
