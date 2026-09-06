# CSS 迁移台账(组件吸收重构)

生成: scripts/css-inventory.mjs · 全局文件总行数: **4476**(style-1..4 + theme-dark)

| 状态 | 家族数 | 行数 | 占比 |
|---|---|---|---|
| 可迁移(有主归属) | 322 | 2995 | 67% |
| 共享(升入 base) | 105 | 2167 | 48% |
| 死代码(直接删) | 99 | 441 | 10% |

## 可迁移家族(按行数降序,先叶子后容器由人工在批次中把握)

| 家族 | 行数 | 主归属组件 | 涉及全局文件 | dark 规则 | var 依赖数 | 主要 var |
|---|---|---|---|---|---|---|
| tomato-timer | 181 | components\TomatoBar.vue | style-4.css,theme-dark.css | 有 | 8 | --tomato-bg --brand-dark --fs-sm --space-1 --fs-lg --radius-sm --brand-text --text-3 |
| side-nav | 109 | components\SideNav.vue | style-3.css,theme-dark.css | 有 | 8 | --radius-md --hover-bg --space-2 --space-1 --panel --text-1 --line --brand-light |
| cal-fc | 103 | views\CalendarView.vue | style-2.css,theme-dark.css | 有 | 16 | --fc-page-bg-color --brand-dark --fs-md --panel --fs-sm --brand --radius-sm --fs-xs |
| form-item | 96 | components\SettingsModal.vue | style-4.css,theme-dark.css | 有 | 11 | --space-4 --text-1 --fs-md --fs-base --line-strong --radius-sm --brand --brand-focus-ring |
| tf-menu | 80 | views\TomatoFloatPage.vue | style-4.css | - | 10 | --z-float-noise --radius-lg --brand-dark --radius-sm --text-1 --brand-light --brand --text-3 |
| proj-ms | 69 | views\ProjectView.vue | style-3.css,theme-dark.css | 有 | 18 | --space-3 --brand --line-strong --fs-xs --text-4 --t-fast --ok --brand-dark |
| review-card | 58 | views\StatisticsView.vue | style-2.css,theme-dark.css | 有 | 12 | --panel --line --radius-xl --brand --fs-base --text-1 --fs-xs --brand-light |
| proj-ms-row | 56 | views\ProjectView.vue | style-3.css | - | 20 | --space-3 --line --radius-md --panel --fs-sm --t-fast --brand --space-2 |
| ep-inner | 55 | components\EditPanel.vue | style-3.css,theme-dark.css | 有 | 6 | --space-4 --space-5 --brand --radius-sm --panel --text-1 |
| tfr-timeline | 51 | components\TomatoFocusRecordModal.vue | style-4.css,theme-dark.css | 有 | 10 | --line --fs-sm --text-2 --brand --radius-md --radius-xs --fs-2xs --text-3 |
| corner-btn | 46 | views\TomatoFloatPage.vue | style-4.css | - | 3 | --brand-light --text-4 --brand |
| todo-list-item-group | 44 | components\TodoGroupBlock.vue | style-1.css | - | 9 | --panel --line --hover-bg --active-bg --text-4 --text-3 --fs-base --fs-sm |
| setting_tabs | 43 | components\SettingsModal.vue | style-4.css | - | 2 | --brand-dark --radius-xs |
| cat-mgr-row | 38 | components\SideNav.vue | style-3.css,theme-dark.css | 有 | 8 | --fs-md --text-1 --line --panel --gray-bg --dur-fast --brand --radius-xs |
| fc | 36 | utils\holidays.js | style-2.css,theme-dark.css | 有 | 6 | --fs-md --brand --fs-2xs --brand-dark --fs-base --z-fc-popover |
| sn-weather | 34 | components\WeatherWidget.vue | style-3.css | - | 5 | --space-2 --fs-sm --text-2 --radius-md --gray-bg |
| proj-card | 31 | views\ProjectOverviewView.vue | style-3.css,theme-dark.css | 有 | 15 | --line --radius-md --hover-bg --t-base --space-2 --fs-base --text-1 --fs-md |
| cal-more-pop | 28 | views\CalendarView.vue | style-2.css,style-3.css | - | 12 | --z-pop-top --panel --radius-lg --shadow-pop --gray-bg --space-2 --fs-sm --text-2 |
| sn-brand | 28 | components\SideNav.vue | style-3.css | - | 9 | --radius-md --dur-fast --hover-bg --brand --text-3 --fs-md --fs-lg --text-1 |
| ep-title | 27 | components\EditPanel.vue | style-3.css,theme-dark.css | 有 | 2 | --fs-lg --text-1 |
| dropdown-select | 26 | views\TodoBoxView.vue | style-1.css,theme-dark.css | 有 | 8 | --radius-pill --fs-md --text-2 --gray-bg --text-1 --line --text-3 --hover-bg |
| qa-inputwrap | 25 | components\QuickAdd.vue | style-1.css,style-3.css,theme-dark.css | 有 | 9 | --gray-bg --line --radius-lg --brand --panel --radius-sm --dur-mid --text-1 |
| edit-panel | 25 | layout.vue | style-3.css,theme-dark.css | 有 | 5 | --panel-w --panel --line --z-panel --text-1 |
| ach-fam | 24 | views\StatisticsView.vue | style-2.css | - | 12 | --space-3 --line --radius-md --brand --ok --space-2 --fs-sm --text-1 |
| hm-tip | 23 | views\StatisticsView.vue | style-2.css | - | 6 | --z-pop --text-1 --panel --fs-xs --radius-md --shadow-pop |
| ep-desc | 23 | components\EditPanel.vue | style-3.css,theme-dark.css | 有 | 3 | --fs-md --text-2 --text-1 |
| todo-input-add | 23 | components\QuickAdd.vue | style-3.css | - | 2 | --brand-dark --fs-sm |
| sn-search | 21 | components\SideNav.vue | style-3.css,theme-dark.css | 有 | 11 | --space-2 --gray-bg --line --radius-pill --dur-slow --dur-mid --dur-fast --fs-sm |
| chart-h | 18 | views\statistics\ChartCard.vue | style-2.css,theme-dark.css | 有 | 6 | --panel --radius-md --text-1 --fs-base --brand --dur-fast |
| widget-transparent | 18 | views\QuickAddPage.vue | style-4.css | - | 0 | - |
| qa-input | 17 | utils\onboardingTours.js | style-1.css,style-3.css,theme-dark.css | 有 | 6 | --fs-md --text-1 --radius-lg --fs-sm --radius-sm --text-4 |
| el-dialog | 17 | components\SideNav.vue | theme-dark.css | 有 | 4 | --panel --line --text-1 --text-2 |
| sn-ico-btn | 16 | components\SideNav.vue | style-3.css,theme-dark.css | 有 | 5 | --dur-fast --radius-sm --text-3 --brand --hover-bg |
| ep-tom-account | 16 | utils\noisePlayer.js | style-3.css | - | 6 | --line --radius-pill --gray-bg --dur-fast --brand --brand-light |
| ep-tom-seg | 16 | components\EditPanel.vue | style-3.css | - | 9 | --space-1 --line --fs-sm --text-3 --dur-fast --brand-light --text-1 --brand |
| day-strip | 16 | components\DayDateStrip.vue | style-3.css,theme-dark.css | 有 | 6 | --space-1 --panel --line --radius-lg --space-3 --text-1 |
| todo-options | 16 | components\QuickAdd.vue | style-3.css | - | 7 | --space-2 --gray-bg --text-2 --fs-sm --dur-fast --hover-bg --brand |
| today-v1 | 16 | components\DayRail.vue | style-3.css | - | 0 | - |
| day-expand-btn | 15 | views\CalendarView.vue | style-2.css,theme-dark.css | 有 | 4 | --radius-sm --text-3 --gray-bg --brand-text |
| cal-title-btn | 15 | views\CalendarView.vue | style-2.css | - | 5 | --space-1 --radius-md --dur-fast --gray-bg --brand |
| ep-row | 15 | components\EditPanel.vue | style-3.css,theme-dark.css | 有 | 7 | --fs-md --text-2 --brand --radius-md --dur-fast --hover-bg --gray-bg |
| sc-capture | 15 | components\SettingsModal.vue | style-4.css | - | 7 | --line --radius-sm --gray-bg --text-1 --fs-sm --brand --brand-light |
| stat-hero | 14 | views\StatisticsView.vue | style-2.css | - | 5 | --brand-light --brand --fs-lg --text-1 --space-3 |
| sn-scrollable | 14 | components\SideNav.vue | style-3.css | - | 1 | --radius-sm |
| sn-account-gear | 14 | components\SideNav.vue | style-3.css,theme-dark.css | 有 | 4 | --radius-md --text-3 --dur-mid --text-1 |
| td-meta | 14 | components\TodoItem.vue | style-3.css,theme-dark.css | 有 | 3 | --dur-fast --dur-mid --text-3 |
| ep-tag-chip | 14 | components\EditPanel.vue | style-3.css | - | 6 | --space-1 --gray-bg --radius-lg --fs-sm --text-2 --dur-fast |
| ep-sub-x | 14 | components\EditPanel.vue | style-3.css,theme-dark.css | 有 | 3 | --text-3 --danger --dur-mid |
| tab-panel | 14 | components\SettingsModal.vue | style-4.css,theme-dark.css | 有 | 8 | --space-5 --space-4 --panel --line-strong --radius-lg --space-3 --brand --fs-base |
| ob-btn | 14 | components\Onboarding.vue | style-4.css | - | 7 | --line-strong --radius-md --text-1 --fs-md --t-fast --brand --brand-hover |
| tl-row | 13 | views\StatisticsView.vue | style-2.css | - | 2 | --text-4 --text-3 |
| kpi-tile | 13 | views\StatisticsView.vue | style-2.css,theme-dark.css | 有 | 8 | --panel --line --radius-lg --fs-sm --text-3 --space-1 --text-1 --fs-xs |
| sn-sec-head | 13 | components\SideNav.vue | style-3.css | - | 2 | --fs-md --text-2 |
| cat-mgr-del | 13 | components\SideNav.vue | style-3.css,theme-dark.css | 有 | 9 | --fs-sm --text-3 --radius-sm --dur-fast --danger --danger-soft --brand --brand-dark |
| sn-account-trash | 12 | components\SideNav.vue | style-3.css | - | 2 | --danger-soft --danger-strong |
| grp-toggle-btn | 12 | views\CompletedView.vue | style-3.css | - | 5 | --dur-fast --space-1 --fs-md --text-3 --brand |
| ep-collapse-btn | 12 | components\EditPanel.vue | style-3.css | - | 6 | --space-2 --space-1 --text-3 --radius-md --brand --hover-bg |
| ds-cal-pop | 12 | components\DayDateStrip.vue | style-3.css,theme-dark.css | 有 | 6 | --z-pop --space-1 --panel --radius-lg --shadow-pop --gray-bg |
| cat-mgr-preview | 12 | components\SideNav.vue | style-3.css | - | 6 | --gray-bg --radius-md --fs-sm --text-2 --text-3 --fs-xs |
| ob-opt | 12 | components\Onboarding.vue | style-4.css,theme-dark.css | 有 | 8 | --line-strong --radius-pill --text-1 --fs-md --t-fast --brand --brand-light --brand-text |
| qa-date-chip | 11 | components\QuickAdd.vue | style-1.css,style-3.css | - | 3 | --space-1 --brand --fs-sm |
| day-create-btn | 11 | views\CalendarView.vue | style-2.css | - | 4 | --radius-sm --text-3 --gray-bg --brand-text |
| ep-remind-clear | 11 | components\EditPanel.vue | style-3.css,theme-dark.css | 有 | 4 | --text-4 --fs-md --dur-mid --text-3 |
| w-shape | 11 | components\WeatherWidget.vue | style-3.css | - | 1 | --brand |
| td-tom | 11 | components\TodoItem.vue | style-3.css | - | 4 | --text-3 --space-1 --fs-xs --line |
| dd-pop | 10 | views\TodoBoxView.vue | style-1.css | - | 1 | --radius-lg |
| chart-b | 10 | views\statistics\ChartCard.vue | style-2.css | - | 3 | --radius-md --fs-base --fs-sm |
| tl-min | 10 | views\StatisticsView.vue | style-2.css | - | 5 | --fs-xs --text-3 --text-1 --dur-fast --brand |
| ach-total | 10 | views\StatisticsView.vue | style-2.css,theme-dark.css | 有 | 6 | --radius-md --brand --fs-md --fs-sm --text-3 --space-1 |
| sn-sync | 10 | components\SideNav.vue | style-3.css | - | 0 | - |
| ep-cat-pop | 10 | components\EditPanel.vue | style-3.css,theme-dark.css | 有 | 6 | --z-pop --space-1 --panel --radius-lg --shadow-pop --gray-bg |
| ep-addsub-input | 10 | components\EditPanel.vue | style-3.css,theme-dark.css | 有 | 3 | --fs-md --text-1 --text-4 |
| sn-cat-del | 10 | components\SideNav.vue | style-3.css | - | 4 | --fs-md --text-4 --dur-fast --danger |
| ms-ring | 10 | views\ProjectView.vue | style-3.css | - | 6 | --track-bg --brand --dur-slow --ok --fs-2xs --text-2 |
| tfr-nav-btn | 10 | components\TomatoFocusRecordModal.vue | style-4.css | - | 5 | --line --panel --text-2 --fs-md --brand |
| ob-card | 10 | components\Onboarding.vue | style-4.css,theme-dark.css | 有 | 3 | --panel --text-1 --radius-lg |
| chart-box | 9 | views\statistics\ChartCard.vue | style-2.css,theme-dark.css | 有 | 2 | --panel --text-1 |
| hm-grid | 9 | views\StatisticsView.vue | style-2.css | - | 3 | --space-1 --radius-sm --radius-xs |
| sn-expand-hint | 9 | components\SideNav.vue | style-3.css | - | 6 | --text-2 --gray-bg --radius-pill --dur-fast --brand-light --brand |
| sn-collapse-hint | 9 | components\SideNav.vue | style-3.css | - | 6 | --text-2 --gray-bg --radius-pill --dur-fast --brand-light --brand |
| ctx-menu | 9 | components\ContextMenuHost.vue | style-3.css,theme-dark.css | 有 | 3 | --panel --text-1 --gray-bg |
| qapage | 9 | views\QuickAddPage.vue | style-4.css,theme-dark.css | 有 | 2 | --radius-lg --panel |
| tour-journey-banner | 9 | utils\onboardingTours.js | style-4.css | - | 4 | --z-modal --radius-md --brand --fs-md |
| el-popover | 9 | views\TodoBoxView.vue | theme-dark.css | 有 | 3 | --panel --line --text-1 |
| qa-cal | 8 | components\QuickAdd.vue | style-1.css | - | 0 | - |
| tip-q | 8 | views\CompletedView.vue | style-1.css | - | 2 | --fs-xs --text-4 |
| tb-dot-check | 8 | views\FilterView.vue | style-1.css | - | 2 | --brand-light --brand |
| tl-chip | 8 | views\StatisticsView.vue | style-2.css | - | 2 | --brand --track-bg |
| tl-hour | 8 | views\StatisticsView.vue | style-2.css,theme-dark.css | 有 | 2 | --fs-2xs --text-4 |
| stat-period-pills | 8 | views\StatisticsView.vue | style-2.css | - | 6 | --fs-sm --text-3 --radius-sm --dur-fast --brand --hover-bg |
| best-item | 8 | views\StatisticsView.vue | style-2.css | - | 7 | --gray-bg --radius-md --fs-sm --text-3 --text-1 --space-1 --fs-xs |
| sn-cog-btn | 8 | components\SideNav.vue | style-3.css | - | 4 | --text-2 --radius-md --hover-bg --brand |
| ep-cat-row | 8 | components\EditPanel.vue | style-3.css | - | 3 | --fs-md --text-2 --text-3 |
| ep-tag-x | 8 | components\EditPanel.vue | style-3.css,theme-dark.css | 有 | 3 | --text-3 --fs-xs --danger |
| ep-sub | 8 | components\EditPanel.vue | style-3.css | - | 3 | --space-2 --fs-md --text-2 |
| ep-sub-drag | 8 | components\EditPanel.vue | style-3.css,theme-dark.css | 有 | 2 | --text-3 --dur-mid |
| qa-cal-picker | 8 | components\QuickAdd.vue | style-3.css | - | 0 | - |
| ep-deadline | 8 | components\EditPanel.vue | style-3.css | - | 6 | --fs-sm --radius-pill --text-3 --panel --line --brand |
| proj-new-btn | 8 | views\ProjectOverviewView.vue | style-3.css | - | 5 | --fs-sm --brand --radius-sm --t-fast --brand-dark |
| ob-cat | 8 | components\Onboarding.vue | style-4.css | - | 6 | --radius-pill --gray-bg --fs-sm --text-2 --dot --brand |
| tour-journey-skip | 8 | utils\onboardingTours.js | style-4.css | - | 2 | --radius-pill --fs-sm |
| td-title | 8 | components\TodoItem.vue | theme-dark.css | 有 | 1 | --text-1 |
| tl-track | 7 | views\StatisticsView.vue | style-2.css,theme-dark.css | 有 | 2 | --radius-md --track-bg |
| tl-tip | 7 | views\StatisticsView.vue | style-2.css | - | 6 | --z-modal --text-1 --panel --fs-xs --radius-sm --shadow-pop |
| day-cell-actions | 7 | views\CalendarView.vue | style-2.css | - | 1 | --dur-fast |
| sn-avatar | 7 | components\SideNav.vue | style-3.css | - | 2 | --radius-md --fs-md |
| ep-tag-input | 7 | components\EditPanel.vue | style-3.css | - | 2 | --fs-md --text-1 |
| ep-tom-step | 7 | components\EditPanel.vue | style-3.css | - | 6 | --radius-sm --text-1 --fs-md --dur-fast --panel --brand |
| ep-img-btn | 7 | components\EditPanel.vue | style-3.css | - | 0 | - |
| td-subs | 7 | components\TodoItem.vue | style-3.css | - | 0 | - |
| cat-mgr-name | 7 | components\SideNav.vue | style-3.css | - | 1 | --brand |
| sn-cat-folder | 7 | components\SideNav.vue | style-3.css | - | 3 | --fs-2xs --text-3 --dur-mid |
| view-more-pop | 7 | components\ViewMoreMenu.vue | style-3.css,theme-dark.css | 有 | 6 | --z-viewmenu --panel --radius-md --shadow-pop --gray-bg --line |
| proj-toolbar | 7 | views\ProjectOverviewView.vue | style-3.css | - | 3 | --space-3 --fs-xs --text-3 |
| btn-close | 7 | views\TomatoFloatPage.vue | style-4.css | - | 0 | - |
| tomato-panel | 7 | components\TomatoPanel.vue | theme-dark.css | 有 | 3 | --panel --text-1 --line |
| datetime | 6 | views\RecycleBinView.vue | style-1.css | - | 2 | --brand-dark --text-dim |
| done-row-orig | 6 | views\CompletedView.vue | style-1.css | - | 0 | - |
| dd-caret | 6 | views\TodoBoxView.vue | style-1.css,theme-dark.css | 有 | 1 | --text-3 |
| dd-q | 6 | views\TodoBoxView.vue | style-1.css | - | 2 | --fs-xs --text-4 |
| chart-a | 6 | views\statistics\ChartCard.vue | style-2.css | - | 3 | --radius-md --space-4 --fs-sm |
| chart-d | 6 | views\statistics\ChartCard.vue | style-2.css | - | 3 | --radius-md --space-2 --fs-sm |
| fc-daygrid-day | 6 | views\CalendarView.vue | style-2.css | - | 1 | --fc-border-color |
| tl-card | 6 | views\StatisticsView.vue | style-2.css,theme-dark.css | 有 | 2 | --panel --radius-md |
| tl-head | 6 | views\StatisticsView.vue | style-2.css,theme-dark.css | 有 | 3 | --space-3 --fs-base --text-1 |
| hm-legend | 6 | views\StatisticsView.vue | style-2.css,theme-dark.css | 有 | 4 | --space-1 --space-2 --fs-xs --text-3 |
| chk | 6 | views\CalendarView.vue | style-2.css | - | 3 | --gray-bg --dur-fast --brand |
| sc-list | 6 | views\StatisticsView.vue | style-2.css | - | 1 | --fs-md |
| sc-kpi | 6 | views\StatisticsView.vue | style-2.css | - | 2 | --radius-lg --fs-xs |
| sc-mini | 6 | views\StatisticsView.vue | style-2.css | - | 1 | --fs-sm |
| ep-done-row | 6 | components\EditPanel.vue | style-3.css | - | 3 | --fs-md --text-2 --text-3 |
| ep-tags-row | 6 | components\EditPanel.vue | style-3.css,theme-dark.css | 有 | 2 | --space-1 --gray-bg |
| ep-title-row | 6 | components\EditPanel.vue | style-3.css | - | 0 | - |
| ep-sub-text | 6 | components\EditPanel.vue | style-3.css,theme-dark.css | 有 | 1 | --text-1 |
| ep-sub-move | 6 | components\EditPanel.vue | style-3.css | - | 2 | --text-3 --fs-xs |
| ep-attach-btn | 6 | components\EditPanel.vue | style-3.css | - | 7 | --fs-sm --text-3 --radius-sm --dur-fast --hover-bg --text-1 --brand |
| danger-btn | 6 | components\SettingsModal.vue | style-3.css,style-4.css,theme-dark.css | 有 | 5 | --danger-strong --danger --space-1 --space-3 --danger-soft |
| ds-arrow | 6 | components\DayDateStrip.vue | style-3.css | - | 3 | --text-3 --fs-lg --brand |
| ep-remind-line | 6 | components\EditPanel.vue | style-3.css | - | 1 | --space-1 |
| cat-mgr-count | 6 | components\SideNav.vue | style-3.css | - | 3 | --brand --fs-xs --text-3 |
| ep-remind | 6 | components\EditPanel.vue | style-3.css | - | 1 | --brand-hover |
| sn-cat-child | 6 | components\SideNav.vue | style-3.css | - | 2 | --fs-sm --text-2 |
| ui-titlebar | 6 | components\WinControls.vue | style-3.css | - | 1 | --z-titlebar |
| ds-cal-head | 6 | components\DayDateStrip.vue | style-3.css | - | 5 | --space-2 --text-3 --fs-base --fs-md --text-1 |
| sn-sec-foldable | 6 | components\SideNav.vue | style-3.css | - | 0 | - |
| proj-ring | 6 | views\ProjectOverviewView.vue | style-3.css | - | 4 | --track-bg --t-slow --fs-2xs --text-2 |
| btn-dots | 6 | views\TomatoFloatPage.vue | style-4.css | - | 0 | - |
| btn-min | 6 | views\TomatoFloatPage.vue | style-4.css | - | 0 | - |
| ob-mask | 6 | components\Onboarding.vue | style-4.css | - | 1 | --z-notify |
| is-complete | 6 | components\TodoItem.vue | theme-dark.css | 有 | 2 | --text-1 --text-4 |
| el-switch | 6 | components\SettingsModal.vue | theme-dark.css | 有 | 4 | --line-strong --el-fill-color --el-border-color --el-color-primary |
| cal-month-pop | 5 | views\CalendarView.vue | style-2.css | - | 4 | --z-pop --panel --radius-lg --shadow-pop |
| stat-view-tabs | 5 | views\StatisticsView.vue | style-2.css | - | 3 | --space-1 --gray-bg --radius-pill |
| ep-remind-add | 5 | components\EditPanel.vue | style-3.css | - | 5 | --space-1 --fs-sm --text-2 --brand --brand-light |
| cat-mgr-head | 5 | components\SideNav.vue | style-3.css | - | 2 | --fs-xs --text-3 |
| ep-remind-pop | 5 | components\EditPanel.vue | style-3.css | - | 2 | --space-2 --line |
| ds-cal-dot | 5 | components\DayDateStrip.vue | style-3.css | - | 1 | --brand |
| main-col | 5 | layout.vue | theme-dark.css | 有 | 2 | --panel --text-1 |
| view-head | 5 | layout.vue | theme-dark.css | 有 | 2 | --panel --text-1 |
| icon-append | 4 | views\TodoBoxView.vue | style-1.css | - | 1 | --text-4 |
| tip-icon | 4 | views\CompletedView.vue | style-1.css | - | 1 | --text-4 |
| rc-danger-btn | 4 | views\RecycleBinView.vue | style-1.css | - | 2 | --danger --danger-strong |
| tip-completed-list | 4 | views\CompletedView.vue | style-1.css | - | 2 | --fs-sm --text-2 |
| cal-page | 4 | views\CalendarView.vue | style-2.css | - | 0 | - |
| tl-rows | 4 | views\StatisticsView.vue | style-2.css | - | 0 | - |
| tl-date | 4 | views\StatisticsView.vue | style-2.css,theme-dark.css | 有 | 2 | --fs-xs --text-2 |
| hm-card | 4 | views\StatisticsView.vue | style-2.css,theme-dark.css | 有 | 0 | - |
| hm-scroll | 4 | views\StatisticsView.vue | style-2.css | - | 1 | --space-1 |
| hm-l0 | 4 | views\StatisticsView.vue | style-2.css,theme-dark.css | 有 | 1 | --gray-bg |
| todo-lunar | 4 | views\CalendarView.vue | style-2.css | - | 2 | --fs-2xs --text-3 |
| todo-done-strike | 4 | views\CalendarView.vue | style-2.css | - | 0 | - |
| cal-today-btn | 4 | views\CalendarView.vue | style-2.css | - | 2 | --line --brand |
| cal-toolbar | 4 | views\CalendarView.vue | style-2.css | - | 0 | - |
| share-save | 4 | views\StatisticsView.vue | style-2.css | - | 2 | --brand --brand-dark |
| stat-custom-range | 4 | views\StatisticsView.vue | style-2.css | - | 0 | - |
| sn-section | 4 | components\SideNav.vue | style-3.css | - | 1 | --space-1 |
| sn-sec-tools | 4 | components\SideNav.vue | style-3.css | - | 1 | --space-2 |
| sn-cat-edit | 4 | components\SideNav.vue | style-3.css | - | 2 | --brand --fs-md |
| app-shell | 4 | layout.vue | style-3.css,theme-dark.css | 有 | 1 | --bg |
| ep-cats | 4 | components\EditPanel.vue | style-3.css | - | 1 | --space-2 |
| ep-field-label | 4 | components\EditPanel.vue | style-3.css | - | 2 | --fs-sm --text-3 |
| ep-date-chips | 4 | components\EditPanel.vue | style-3.css | - | 0 | - |
| ep-remind-line-x | 4 | components\EditPanel.vue | style-3.css | - | 2 | --text-3 --danger |
| ep-remind-label | 4 | components\EditPanel.vue | style-3.css | - | 3 | --text-3 --dur-mid --brand-dark |
| vm-sep | 4 | components\ViewMoreMenu.vue | style-3.css,theme-dark.css | 有 | 1 | --line |
| tagall-chip | 4 | views\TagAllView.vue | style-3.css | - | 3 | --fs-md --space-1 --brand |
| proj-trend-bar | 4 | views\ProjectView.vue | style-3.css | - | 1 | --brand |
| tfr-add-info | 4 | components\TomatoFocusRecordModal.vue | style-4.css | - | 3 | --text-3 --fs-sm --brand |
| settings-modal-body | 4 | components\SettingsModal.vue | style-4.css,theme-dark.css | 有 | 1 | --text-1 |
| ob-step | 4 | components\Onboarding.vue | style-4.css | - | 5 | --space-1 --fs-lg --space-4 --fs-sm --text-3 |
| ob-foot | 4 | components\Onboarding.vue | style-4.css | - | 1 | --space-2 |
| ob-link | 4 | components\Onboarding.vue | style-4.css | - | 3 | --text-3 --fs-sm --text-2 |
| sn-username | 4 | components\SideNav.vue | theme-dark.css | 有 | 1 | --text-1 |
| empty-state | 4 | components\TodoGroups.vue | theme-dark.css | 有 | 1 | --text-3 |
| fc-more-popover | 4 | views\CalendarView.vue | theme-dark.css | 有 | 2 | --gray-bg --line |
| sn-upd-dot | 3 | components\SideNav.vue | style-3.css | - | 2 | --danger-strong --panel |
| ep-save-failed | 3 | components\EditPanel.vue | style-3.css | - | 3 | --fs-sm --danger --radius-md |
| ep-remind-line-tag | 3 | components\EditPanel.vue | style-3.css | - | 2 | --fs-2xs --brand |
| qa-wrap | 2 | layout.vue | style-1.css | - | 0 | - |
| qa-bar | 2 | components\QuickAdd.vue | style-1.css | - | 0 | - |
| rc-count | 2 | views\RecycleBinView.vue | style-1.css | - | 2 | --fs-sm --text-dim |
| fc-daygrid-day-events | 2 | views\CalendarView.vue | style-2.css | - | 0 | - |
| result-count | 2 | views\SearchView.vue | style-2.css | - | 1 | --fs-sm |
| tl-sub | 2 | views\StatisticsView.vue | style-2.css | - | 2 | --fs-xs --text-3 |
| tl-chips | 2 | views\StatisticsView.vue | style-2.css | - | 3 | --space-1 --fs-xs --text-3 |
| tl-hours | 2 | views\StatisticsView.vue | style-2.css | - | 0 | - |
| hm-cell | 2 | views\StatisticsView.vue | style-2.css | - | 0 | - |
| hm-l1 | 2 | views\StatisticsView.vue | style-2.css | - | 2 | --brand --gray-bg |
| hm-l2 | 2 | views\StatisticsView.vue | style-2.css | - | 2 | --brand --gray-bg |
| hm-l3 | 2 | views\StatisticsView.vue | style-2.css | - | 2 | --brand --gray-bg |
| hm-l4 | 2 | views\StatisticsView.vue | style-2.css | - | 1 | --brand |
| todo-week | 2 | views\CalendarView.vue | style-2.css | - | 2 | --fs-2xs --text-3 |
| review-dot | 2 | views\StatisticsView.vue | style-2.css | - | 1 | --brand |
| kpi-row | 2 | views\StatisticsView.vue | style-2.css | - | 0 | - |
| att-rows | 2 | views\StatisticsView.vue | style-2.css | - | 0 | - |
| att-row | 2 | views\StatisticsView.vue | style-2.css | - | 1 | --space-3 |
| att-label | 2 | views\StatisticsView.vue | style-2.css | - | 2 | --fs-sm --text-2 |
| att-track | 2 | views\StatisticsView.vue | style-2.css | - | 2 | --gray-bg --radius-md |
| att-bar | 2 | views\StatisticsView.vue | style-2.css | - | 3 | --radius-md --brand --dur-slow |
| att-value | 2 | views\StatisticsView.vue | style-2.css | - | 2 | --fs-sm --text-3 |
| hm-range-toggle | 2 | views\StatisticsView.vue | style-2.css | - | 1 | --space-1 |
| cal-month-grid | 2 | views\CalendarView.vue | style-2.css | - | 0 | - |
| share-style-tabs | 2 | views\StatisticsView.vue | style-2.css | - | 0 | - |
| share-dialog | 2 | views\StatisticsView.vue | style-2.css | - | 1 | --space-2 |
| sc | 2 | components\SettingsModal.vue | style-2.css | - | 1 | --radius-xl |
| sc-brand | 2 | views\StatisticsView.vue | style-2.css | - | 1 | --fs-sm |
| sc-period | 2 | views\StatisticsView.vue | style-2.css | - | 2 | --fs-sm --space-1 |
| sc-headline | 2 | views\StatisticsView.vue | style-2.css | - | 0 | - |
| sc-foot | 2 | views\StatisticsView.vue | style-2.css | - | 2 | --space-5 --fs-xs |
| sc-narrative | 2 | views\StatisticsView.vue | style-2.css | - | 1 | --brand |
| sc-data | 2 | views\StatisticsView.vue | style-2.css | - | 0 | - |
| sc-kpis | 2 | views\StatisticsView.vue | style-2.css | - | 0 | - |
| stat-custom-warn | 2 | views\StatisticsView.vue | style-2.css | - | 2 | --fs-xs --warn |
| best-row | 2 | views\StatisticsView.vue | style-2.css | - | 0 | - |
| ach-totals | 2 | views\StatisticsView.vue | style-2.css | - | 0 | - |
| ach-fams | 2 | views\StatisticsView.vue | style-2.css | - | 0 | - |
| sn-fixed | 2 | components\SideNav.vue | style-3.css | - | 0 | - |
| sn-navs | 2 | components\SideNav.vue | style-3.css | - | 0 | - |
| sn-nav-ico | 2 | components\SideNav.vue | style-3.css | - | 0 | - |
| sn-sec-toggle | 2 | components\SideNav.vue | style-3.css | - | 1 | --text-1 |
| sn-tags | 2 | components\SideNav.vue | style-3.css | - | 0 | - |
| td-datetime | 2 | components\TodoItem.vue | style-3.css | - | 1 | --dur-fast |
| sn-collapsed-foot | 2 | components\SideNav.vue | style-3.css | - | 0 | - |
| ep-expand | 2 | layout.vue | style-3.css | - | 0 | - |
| ep-field-ico | 2 | components\EditPanel.vue | style-3.css | - | 0 | - |
| ep-cat-wrap | 2 | components\EditPanel.vue | style-3.css | - | 0 | - |
| ep-hash | 2 | components\EditPanel.vue | style-3.css | - | 2 | --fs-md --text-3 |
| ep-ico | 2 | components\EditPanel.vue | style-3.css | - | 0 | - |
| ep-diff-label | 2 | components\EditPanel.vue | style-3.css | - | 1 | --text-2 |
| ep-tom-num | 2 | components\EditPanel.vue | style-3.css | - | 1 | --text-1 |
| ep-tom-ico | 2 | components\EditPanel.vue | style-3.css | - | 0 | - |
| ep-imgs | 2 | components\EditPanel.vue | style-3.css | - | 0 | - |
| ep-attach-bar | 2 | utils\onboardingTours.js | style-3.css | - | 0 | - |
| ep-attach-n | 2 | components\EditPanel.vue | style-3.css | - | 3 | --fs-2xs --brand --brand-light |
| ep-flex | 2 | components\EditPanel.vue | style-3.css | - | 0 | - |
| ep-remind-main | 2 | components\EditPanel.vue | style-3.css | - | 0 | - |
| td-sub | 2 | components\TodoItem.vue | style-3.css | - | 0 | - |
| td-sub-check | 2 | components\TodoItem.vue | style-3.css | - | 0 | - |
| ep-remind-add-plus | 2 | components\EditPanel.vue | style-3.css | - | 0 | - |
| cat-mgr-tip | 2 | components\SideNav.vue | style-3.css | - | 2 | --fs-sm --text-3 |
| cat-mgr-hname | 2 | components\SideNav.vue | style-3.css | - | 0 | - |
| cat-mgr-hcount | 2 | components\SideNav.vue | style-3.css | - | 0 | - |
| cat-mgr-hops | 2 | components\SideNav.vue | style-3.css | - | 0 | - |
| cat-mgr-drag | 2 | components\SideNav.vue | style-3.css | - | 2 | --text-3 --fs-base |
| tg-week | 2 | components\TodoGroups.vue | style-3.css | - | 1 | --fs-base |
| ep-remind-offsets | 2 | components\EditPanel.vue | style-3.css | - | 0 | - |
| ep-remind-offsets-label | 2 | components\EditPanel.vue | style-3.css | - | 2 | --fs-xs --text-3 |
| sn-filter-empty | 2 | components\SideNav.vue | style-3.css | - | 2 | --fs-xs --text-3 |
| filter-cond-text | 2 | views\FilterView.vue | style-3.css | - | 3 | --fs-xs --text-3 --space-2 |
| ui-titletext | 2 | components\WinControls.vue | style-3.css | - | 0 | - |
| ui-title-drag | 2 | components\WinControls.vue | style-3.css | - | 0 | - |
| ui-titlecontrols | 2 | components\WinControls.vue | style-3.css | - | 0 | - |
| ds-num | 2 | components\DayDateStrip.vue | style-3.css | - | 0 | - |
| ds-wd | 2 | components\DayDateStrip.vue | style-3.css | - | 2 | --fs-2xs --text-3 |
| ds-today-dot | 2 | components\DayDateStrip.vue | style-3.css | - | 1 | --brand |
| ds-mseam | 2 | components\DayDateStrip.vue | style-3.css | - | 1 | --line |
| view-more-wrap | 2 | components\ViewMoreMenu.vue | style-3.css | - | 0 | - |
| w-icon | 2 | components\WeatherWidget.vue | style-3.css | - | 0 | - |
| w-temp | 2 | components\WeatherWidget.vue | style-3.css | - | 2 | --fs-lg --text-1 |
| w-desc | 2 | components\WeatherWidget.vue | style-3.css | - | 1 | --text-3 |
| w-city | 2 | components\WeatherWidget.vue | style-3.css | - | 2 | --fs-xs --text-3 |
| ds-cal-grid | 2 | components\DayDateStrip.vue | style-3.css | - | 0 | - |
| ds-cal-h | 2 | components\DayDateStrip.vue | style-3.css | - | 2 | --fs-2xs --text-3 |
| tagall-grid | 2 | views\TagAllView.vue | style-3.css | - | 1 | --space-2 |
| tagall-count | 2 | views\TagAllView.vue | style-3.css | - | 2 | --text-3 --fs-xs |
| tagall-empty | 2 | views\TagAllView.vue | style-3.css | - | 3 | --space-5 --fs-md --text-3 |
| proj-grid | 2 | views\ProjectOverviewView.vue | style-3.css | - | 1 | --space-3 |
| proj-tabs | 2 | views\ProjectView.vue | style-3.css | - | 1 | --line |
| proj-tab-body | 2 | views\ProjectView.vue | style-3.css | - | 0 | - |
| proj-ms-list | 2 | views\ProjectView.vue | style-3.css | - | 2 | --line --space-2 |
| pd-view-page | 2 | components\DayRail.vue | style-3.css | - | 0 | - |
| tfr-form-row | 2 | components\TomatoFocusRecordModal.vue | style-4.css | - | 0 | - |
| tfr-form-label | 2 | components\TomatoFocusRecordModal.vue | style-4.css | - | 2 | --text-2 --fs-md |
| tfr-empty | 2 | components\TomatoFocusRecordModal.vue | style-4.css | - | 2 | --fs-sm --text-3 |
| form | 2 | components\RepeatModal.vue | style-4.css | - | 0 | - |
| ctl-sm | 2 | components\SettingsModal.vue | style-4.css | - | 0 | - |
| ctl-md | 2 | components\SettingsModal.vue | style-4.css | - | 0 | - |
| ctl-lg | 2 | components\SettingsModal.vue | style-4.css | - | 0 | - |
| hr | 2 | views\CalendarView.vue | style-4.css | - | 2 | --line --space-2 |
| mini-lg | 2 | components\SettingsModal.vue | style-4.css | - | 2 | --space-1 --space-4 |
| ob-title | 2 | components\Onboarding.vue | style-4.css | - | 0 | - |
| ob-sub | 2 | components\Onboarding.vue | style-4.css | - | 4 | --space-2 --space-5 --fs-md --text-3 |
| ob-opts | 2 | components\Onboarding.vue | style-4.css | - | 1 | --space-2 |
| ob-cats | 2 | components\Onboarding.vue | style-4.css | - | 2 | --space-2 --space-4 |
| upd-version | 2 | components\SettingsModal.vue | style-4.css | - | 2 | --fs-sm --text-2 |
| upd-hint | 2 | components\SettingsModal.vue | style-4.css | - | 3 | --space-2 --fs-sm --text-3 |
| sc-kbd | 2 | components\SettingsModal.vue | style-4.css | - | 1 | --fs-sm |
| settings-search-empty | 2 | components\SettingsModal.vue | style-4.css | - | 2 | --text-3 --fs-md |
| el-overlay-message-box | 2 | utils\onboardingTours.js | style-4.css | - | 0 | - |
| td-desc | 2 | components\TodoItem.vue | theme-dark.css | 有 | 1 | --text-3 |
| empty-tip | 2 | components\TomatoPanel.vue | theme-dark.css | 有 | 1 | --text-3 |
| tg-body | 2 | components\TodoGroups.vue | theme-dark.css | 有 | 1 | --line |
| tp-records | 2 | components\TomatoPanel.vue | theme-dark.css | 有 | 1 | --line |
| ring-bg | 2 | components\TomatoPanel.vue | theme-dark.css | 有 | 1 | --line |
| img-preview-mask | 2 | components\EditPanel.vue | theme-dark.css | 有 | 0 | - |
| el-month-table | 2 | views\CalendarView.vue | theme-dark.css | 有 | 1 | --text-2 |
| el-year-table | 2 | views\CalendarView.vue | theme-dark.css | 有 | 1 | --text-2 |
| navbar | 2 | views\statistics\chartConfigs.js | theme-dark.css | 有 | 1 | --text-2 |
| search-highlight | 2 | utils\search.js | theme-dark.css | 有 | 1 | --text-1 |
| abandon-card | 2 | components\TomatoAbandonModal.vue | theme-dark.css | 有 | 0 | - |
| abandon-x | 2 | components\TomatoAbandonModal.vue | theme-dark.css | 有 | 0 | - |
| abandon-btn | 2 | components\TomatoAbandonModal.vue | theme-dark.css | 有 | 0 | - |

## 共享家族(升入 base.css,不硬塞组件)

| 家族 | 行数 | 涉及文件 |
|---|---|---|
| tomato | 290 | style-4.css |
| dark | 115 | style-4.css |
| modal | 92 | style-4.css,theme-dark.css |
| todo-list | 81 | style-1.css,theme-dark.css |
| stat-subpage | 81 | style-2.css,theme-dark.css |
| pd-day-deck | 71 | style-3.css |
| main-nav-search | 60 | style-2.css,style-3.css,theme-dark.css |
| proj-head | 57 | style-3.css,theme-dark.css |
| tomato-record | 57 | style-4.css,theme-dark.css |
| todo-box-list | 54 | style-1.css |
| sn-cat-item | 46 | style-3.css,theme-dark.css |
| tf-noise | 46 | style-4.css |
| ep-date-chip | 43 | style-3.css,theme-dark.css |
| tf-abandon | 40 | style-4.css |
| ep-chip | 32 | style-3.css,theme-dark.css |
| page | 30 | style-1.css,style-3.css |
| widget-preview | 30 | style-4.css |
| sn-nav-item | 29 | style-3.css,theme-dark.css |
| td-item | 29 | style-3.css,theme-dark.css |
| ds-day | 27 | style-3.css |
| ui-btn | 27 | style-3.css |
| tomato-bar | 25 | style-4.css,theme-dark.css |
| settings-search | 24 | style-4.css |
| el-select-dropdown | 23 | theme-dark.css |
| title | 20 | style-1.css,style-2.css |
| tg-head | 20 | style-3.css,theme-dark.css |
| mini | 18 | style-3.css,style-4.css,theme-dark.css |
| sn-account | 17 | style-3.css,theme-dark.css |
| ep-diff-btns | 17 | style-3.css,theme-dark.css |
| td-right | 17 | style-3.css |
| row-btn | 16 | style-1.css,style-3.css |
| ds-label | 16 | style-3.css |
| floating | 16 | style-4.css |
| modal-tablecloth | 15 | style-4.css |
| main-scroll | 14 | style-1.css,style-3.css |
| dd-menu | 14 | style-1.css,theme-dark.css |
| tl-seg | 14 | style-2.css,theme-dark.css |
| cal-seg | 14 | style-2.css |
| ep-mini | 14 | style-3.css,theme-dark.css |
| modal-container | 14 | style-4.css |
| el-select | 14 | theme-dark.css |
| cal-month-cell | 13 | style-2.css |
| stat-view-tab | 13 | style-2.css,theme-dark.css |
| ep-recycle-banner | 13 | style-3.css,theme-dark.css |
| ep-cat-opt | 13 | style-3.css,theme-dark.css |
| ds-today-ico | 13 | style-3.css |
| ds-cal-cell | 13 | style-3.css |
| cal-cell | 13 | theme-dark.css |
| empty | 12 | style-1.css,style-2.css,theme-dark.css |
| todo-box-list-item | 12 | style-1.css,theme-dark.css |
| stat-page | 12 | style-2.css,theme-dark.css |
| sn-badge | 12 | style-3.css,theme-dark.css |
| ep-img-cell | 12 | style-3.css |
| ep-tool | 12 | style-3.css |
| vm-item | 12 | style-3.css,theme-dark.css |
| ds-cal-btn | 12 | style-3.css |
| stat-export-bar | 11 | style-2.css |
| sn-cat-action | 11 | style-3.css |
| view-more-btn | 11 | style-3.css |
| el-date-picker | 11 | theme-dark.css |
| checkbox | 10 | style-1.css,theme-dark.css |
| el-button | 10 | style-1.css,style-3.css |
| search-page | 10 | style-2.css |
| stat-period-pill | 10 | style-2.css |
| ep-offset-chip | 10 | style-3.css |
| ep-tools | 9 | style-3.css,theme-dark.css |
| toolbar | 9 | theme-dark.css |
| kpi-delta | 8 | style-2.css |
| cal-nav-group | 8 | style-2.css |
| sn-fold-arrow | 8 | style-3.css |
| proj-tab | 8 | style-3.css |
| proj-ms-tasks | 8 | style-3.css |
| el-date-table | 8 | theme-dark.css |
| tl-grid-toggle | 7 | style-2.css |
| hm-range-btn | 7 | style-2.css |
| ep-sub-check | 7 | style-3.css |
| todo-list-item-group-container | 6 | style-1.css |
| ep-file | 6 | style-3.css |
| ep-prio-btns | 6 | style-3.css |
| td-check | 6 | style-3.css,theme-dark.css |
| td-tom-pips | 6 | style-3.css |
| pd-view-seg | 6 | style-3.css |
| content | 6 | theme-dark.css |
| ctx-item | 6 | theme-dark.css |
| primary | 6 | theme-dark.css |
| quick-add | 5 | theme-dark.css |
| view-page | 5 | theme-dark.css |
| todo-list-item-group-list | 4 | style-1.css |
| single | 4 | style-2.css |
| double | 4 | style-2.css |
| full | 4 | style-2.css |
| tl-band | 4 | style-2.css |
| cal-tb | 4 | style-2.css |
| sn-dot | 4 | style-3.css |
| ep-saving | 4 | style-3.css |
| ep-row-arrow | 4 | style-3.css |
| tip | 4 | style-4.css,theme-dark.css |
| icon-prepend | 2 | style-1.css |
| box-page | 2 | style-1.css |
| completed-page | 2 | style-1.css |
| recycle-page | 2 | style-1.css |
| search-filter-el | 2 | style-2.css |
| btn-tomato | 2 | style-3.css |
| desc | 2 | theme-dark.css |
| qa-btn | 2 | theme-dark.css |

## 死代码候选(全 .vue 零引用;删除前人工复核动态拼接类名)

| 家族 | 行数 | 涉及文件 |
|---|---|---|
| el-input | 22 | style-4.css,theme-dark.css |
| el-message-box | 19 | style-4.css,theme-dark.css |
| el-cascader-node | 16 | theme-dark.css |
| qa-pop | 11 | style-1.css,theme-dark.css |
| search-bar | 11 | theme-dark.css |
| chart-3 | 10 | style-2.css |
| chart-4 | 10 | style-2.css |
| el-radio-button | 10 | theme-dark.css |
| sum-card | 9 | theme-dark.css |
| el-picker-panel | 9 | theme-dark.css |
| ach-badge | 8 | style-2.css |
| el-cascader-menu | 8 | theme-dark.css |
| qa-chip-x | 7 | style-3.css |
| btn-play | 7 | style-4.css |
| btn-stop | 7 | style-4.css |
| btn-stop2 | 7 | style-4.css |
| content-area | 7 | theme-dark.css |
| recycle-row | 7 | theme-dark.css |
| ed-head | 7 | theme-dark.css |
| ed-foot | 7 | theme-dark.css |
| review-advice-chip | 6 | style-2.css |
| sn-cat-add | 6 | style-3.css |
| ep-done-chk | 6 | style-3.css |
| ep-diff | 6 | style-3.css |
| btn-pause | 6 | style-4.css |
| btn-resume | 6 | style-4.css |
| btn-dock | 6 | style-4.css |
| el-textarea | 6 | theme-dark.css |
| el-tabs | 6 | theme-dark.css |
| el-notification | 6 | theme-dark.css |
| el-cascader | 6 | theme-dark.css |
| el-cascader-panel | 6 | theme-dark.css |
| qa-more | 5 | theme-dark.css |
| search-filter | 5 | theme-dark.css |
| fc-col-header-cell | 4 | style-2.css |
| cal-week-row | 4 | style-2.css |
| fc-daygrid-day-top | 4 | style-2.css |
| fc-h-event | 4 | style-2.css |
| fc-daygrid-day-bottom | 4 | style-2.css |
| chart-5 | 4 | style-2.css |
| chart-6 | 4 | style-2.css |
| sn-manage | 4 | style-3.css |
| u-name | 4 | theme-dark.css |
| nav-item | 4 | theme-dark.css |
| file-row | 4 | theme-dark.css |
| cat-head | 4 | theme-dark.css |
| tag-head | 4 | theme-dark.css |
| ed-body | 4 | theme-dark.css |
| el-popper | 4 | theme-dark.css |
| qa-dots | 2 | style-1.css |
| qa-row | 2 | style-1.css |
| cal-topbar | 2 | style-2.css |
| cal-scrollgrid | 2 | style-2.css |
| fc-col-header-cell-cushion | 2 | style-2.css |
| fc-daygrid-body | 2 | style-2.css |
| fc-day-today | 2 | style-2.css |
| fc-highlight | 2 | style-2.css |
| fc-daygrid-day-frame | 2 | style-2.css |
| fc-daygrid-event-harness | 2 | style-2.css |
| fc-scroller | 2 | style-2.css |
| fc-event-title-container | 2 | style-2.css |
| fc-event | 2 | style-2.css |
| fc-daygrid-event | 2 | style-2.css |
| fc-event-main | 2 | style-2.css |
| fc-event-title | 2 | style-2.css |
| fc-day-outside | 2 | style-2.css |
| todo-privacy | 2 | style-2.css |
| sn-fold | 2 | style-3.css |
| sn-all-tag | 2 | style-3.css |
| ep-repeat | 2 | style-3.css |
| sn-user-row | 2 | style-3.css |
| todo-list-item-group-head | 2 | style-3.css |
| sn-sec-fold | 2 | style-3.css |
| pop-enter-active | 2 | style-3.css |
| pop-leave-active | 2 | style-3.css |
| pop-enter-from | 2 | style-3.css |
| pop-leave-to | 2 | style-3.css |
| pd-view-toolbar | 2 | style-3.css |
| tt-pop-actions | 2 | style-4.css |
| tf-pop-enter-active | 2 | style-4.css |
| tf-pop-leave-active | 2 | style-4.css |
| tf-pop-enter-from | 2 | style-4.css |
| tf-pop-leave-to | 2 | style-4.css |
| hint-inline | 2 | theme-dark.css |
| u-sub | 2 | theme-dark.css |
| sub-sec | 2 | theme-dark.css |
| att-sec | 2 | theme-dark.css |
| ai-sec | 2 | theme-dark.css |
| tagchip | 2 | theme-dark.css |
| cal-chip | 2 | theme-dark.css |
| repeat-line | 2 | theme-dark.css |
| img-cell | 2 | theme-dark.css |
| add-cell | 2 | theme-dark.css |
| el-checkbox | 2 | theme-dark.css |
| rc-main | 2 | theme-dark.css |
| el-message | 2 | theme-dark.css |
| fc-daygrid-day-number | 2 | theme-dark.css |
| fc-popover-header | 2 | theme-dark.css |
| el-overlay | 2 | theme-dark.css |

