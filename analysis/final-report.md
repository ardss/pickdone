# CSS 组件吸收重构 — 最终报告(2026-09-07 终态:零遗留)

## 目标与策略

Tailwind v4 工具层重写曾在语义翻译阶段停滞(语义有损、必须一次完成、中途状态比起点更糟)。
本轮改用「组件吸收」策略:**不换范式、只换归属地** —— 全局沉积文件(style-1..4/theme-dark)中的
组件样式整族搬进各 SFC 的 `<style>` 块,类名/token 原样保留,样式随组件生灭。

- 可逆:每批一次 commit,回滚代价 = 一批
- 可中断:停在任何点都是净改善
- 护栏:`cli/check-css-freeze.mjs` —— 全局沉积文件**只删不增**(进 pre-commit + check:all)

## 行数对比(全局沉积五件,不含 base.css/token 层)

| 文件 | 重构前 | 重构后 | Δ |
|---|---|---|---|
| style-1.css | 327 | 264 | −63 |
| style-2.css | 642 | 423 | −219 |
| style-3.css | 1680 | 472 | −1208 |
| style-4.css | 1346 | 705 | −641 |
| theme-dark.css | 476 | 300 | −176 |
| **合计** | **4471** | **2164** | **−2307(−51.6%)** |

base.css(2867 行,token + 骨架)未动;搬出的 ~2300 行现住各组件 `<style>`,随组件生灭。

## 每批状态

| 批 | 内容 | 验证 | 状态 |
|---|---|---|---|
| 工具 | css-inventory 台账 + css-move 家族搬运器 + css-freeze 门禁 | 全量入库 | ✅ 3fff422 |
| B1 | proj-* → ProjectView/ProjectOverviewView(89 规则) | 桌面视觉 18/18(改前/改后)+冒烟 19/19 | ✅ f47e4b1 |
| B2 | side-nav 家族 → SideNav(149 规则) | 前后对照 18/18;冒烟 flake 复现于 pre-B2 = 既有 | ✅ 58d3f81+a59c0e0 |
| B3 | tomato-timer/bar → TomatoBar(49) | 视觉+冒烟 19/19+番茄条实拍(72px/走字) | ✅ cf4b842 |
| B4 | ep-* → EditPanel(191,级联敏感头部块留 style-3) | web 视觉 14/14+冒烟 | ✅ ce0a5ec |
| B5 | qa-inputwrap/todo-input-add → QuickAdd;todo-list-item-group → TodoGroupBlock | web 14/14(**曾因 mover 截断注释回滚一次,修复后重搬**) | ✅ 70d91d7+538febf |
| B6 | review-card/ach-fam/hm-tip → StatisticsView;chart-h → ChartCard | web 14/14 | ✅ ebb19c6 |
| B7 | form-item/setting_tabs → SettingsModal | web 14/14 | ✅ 0f8f7da |
| B8 | cal-fc/cal-more-pop/cal-toolbar → CalendarView | web 14/14 | ✅ d12192d |
| B9 | tf-menu/corner-btn → TomatoFloatPage;tfr-timeline → TFR Modal;widget-transparent → QuickAddPage | web 14/14 + 全量构建冒烟 19/19 | ✅ 8c8e9bb |
| B10/11 | sn-weather/main-nav-search/sn-ico-btn → SideNav;dropdown-select → TodoBox;todo-options → QuickAdd;today-v1 → DayRail;day-expand/cal-title → Calendar | web 14/14 | ✅ f7b327d |
| B12 | el-cascader-node/sc-capture/tab-panel → SettingsModal;stat-hero → Statistics;ob-* → Onboarding | web 14/14 + 桌面冒烟 19/19 | ✅ ddd381c |

## 终态(2026-09-07 收官轮:style-1..4 全退役,零遗留)

夜间批次后剩余沉积(~2000 行)已由 `scripts/css-finish.mjs` 一轮全量搬迁完毕:

| 文件 | 终态 |
|---|---|
| style-1..4.css | **已删除**(规则 100% 迁出,零删除语义) |
| base.css | 3253 行 = token 层 + 骨架 + 共享家族(升入 base 统一管理) + EP/过渡/FullCalendar 默认段 |
| theme-dark.css | 299 行 = 深色补丁(唯一保留的全局文件) |

「死代码候选 55 族」复核结论:**全部为运行时生成类,一律零删除、迁往权威归属地** ——
`el-*`(Element Plus 运行时)、`pop-*`(Vue transition 名)、`fc-*`/`cal-*`(FullCalendar 生成 DOM)、
`chart-N`(动态拼接)等分别迁入 base.css EP 段 / 过渡段 / CalendarView.vue。

全局 CSS 架构终态 = **base.css(token+骨架+共享) + theme-dark.css(深色补丁) + 组件 `<style>` 块**。
台账脚本(css-inventory)文件表已收敛为 theme-dark 单件;冻结门禁、token 门禁、hover 对比度门禁、
structure var 扫描、CSSOM 基线(重建:base 608 / theme-dark 145 规则)全部同步新架构。
R4/R5 档位纪律原 scope 的 style-2/3 已退役,纪律转组件级(全局层不再拦截)。

## 夜间发现并修复的门禁环境问题(均为污染源,非样式回归)

1. 「昨日剩余」每日弹窗污染所有截图 → 门禁自动 dismiss
2. 首启向导按系统语言回写 appLocale,LS 钉死会输 → 运行时钉 `$i18n.locale`(响应式,无需 reload)
3. 侧栏折叠偏好持久化 → hygiene 强制展开
4. 深夜锁屏/遮挡使 Electron 停止绘制,CaptureScreenshot 挂死 → 新增 `scripts/visual-web.mjs`
   (5175 浏览器宿主 + localStorage shim + agent-browser 截图,同 0.4% pixelmatch 阈值,深浅两套)
5. 真实数据目录任务数漂移 → 隔离 TODO_USER_DATA_DIR 实例
6. css-move 不识别 CSS 注释导致设计稿注释被拦腰截断(B5 回滚根因)→ 扫描器注释/字符串感知

## 债务清零(收官加轮 2026-09-07)

- theme-dark.css 深色补丁 token 化(原方案 A 债务)已完成:重复暗色字面量收编为 token——
  `--brand-bright`(暗底提亮品牌 #35c2ae,9 处)/#22262e→var(--gray-bg)/#1c1f26→var(--panel)/
  #333a44→var(--line-strong)/#2b3038→var(--track-bg)/EP 文字灰→var(--el-text-color-*)。
  同值替换,web 视觉门禁 14/14 PASS(diff ≤0.051%),仅剩 token 定义行持字面量。
- 至此 CSS 重构无任何在册债务。

## 两轮子代理审查与债务清偿(2026-09-07 当日,7 笔 commit)

第一轮(三代理:迁移零丢失/门禁一致性/SFC 运行时):抓到真 P0——`@keyframes sn-slide`、
`mgr-preview-in` 随 style-3 退役丢失(SideNav 引用静默 no-op),按 git 原文逐字恢复;token/hover
门禁扩扫 .vue `<style>`;一次性脚本退役;过时注释清理。

第二轮(四代理:CSS 坏味道/反模式专岗/架构一致性/门禁覆盖),清偿记录:

| 债务 | 处置 | commit |
|---|---|---|
| token 门禁 R3 从未匹配 #333(恒绿护栏) | 修正则+新增对 RULES 本体的负向自检;5 处真命中 #333→var(--text-1) | f2f12c0 |
| cache-stamp 门禁"改 css 必须先提交才绿"死锁 | css+index.html 同处改动=同笔 bump 在途,放行 | f2f12c0 |
| `<style scoped>` 误加风险无门禁 | structure test 新增禁令 | f2f12c0 |
| visual-web 缺环境半路 crash | 预检 5175/agent-browser,exit 2 带指引 | f2f12c0 |
| 统计页视觉门禁随时间漂移 | 根因=shim 番茄记录锚"今天",凌晨跑全在"未来";锚改昨天+门禁每场景重灌;14/14 全 0.000% | f2f12c0 |
| cssom 95% 容差可静默吞 77 条 | base/theme-dark 改磁盘派生**精确比对**(扫描器与浏览器计数验证一致 608/145) | e1ff8c4 |
| 视觉门禁完全游离 check:all 外 | visual-web --spawn 自拉起 5175,入列 check:all 第④组 | e1ff8c4 |
| 四份 .vue 样式提取器实现分叉 | 收敛为 cli/lib/css-sources.cjs 唯一实现 | e1ff8c4 |
| 17 条"迁移自全局沉积文件"横幅注释 | 全删(git 历史即出处);css-move 不再叠横幅;工具死码清除 | d521baf |
| base.css 死规则簇 | 逐类零引用验证后删 113 条(3253→2720);过渡类/el-/fc- 前缀豁免 | 715d400 |
| base.css 陈旧副本(被吸收规则的旧一份) | .tg-head 族/.td-item.selected/.result-count/.row-btn:hover/.modal__close/rc-danger-btn 等删 base 侧,缺失声明并入组件所有者 | 1af29e7 |
| 深色权威分裂(base 漏 2 条+html.dark 旧前缀 50 处) | 漏入规则归 theme-dark;前缀统一 html[data-theme="dark"];组件同址深色补丁为定稿架构(浅深混写选择器列表不可集中) | fe089a0 |
| .edit-panel 三方 !important 对轰 | SideNav 越界两条归位 EditPanel 所有者规则,!important 拆除 | 6d306b3 |
| SFC 品牌绿/z-index 散值 | #0f9d8f→var(--brand,…)/#35c2ae→var(--brand-bright,…) 双模式恒等;z-index 精确匹配 --z-* 栈 | 386f4b3 |

**剩余非债说明**:SFC 中余下 hex 为无 token 对应的一次性设计色(图表盘色/0c8172 色系/渐变),
按架构属于组件内设计常量;组件同址深色补丁为架构定稿而非遗留;视觉门禁 14 场景为基线护拦,
基线按机器本地维护(gitignored)属设计内。

## 验证命令

```
npm run check:css-freeze   # 冻结门禁
npm run css:inventory      # 台账再生成
node scripts/visual-web.mjs --baseline / 无参  # web 视觉门禁(夜视版)
npm run visual:baseline / npm run visual:check # 桌面视觉门禁(白天)
npm run smoke:interact     # 交互冒烟
```
