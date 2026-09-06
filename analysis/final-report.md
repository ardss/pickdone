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

## 剩余债务(终态后唯一在册)

- theme-dark.css 299 行深色补丁仍为「原样随迁」(方案 B);统一 token 化(方案 A)留作单独一轮
- 桌面 CDP 视觉门禁锁屏态不可用,已由 visual-web 门禁补位;白天可跑桌面门禁双保险

## 验证命令

```
npm run check:css-freeze   # 冻结门禁
npm run css:inventory      # 台账再生成
node scripts/visual-web.mjs --baseline / 无参  # web 视觉门禁(夜视版)
npm run visual:baseline / npm run visual:check # 桌面视觉门禁(白天)
npm run smoke:interact     # 交互冒烟
```
