# PickDone 2.0 独立 QA 审计 — 2026-11-06

## 审计边界与结论

- QA 工作树：当前工作树 `.wt-pd20-qa-par-20261106`
- 分支：`feat/pd20-qa-par-20261106`
- 审计基线：`eb6a62d71faa2f31508d05f520233613e04d3b1d`，源头 `a61ab11a575fb23a2ddae2e53d3e7fa5e41c73b3`
- 需求源：任务目录中的 `MISSION.md`、`FINAL-DELIVERY.md`、`ACCEPTANCE.md`
- QA 只读检查 ZCode 工作树 `.wt-pd20-zcode-20261105`；没有写入该工作树。没有访问正式数据库/正式进程，没有 push、merge 或 release。
- 本文结论是对本次能复跑的源代码与有限测试的独立审计。原始交付文档及 ZCode 自述的物理机/打包证据作为“已记录证据”引用，未在本轮重新执行，因此不等同本轮独立验收。

**范围判定：eb6a62d7 尚未满足 PD20 全部要求。** 既有项目/任务功能不归功于本轮；提交版已实现执行记录与任务上下文、SourceRef/LAN 安全边界、项目工作接手概览等增量。Board 与完整任务/活动 Timeline 在该 SHA 未构建。ZCode 工作树有未提交 Board/Timeline 改动，但当前只读静态审查已发现 Timeline 标题缺失和 300 条硬上限，不能据此改变基线结论。

## 能力归属：先前已有 vs 本轮 8 个提交

### a61ab11a 基线已有（不计为本轮成果）

`ProjectView.vue` 已包含项目分类任务列表、里程碑条/编辑与项目 deadline，且组合 `ProjectDocs`、`DepView` 和任务列表分组。文件内存在“Milestone timeline”时轴，但它表达项目起止/里程碑日期，不是任务执行历史 Timeline。既有任务模型和 `todos.subtasks` JSON、子任务操作也在基线中。本轮新增契约测试验证了这些既有入口仍在当前提交版中。

### `a61ab11a..eb6a62d7` 新增的提交内容（只按实际 diff 归属）

| 提交 | 本轮内容 | 独立审计说明 |
|---|---|---|
| `17bc9788` | WorkEpisode、SourceRef、TaskSourceLink 的 LAN 同步和 file-provider 本机路径 egress 排除；配置门禁声明；同步测试/辅助工具与分片 | 这是跨设备工作连续性主要代码增量；本轮核对 egress predicate 和实体操作，双物理机结果只按交付记录引用。 |
| `45ee691c` | `work <task>` 上下文增加 `parseSubs` 子任务，并与 episodes/sources/handoff 同源输出 | 是 hierarchy→执行记录组合，不是新造任务层级/里程碑系统。 |
| `0637a069` | `queryEpisodesByCategory` 与 ProjectView 内可折叠 ProjectHandoff 概览 | 每任务最近 nextAction、episode 数及项目最近 8 条记录；不是 Board 或完整 Timeline。 |
| `7ad2d381` | browser-dev shim 覆盖新只读 op，episode journey 更新默认开启假设 | 测试/开发 shim 适配。 |
| `652c8d64` | handoff formatter 从 renderer 移到 `shared/handoff.mjs` | 修复 packaged CLI 的共享模块加载路径；需 packaged gate 保障。 |
| `7dfc3ece` | Extension journey all-green 后自然结束的测试/清理修复 | 测试运行时退出行为，不是新产品流程。 |
| `db34bee5` | 关闭归属 CDP sockets 并 bounded-await；移除强制退出兜底 | 交付记录称 quiet-box 8/8、自然 exit 0；高负载 timeout 仍记录为风险，本轮未运行 Chrome E2E。 |
| `eb6a62d7` | EditPanel work 区布局修正，ProjectHandoff 记录行能通过刷新 store 后打开 | 交付记录有三视口 UI 验收；本轮未启动 Electron 重放。 |

## P0 / P1 判定矩阵

状态针对 `eb6a62d7`，Pass 仅表示本轮可核查范围有足够证据；Partial 表示实现或历史证据存在但独立门禁未复验/验收要求仍开放；NotBuilt 表示提交版缺少该能力。

| ID | 状态 | 独立判定与剩余项 |
|---|---|---|
| P0-1 事实核验/能力矩阵 | Partial | 本轮区分了既有项目、里程碑、文档、依赖图与本轮改动，并核对关键源码；没有重跑所有 CLI/Web/Electron/Chrome/安装入口和 5 级矩阵。交付文档中的证据不替代本轮复跑。 |
| P0-2 工作接手闭环 | Partial | 提交版有 episode goal/outcome/nextAction、SourceRef 绑定、handoff Markdown/JSON、EditPanel 默认入口与持久层；本轮确认 UI/rollup 契约，但 edit/delete/restore、close/reopen、stale/unknown 来源提示与真实任务完整回归未独立执行。 |
| P0-3 跨设备安全同步 | Partial | 源码存在 episode/source/tasksource 同步和 `file` provider egress 排除；原交付记录声称双物理机 12/12。本轮没有创建双端隔离实例或复跑 W1–W5，不能独立签 Pass。 |
| P0-4 Agent 同源接口 | Partial | `lib-work.cjs` 把任务、parseSubs、episodes、sources、handoff 放入同一 context，写操作走 command bus；本轮未做独立隔离 DB CLI 执行和 packaged CLI 冷启动。 |
| P0-5 三方接手/独立 QA | Partial | 文档有甲/乙 SOP 和 scripted verifier，但明确没有真人第三方 L2。此次审计提供源代码与有限单元测试独立核查，未执行真实任务的甲→乙接手 SOP，真人 QA 仍缺。 |
| P0-6 多级任务兼容 | Pass（源码/契约范围） | `work` context 用既有 `lib.parseSubs(t)` 只读组合子任务、episodes、sources、handoff；没有新增迁移。新增 source-only 契约测试通过。Live DB/571+ 真实任务保护仍依赖历史隔离证据，未在本轮触碰。 |
| P1-01 项目概览 | Partial | 0637a069 有同源 ProjectHandoff rollup，展示每任务 nextAction/最近 8 条且不伪造完成状态；但 overview 仍不是 Board，也不是完整活动 Timeline。 |
| P1-02 Chrome 捕获→接手 | Partial | 测试 harness socket 生命周期修复存在，交付文档记录 E6 8/8 quiet-box 通过及高负载超时；本轮未启动 Chrome/MV3，独立运行被依赖缺失阻断。 |
| P1-03 系统级崩溃/重启/在线离线 | Partial | 交付记录包含部分 journey/restart 证据；本轮未跑 Electron、多进程/双机或安装回滚验证。 |
| P1 Board（ProjectView 任务看板） | **NotBuilt** | `eb6a62d7` 无 `ProjectBoard.vue`、无视图切换。当前 ZCode 工作树有未提交的 Board 实现，不能归入该提交 SHA。 |
| P1 完整任务活动 Timeline | **NotBuilt** | `eb6a62d7` 只有里程碑日期轴和 recent-8 工作摘要，没有 episode 全量时间轴。ZCode 暂存版尝试补足但有下文所列标题字段 bug 与 300 条限制。 |

## 源码发现与结构风险

1. **Board/Timeline 不能计入提交候选。** 只读检查 ZCode 工作树：`ProjectBoard.vue`、`ProjectTimeline.vue`、ProjectView 切换和 rollup timeline 扩展在 index 中暂存；`package.json` beta.29-ui2 版本改动还在工作区未暂存。该工作树 HEAD 仍为 `eb6a62d7`，没有提交这些差异，也没有在本轮运行其测试。
2. **ZCode Timeline row 标题当前为空（P1 阻断）。** `ProjectTimeline.vue` 显示 `e.taskContent`（第 15 行），load() 只把 task 标题写入 `taskTitles`（第 57–58 行），但赋给 `episodes` 的是 `res.timeline` 原样（第 59 行）。暂存的 `db-episode-ops.cjs` timeline row 仅包含 episodeId/taskId/startedAt/goal（第 141 行），没有 taskContent；`taskTitles` 未用于回填 episode rows。
3. **Timeline 不是完整历史。** ZCode 暂存的 `db-episode-ops.cjs` 有 `timeline.length < 300` 硬上限（第 140 行），返回值没有 cursor、total 或截断标志。即使修复标题，也不能满足无截断的“完整 Timeline”。
4. **原有里程碑 Timeline 与用户要求的任务 Timeline 必须分开验收。** ZCode ProjectView 第 48 行已有基线里程碑轴；名称包含 Timeline 不代表 episodes 全历史功能已实现。
5. **复验/依赖风险。** QA 工作树未安装 `dayjs`。一些单元文件在测试加载阶段失败，导致本轮不能用动态用例验证 SourceRef SQLite/sync 或 EditPanelWork 行为。没有改动依赖、安装包或其他测试来绕过该问题。

## 本轮执行命令及结果

工作目录为 QA 工作树；命令路径均相对 `pickdone/`，除非注明。

| 命令 | 退出码 | 结果 |
|---|---:|---|
| `node --test tests/unit/components/pd20-independent-qa-contract.test.mjs` | 0 | 本轮新增 5 个 source-only 契约断言通过：既有 ProjectView 入口、层级 context 组合、file SourceRef egress 边界、提交 SHA Board/Timeline 缺口、handoff recent/nextAction 字段。 |
| `node --test tests/unit/components/projectview-handoff.test.mjs tests/unit/main/episode-category-rollup.test.mjs tests/unit/renderer/handoff.test.mjs` | 0 | 15/15 pass；覆盖 ProjectHandoff 入口/过滤/行点击契约、rollup tombstone/recent-8、Markdown/JSON formatter。 |
| `node --test tests/unit/components/projectview-handoff.test.mjs tests/unit/main/episode-category-rollup.test.mjs tests/unit/renderer/editpanel-work.test.mjs tests/unit/renderer/handoff.test.mjs tests/unit/main/pd20-episode-sync.test.mjs` | 1 | 15 pass、2 fail。`pd20-episode-sync.test.mjs` 与 `editpanel-work.test.mjs` 在加载阶段 `Cannot find module 'dayjs'`；不是断言失败，动态 SourceRef/sync 与 EditPanel 行为证据因此缺失。 |
| `node cli/check-boot-order.cjs --staged`（提交钩子步骤） | 1 | QA 工作树未安装 `acorn`，静态门禁在加载阶段失败。提交钩子因此未能继续后续 ESM、lint 和 core 测试步骤；没有为通过钩子而安装依赖或运行全集。 |
| `git diff --check` | 0 | 无 whitespace 错误。 |

未运行全集（约 6000 测试）、Chrome/Electron 长测、打包、双机同步或正式数据相关命令。

## 交付物与 cherry-pick

- 本报告：`pickdone/docs/pd20-independent-qa-20261106.md`
- 独立契约测试：`pickdone/tests/unit/components/pd20-independent-qa-contract.test.mjs`
- 报告与测试作为单一 QA-only commit 提交；可安全 cherry-pick 到集成分支（不含产品实现，不含测试依赖变更）。提交 SHA 见审计提交记录/终端回执。
- cherry-pick 仅带来审计证据；它不会把 P0/P1 状态提升为 Pass，也不代表 ZCode 未提交改动已验收。
