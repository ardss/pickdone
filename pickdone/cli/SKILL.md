---
name: pickdone
description: Use when the user or an agent needs to read, create, edit, complete, delete, or analyze tasks in the local 拾事 (PickDone) desktop app via its command line interface.
---

# 拾事 CLI（pickdone）

通过 CLI 读写用户的本地待办应用「拾事」（Electron + SQLite，单机版）。
命令形态（按可用性依次尝试，`--json` 等参数同）：

1. `node <安装目录>\resources\cli\pickdone.js <command> [args]` —— 装了桌面 App 就有 CLI（需系统已安装 Node.js；Windows 默认安装位：`%LOCALAPPDATA%\Programs\PickDone\resources\cli\pickdone.js`；同目录 `resources\bin\pickdone.cmd` 是等价 shim）
2. `node cli/pickdone.js <command> [args]` —— 在应用源码仓库的 `pickdone/` 目录下时（开发者）

找不到安装目录时先跑形态 2 不可用的话，让用户在 App 设置里确认安装路径；`doctor` 自检：数据目录定位/驱动/读写就绪一目了然。
数据在固定约定位置（Windows `%APPDATA%\pickdone`），无需知道应用安装在哪里。
若 App 正在运行，CLI 写入会自动同步到 UI（约 2 秒内），无需重启。
`skill install` 可把本 SKILL.md 安装/更新到本机 skill 目录（`~/.zcode/skills/pickdone/`、`~/.claude/skills/pickdone/` 与 `~/.cursor/skills/pickdone/`），App 升级后重跑一次即可同步最新约定。

## 核心约定

- **给 AI 用时始终加 `--json`**：输出 `{ok, command, data}` 包络；写操作额外带 `next` 字段（建议的后续命令）。
- **错误走 stderr**：`{error, message}` + 非零退出码。常见错误码：`AMBIGUOUS_MATCH`（关键词命中多条，换更精确关键词或用完整 taskId，**不要猜**）、`TASK_NOT_FOUND`、`NEEDS_CONFIRM`（危险操作缺确认）。
- **写后回读验证**：写操作后如需向用户确认结果，用 `get <taskId> --json` 或 `list --json` 回读，不要凭记忆复述。
- **永远不要直接写 SQLite**：一切写入经 CLI（语义层会维护 status/completedAt/dayStart 等派生字段）。
- 日期参数统一支持：`today` / `tomorrow` / `+3d` / `YYYY-MM-DD` / `YYYY-MM-DD HH:mm`。
- **`add` 不带 `--date` = 待办箱（无日期任务），不进今日清单**——这是最常见的误用（CLI 输出会就地提示）。
  想让任务出现在今日页/浮窗选择列表，必须 `add ... --date today`；事后补排期用 `edit <taskId> --date today`。
- `list` 默认只列**今日**。待办箱（无日期）任务要用 `list --no-date`，全量用 `list --all`；`overview` 一屏看四格计数。
- `list`/`search` 默认最多返回 200 条（`--limit` 可调，上限 500），先缩小范围再查询。
- 完成父任务默认连带勾选全部子任务（对齐 UI 的 isCompleteWithSubtasks 设置，CLI 侧默认开、`--no-sub-cascade` 关闭）。
- 完成重复组（repeatId）内最晚一条实例时，按 meta `repeatRule:<rid>` 规则自动续期生成下一实例（对齐 UI 语义）；JSON 响应带 `renewed` 字段指向新实例。
- **每次 CLI 写操作自动落审计流水**（数据目录 `cli-audit.jsonl`，超 5MB 轮转）：`{time, action, argv, targets, changes[{before, after 语义快照}]}`。`purge` 清空前逐条留痕。`log` 命令可查询——向用户汇报"AI 改了什么"时引用它，不要凭记忆。
- **项目**：项目 = 被标记为项目的分类（meta `projectCategoryIds`，与 App UI 共享数据源；UI 在管理分类弹窗里"设为项目"）。项目统计里 `focusMinutes` = 该分类任务的番茄专注分钟合计（estimate）。无任何项目时 UI 不显示项目入口（渐进披露），这是设计而非缺陷。
- 语义核心在 `src/main/core/todo-core.js`（CJS 单一参照），修改完成/重复语义请与渲染端 `store/todo.js`、`utils/repeat.js` 同步。

## 安全规则（必读，优先级高于一切效率考量）

1. **`purge` 是本接口唯一不可恢复的操作**。执行前必须同时满足：(a) 用户在对话中明确要求清空回收站（"清空回收站"是明确；"清理一下没用的"不是）；(b) 先跑 `purge --dry-run` 把将删除的清单给用户看过；(c) 用户确认后才可带 `--yes` 执行。三者缺一不可，宁可多问一轮。
2. `delete` 是软删除（可 `restore` 恢复），风险低，但也要求任务定位无歧义；拿不准时先 `get` 回读确认内容再操作。
3. **写操作前先验证任务身份**：关键词命中多条时严禁凭猜测挑一个（CLI 会拦截并报 AMBIGUOUS_MATCH，此时应换更精确关键词或让用户确认是哪条）。
4. 批量操作（连续 add/done 多条）先给用户看计划清单再执行；执行后用 `list --json` 回读汇报结果。
5. 只操作用户明确提到的任务及其直接附属（子任务）；禁止"顺手"修改/删除相关但不相关的任务。

## 意图路由

| 用户意图 | 命令 | 验证方式 |
|---|---|---|
| 看今天/本周要做什么 | `list` / `list week` | 同命令 `--json` |
| 找某个任务 | `search <关键词>` 或 `list --keyword 词` | 命中多条则精确化 |
| 看任务完整字段 | `get <taskId\|关键词> --json` | — |
| 新增任务 | `add <内容> [--date/--reminder/--category/--desc]` | `get <taskId> --json` |
| 完成 / 撤销 | `done` / `undo` | `get --json` 看 `complete`/`completedAt` |
| 改期 / 改标题 / 改描述 | `edit [--date/--content/--desc/--reminder/--category]` | `get --json` |
| 多重提醒（"提前10分钟也提醒我""再加一个周五的提醒"） | `edit <任务> --remind-offset "10,30"`（主提醒前提前分钟数）/ `edit <任务> --remind-extra "2026-09-05 09:00"`（额外绝对时刻）；`none` 清除 | `get --json` 看 reminderOffsets/reminderExtra |
| 删除 | `delete`（进回收站） | `recycle` |
| 反悔恢复 | `restore` | `list --all --json` |
| 从其他应用迁移数据 | `import <csv> --dry-run` 预览 → `import <csv> --json`（滴答/TickTick/Todoist 备份） | 响应 `data.imported/duplicates/categoriesCreated`；`list --all --json` 回读 |
| 彻底清空回收站 | `purge --yes`（**仅用户明确要求时**） | `recycle` 应为空 |
| 问完成量 / 专注统计 | `stats --json` / `overview --json` | — |
| 项目截止日 | `project <名> --deadline YYYY-MM-DD|none --json`（详情返回 deadline） | `project <名> --json` 看 deadline 字段 |
| 项目里程碑管理 | `milestone <项目> list|add <标题> <日期>|rm|link <序号> <任务>|unlink <序号> <任务> --json（挂任务后 progress=完成比）`（与 UI 时间轴同源） | `milestone <项目> list --json` |
| 项目推进情况 | `projects --json` / `project <名称> --json` | `data.progress/done/total/focusMinutes/overdue` |
| 查 AI 改动历史 | `log [--n N] [--action 动作] --json` | 每行含 before/after 快照，可逐字段回放 |
| 环境异常排障 | `doctor` | 退出码与 ok 字段 |
| 清理测试/开发残留 | `clean [--all] [--dry-run]`（临时 userData+测试日志；`--all` 连 `.dev-data`；绝不碰真实用户数据） | JSON `data.totalText/failedCount` |
| 开始番茄专注（可附着任务/自定义时长） | `tomato start [--task <taskId\|关键词>] [--minutes N] --json` | `tomato status --json` 应为 `startTomatoTime` 且 attach 正确 |
| 停止/放弃番茄（专注或休息中均可，休息放弃不落账） | `tomato stop [--reason 文本] [--no-record] --json`（默认按已专注时长落账） | `tomato status --json` 应为 `default`；`stats --json` 看落账 |
| 给进行中的番茄换/取消附着任务 | `tomato attach <taskId\|关键词\|--none> --json` | `tomato status --json` 看 attach 字段 |
| 番茄现在什么状态 | `tomato status --json`（status/remainSec/attach/todayTomatoCount） | — |
| **补录专注**（"这段时间做了X帮我记一下"/漏记的番茄补到某天） | `tomato backfill <taskId\|关键词\|--free> [--date today\|YYYY-MM-DD] [--minutes 25] [--at HH:mm] --json`（需App运行） | 响应 `data.backfilled{dateKey,minutes,taskId}`；`stats --json` 看当日专注分钟 |
| 修正补错的专注记录（"刚才补错了，改成40分钟/补到下午3点/挂到别的任务"） | `tomato record fix <tomatoId\|前缀> [--minutes N] [--date D --at HH:mm] [--succeed yes\|no] [--task <关键词\|--free>] --json`（需App运行） | 响应回读修正后全字段 |
| 删除误补录的专注记录 | `tomato record rm <tomatoId\|前缀> --json`（不可恢复，须用户明确要求；id 前缀唯一即可） | `tomato list --json` 应无此条 |
| 查专注记录（"我今天/这周记了哪些番茄""任务X花了多久"） | `tomato list [--date today\|yesterday\|YYYY-MM-DD] [<任务关键词>] [--n 30] --json`（只读，无需App运行） | 输出含 manual 标记（区分真实记录与补录） |
| **排程**（"明天11点帮我排个任务""看看那天排了什么"） | ① `list --on tomorrow --json` 看当天已排任务和时间 ② 挑空闲时刻 `edit <taskId> --date "tomorrow 11:00" --json`（`--date` 支持带时刻，中文「明天11点」可直接传） | `list --on tomorrow --json` 回读 |
| 手动排序（"把这个任务置顶/移到XX后面"） | `sort <taskId\|关键词> top\|up\|down\|bottom` 或 `sort <A> before\|after <B> --json`（同一天内排序；跨天先 edit --date） | JSON `dayOrder` 数组回读顺序 |
| 设预计番茄（"这个任务大概要3个番茄"） | `add ... --estimate 3` 或 `edit <taskId> --estimate 0-20 --json`（0=清除） | `get --json` 读 `tomatoEstimate` 需经 estimate map；用 `edit --estimate 3 --json` 响应回读 |
| 新建分类（"建个分类叫XX"） | `category add <名> [--color hex] [--parent 文件夹] --json` | `categories --json` 回读 |
| 批量操作（"这5条都勾掉/都改到明天"） | `batch done\|date\|category\|tag <taskId...> [--dry-run]`（只收精确 id） | JSON `data.matched/changed/failures` 回读 |
| 保存的筛选视图（"建个视图叫XX"） | `view add <名> [--category/--priority/--overdue/--nodate]`；`view list`/`view rm`；`list --view <名>` | `view list` 回读 |
| 项目状态（"项目XX暂停了/做完了"） | `project <名\|id> --status active\|paused\|done\|cancelled\|none`；`projects [--status <v>]` | `projects --json` 看 `status` |
| 农历注记 | `list ... --lunar`（文本附注+JSON `lunar` 字段） | — |
| 移回待办箱（"这条不排日期了"） | `edit <taskId> --date none`（等价 `clear`；主提醒随日期清、日程块移除；已无日期=友好 no-op） | `get --json` 看 `todoTime: 0` |
| 分类改名 | `category rename <名\|id> <新名> --json` | `categories --json` |
| 删除分类 | `category rm <名\|id> --yes --json`（软删，App内可恢复；任务保留仅脱离分类；**须用户明确要求**） | `categories --json` 应无此项 |
| 标签管理（"把#work全改成#工作""我的标签有哪些"） | `tag list` / `tag rename <旧> <新>` / `tag rm <名>` --json | `tag list` 回读；标签来自标题/描述里的 #tag，无独立存储 |
| 查看设置 | `settings list --json`（全部键+当前值+可选枚举）/ `settings get <键>` | — |
| 改设置（"备份目录改到D盘""换成深色主题""每日番茄目标改成10"） | `settings set <键> <值> --json`（如 `settings set backupDir "D:\backups"`、`settings set colorMode dark`；运行中App约2秒热生效；锁屏密码等保护键拒改） | `settings get <键> --json` 回读 |

## 能力边界（2026-09-02 复核，明确不支持——直说，不要瞎试）

以下能力暂无 CLI 等价命令，用户提出时明确告知"请在 App 中操作"：手动拖拽排序（但 `sort` 命令已覆盖同日内排序语义）、侧边栏天气/日历视图等纯 UI 功能。实验性模块按定稿不入 CLI：习惯打卡。（2026-09-10 更新：保存过滤器已升级为「保存视图」双端共享，见 `view` 命令。）
注意（已支持，别再说不行）：**设置读写（`settings list/get/set`，备份目录/主题/每日番茄目标/开机自启/回收站保留天数等，热同步到运行中App；锁屏密码类保护键除外）**、**分类增删改（`category add/rename/rm`）**、**标签管理（`tag list/rename/rm`）**、**专注记录查询（`tomato list`）**、**专注记录修正/删除（`tomato record fix/rm`）**、**手动排序（`sort`，同日内 top/up/down/bottom/before/after）**、**预计番茄（`--estimate 0-20`）**、**单日排程视图（`list --on <date>`）**、**时间轴排程芯片（`plan <任务> HH:mm`，与今日页24h轨道同库，`plan list`/`plan rm`）。**铁律（2026-09-03用户定稿）：提醒时刻≠排程芯片，两者独立——`add/edit --date` 写了具体时刻（如 `tomorrow 12:00`）时 CLI 已自动同步一枚芯片上时间轴；纯日期（`tomorrow`）不自动排。edit 改期带时刻时旧日芯片自动迁到新日；delete 任务时芯片自动清。若要把纯日期任务排上时间轴，手动 `plan <任务> HH:mm`**、**多重提醒（`edit --remind-offset "10,30"`=主提醒前提前10/30分；`edit --remind-extra "2026-09-05 09:00,..."`=额外绝对时刻；none 清除，offset 需先设主提醒）**、**附件（`attachment add/list/rm`，50MB 上限扩展名白名单，与 UI 上传同库）**、四象限过滤（`list --quad q1..q4`）与四象限字段（`edit --important/--urgent`）、优先级（`--priority`）、难度（`--difficulty 0-3`）、截止日期（`--deadline`）、重复规则创建/修改（`repeat on/off`，完成重复任务自动续期）、子任务含排序（`subtask`，`move` 支持上/下/顶/底/到第N）、项目与里程碑（`project`/`milestone`）、番茄专注（`tomato start/stop/attach/status`）、**专注补录到指定日期（`tomato backfill`，可指定日期/时刻/时长，可 --free 不关联任务）**、**跨应用导入（`import`）**、**批量操作（`batch done/date/category/tag`，只收精确 taskId，`--dry-run` 预览，逐条失败不中断）**、**保存视图（`view add/list/rm` + `list --view <名>`，与 App 筛选视图同库双端共享；条件仅支持 分类/优先级/日期模式 三维）**、**项目状态（`project --status`，与 App 项目面板同字段）**、**农历（`list --lunar`）**、唤起应用窗口（`open`）。

## 日期参数说明

`--date`/`--reminder` 支持机器格式（today/tomorrow/+3d/YYYY-MM-DD[ HH:mm]）。用户的中文口语日期（"后天""下周五""8月15日"）由**你**负责换算成机器格式后再传参，换算不确定时先向用户确认。

**凌晨时段（约 0:00-6:00）的「明天/后天」歧义——最容易踩的坑**：
熬夜场景下用户说"明早/明天弄"，口语上常指**今天白天**；但 CLI 的 `tomorrow` 永远是确定的 +1 日（00:00 后即次日）。
规则：凌晨时段收到"明天/后天 + 时刻"类指令时，**不要直接传 tomorrow**——先向用户确认一句"是今天白天还是次日？"，或按语境用显式日期（`YYYY-MM-DD HH:mm`）传参。例如 9-3 凌晨 1 点用户说"明天 9 点值守"，应传 `2026-09-03 09:00`（若指今天白天）而非 `tomorrow 09:00`（会落到 9-4）。

## 典型工作流

1. 「看看我今天还有什么没做」：`list --undone --json`
2. 「帮我加三个任务」：连续 `add`（进今日清单必须各自带 `--date today`，要分类再加 `--category`），最后 `list --json` 回读确认
3. 「把计算机图形学标记完成」：先 `list --undone --keyword 图形 --json` 拿到唯一 taskId，再 `done <taskId> --json`（读响应里的 `next` 提示）
4. 「这周完成了多少」：`stats --json`，读 `data[].done` 与 `focusMinutes`
5. 「整理这次讨论成一组任务」：批量 `add` + `--category` 归组，回读后向用户汇报清单
6. 「帮我开始专注/开始番茄」：`tomato start --task <关键词> --json`，然后 `tomato status --json` 确认倒计时在走；结束时 `tomato stop`（默认按已专注分钟落账）
7. 「这个任务正在番茄专注吗」：`tomato status --json` 看 `attach.taskId`
8. 「我上午做了XX没记上，补一下」：`tomato backfill XX --date today --minutes 40 --at 10:30 --json`；补昨天 `--date yesterday`（支持 today/yesterday/tomorrow/+Nd/YYYY-MM-DD）；`--free` 补不挂任务的自发专注
9. 「建个分类XX把这几个任务放进去」：`category add XX --json` → 批量 `edit <taskId> --category XX` → `list --category XX --json` 回读
10. 「把#work全改成#工作」：`tag rename work 工作 --json`（全库改写标题与描述），回读 `tag list --json`
11. 「明天11点帮我排一下」：`list --on tomorrow --json` 看那天已排的任务和时间 → 找空闲时刻 → `edit <taskId> --date "明天11点" --json` → `list --on tomorrow --json` 回读
12. 「这个任务排前面一点」：`sort <关键词> up --json`（或 top/bottom/after <另一任务>），`dayOrder` 数组即当日新顺序

## 命令速查

读（零风险，可随时用）：
```
overview                          # 今日完成度/逾期/无日期/回收站计数
list [--all|today|tomorrow|week|overdue|future] [--done|--undone] [--no-date] [--category 名称] [--keyword 词] [--quad q1-q4] [--view 视图名] [--lunar] [--limit N]
search <关键词> [--all]           # 全库内容/描述搜索
get <taskId|关键词>               # 单任务完整字段
categories                        # 分类列表（树状缩进，[folder] 标记；--json 增 folderIs/folderId/parentName）
category add <名> [--color hex] [--parent 文件夹] [--folder]   # 新建分类（--folder 建文件夹型；名称须唯一）
category move <名|id> --parent <文件夹|root>        # 移动到文件夹下/根（写；环守卫：文件夹不可挂进自己后代）
category rename <名|id> <新名>                      # 分类改名（写）
category rm <名|id> [--yes]                         # 软删分类（任务保留；须用户明确要求）
tag [list]                        # 标签列表（来自标题/描述的 #tag，带任务计数）
tag rename <旧> <新>               # 全库改写 #旧 → #新
tag rm <名>                        # 全库剥离某标签
projects [--status <v>]           # 项目列表（进度/专注分钟/逾期/未来7天/状态；项目=被标记的分类）
project <名称|id> [--on|--off] [--status active|paused|done|cancelled|none]   # 项目详情/设项目/改状态（写；none=清除回退active）
stats [--from YYYY-MM-DD --to YYYY-MM-DD]   # 每日完成量+专注分钟（默认近7天）
recycle                           # 回收站列表
view list                         # 保存视图列表（id/名称/条件摘要；与 App「保存的筛选视图」同库）
view add <名> [--category 名|id] [--priority 0-3] [--overdue] [--nodate]   # 新建视图（写，名称唯一）
view rm <名|id>                   # 删除视图（写）
tomato list [--date today|yesterday|YYYY-MM-DD] [<任务关键词>] [--n 30]   # 专注记录查询（只读；manual=补录）
log [--n 20] [--action add|edit|done|undo|delete|restore|purge|subtask|project.set|category.add|category.rename|category.delete|tag.rename|tag.remove|repeat.on|milestone.add|tomato.backfill]   # 外部写操作审计流水
doctor                            # 环境自检
clean [--all] [--dry-run]         # 清理测试/开发残留(临时userData+测试日志;--all连.dev-data,绝不碰真实用户数据)
```

写：
```
add <内容> [--desc 文本] [--date tomorrow] [--reminder "2026-09-01 09:00"] [--category 工作] [--difficulty 0-3]
done <taskId|关键词>              # 完成（写 completedAt）
undo <taskId|关键词>              # 撤销完成
edit <taskId|关键词> [--content 新标题] [--desc 文本] [--date tomorrow|none] [--reminder 时间] [--category 名称]   # --date none|clear = 清空日期移回待办箱
delete <taskId|关键词>            # → 回收站
restore <taskId|关键词>           # 从回收站恢复
purge --yes                       # 清空回收站（危险，需显式确认）
batch done <taskId>...                        # 批量完成（写；只收精确 id）
batch date <taskId>... --to <日期>            # 批量改期（写；日程块随迁）
batch category <taskId>... --to <分类|id>     # 批量归类（写）
batch tag <taskId>... (--add <tag> | --rm <tag>)  # 批量加/摘标签（写）
batch <...> --dry-run                         # 任何 batch 先预览，不落库
import <file.csv> [--format auto|ticktick|dida365|todoist] [--dry-run] [--category 名称] [--no-lists]
                                  # 从其他应用迁移（滴答清单/TickTick/Todoist 备份 CSV）。默认自动识别格式，
                                  # 识别失败再手动 --format；清单名默认建成分类（--no-lists 关闭）；
                                  # 重复任务自动去重（标题+日期指纹，二次导入同一文件=零写入）；
                                  # 必须先 --dry-run 预览（would import 计数）再实跑；源应用的重复规则不迁移，导入后用 repeat on 重建
```

## 原理（排障用）

- 数据层复用 Electron 主进程的 `src/main/db.js`（同一 SQLite：`%APPDATA%/pickdone/todos.db`，WAL 模式支持双进程并发；DB 加密，密钥 `db.key` 同目录，CLI 经 lib 自动解密）。
- 写语义对齐渲染端 store：新增 `status:'add'`、修改 `status:'update'`、删除 `status:'delete'`；`completedAt` 仅在完成/撤销时写。
- 运行中 App 通过 db 文件 mtime 监听（`src/main/index.js` watchDbForExternalWrites）感知 CLI 写入并自动刷新。
- `TODO_DB_DIR` 环境变量可把 CLI 指向隔离数据目录（测试用，勿对真实库做自动化实验）。
- 对标来源与设计取舍见 `analysis/AI管理接口-CLI对标与设计.md`。
