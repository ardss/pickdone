# CSS 组件吸收重构 — 最终报告(2026-09-07 夜间批次)

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

## 夜间发现并修复的门禁环境问题(均为污染源,非样式回归)

1. 「昨日剩余」每日弹窗污染所有截图 → 门禁自动 dismiss
2. 首启向导按系统语言回写 appLocale,LS 钉死会输 → 运行时钉 `$i18n.locale`(响应式,无需 reload)
3. 侧栏折叠偏好持久化 → hygiene 强制展开
4. 深夜锁屏/遮挡使 Electron 停止绘制,CaptureScreenshot 挂死 → 新增 `scripts/visual-web.mjs`
   (5175 浏览器宿主 + localStorage shim + agent-browser 截图,同 0.4% pixelmatch 阈值,深浅两套)
5. 真实数据目录任务数漂移 → 隔离 TODO_USER_DATA_DIR 实例
6. css-move 不识别 CSS 注释导致设计稿注释被拦腰截断(B5 回滚根因)→ 扫描器注释/字符串感知

## 遗留与下一步(未在本夜范围,已排入台账)

- 死代码候选 55 族(~227 行):inventory 已标零引用,删前需人工复核动态类名拼接
- 共享家族 75 族:终态应升入 base.css 统一管理
- dark 规则本轮"原样随迁"(方案 B),终态统一 token 化(方案 A)单独一轮
- 桌面 CDP 视觉门禁在锁屏态不可用,已由 visual-web 门禁补位;白天可跑桌面门禁双保险
- 剩余沉积(2164 行)按台账继续,冻结门禁保证只减不增

## 验证命令

```
npm run check:css-freeze   # 冻结门禁
npm run css:inventory      # 台账再生成
node scripts/visual-web.mjs --baseline / 无参  # web 视觉门禁(夜视版)
npm run visual:baseline / npm run visual:check # 桌面视觉门禁(白天)
npm run smoke:interact     # 交互冒烟
```
