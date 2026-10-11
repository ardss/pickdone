# Sync v2 验收矩阵（go/no-go 硬标准）— 2026-10-10

> 本文是 `docs/sync-coverage-matrix.md`（2026-09-29，tier 1-5，已过期）之后的增量：针对
> 03-release-verification 报告指出的 v1 架构缺口，定义 v2 候选实现必须通过的硬标准。
> 落地测试：`tests/unit/lan-sync/v2-acceptance-drill.test.mjs`（双真实进程 + 真实 DB +
> 生产 merge 管线，loopback TCP）与 `v2-acceptance-relay.test.mjs`（真实 relay server，
> 127.0.0.1 随机端口）。全部确定性：时间戳为固定逻辑常量（等效固定随机种子）。

## 定位声明

当前 HEAD = Sync v1（实体级 updateTime-LWW）。下列 "v1 baseline" 断言锁定的是 v1 的
**实际行为**（含已知缺陷），目的：任何回归都会响；v2 落地时这些断言按 "v2 bar" 列改写。
**测试失败照实保留，禁止通过放宽断言把失败改成通过。**

| # | 场景 | v1 baseline（已锁定） | v2 bar（go/no-go 硬标准） | 测试 |
|---|---|---|---|---|
| S1 | 多设备时钟偏差 | 快 1 年的时钟的旧写战胜真实更新的写，败者仅以冲突副本存活 | 因果/DVV 胜者与墙钟无关；偏差时钟不产生静默丢写 | drill S1 |
| S2 | 离线两机并发同实体 | 全场同胜者 + 败者副本（tier-3 契约成立） | 互补字段编辑无副本地收敛；整实体冲突才显式可见 | drill S2 |
| S3 | 重复包/乱序 | 幂等：无重复行，旧重放不回滚新状态（当前通过） | 同左，作为硬门禁保持 | drill S3 |
| S4 | 删改与墓碑 | 墓碑胜旧编辑；新于墓碑的编辑复活行 | 删除 vs 编辑必须显式可审计（无论策略方向），复活不得静默 | drill S4 |
| S5 | 重配对/旧 cursor | cursor 回卷 + 重新 addPeer 后重放幂等（当前通过） | 同左，作为硬门禁保持；重配对后空快照 epoch 重置兼容 | drill S5 |
| R1 | relay ack/GC 多设备 | floor = 活跃设备 ack 最小值，快设备不饿死慢设备 | 同左 + torn-state 重启（#172 类）下 fresh write 不丢 | relay R1 |
| R2 | 受限 payload | 超 4MB 预算 → 编码化 4xx，小包继续可用 | 分块 push 在拒绝后可恢复；任何路径不得静默丢 | relay R2 |
| R3 | 旧 cursor pull | 全历史可重放，重复 pull 逐字节一致，opId 客户端去重 | 同左 | relay R3 |
| R4 | 设备生命周期 | per-device secret；retired 不钉 floor | 密钥轮换/撤销后旧密文处置（v1 无覆盖，v2 必须） | relay R4 |

## 未覆盖（如实声明，v2 前需补）

- 真实公网 relay（NAT/TLS/丢包/MTU）：本套全部 loopback。
- 密钥轮换/设备撤销后 relay 残留密文处置（风险矩阵 #7）。
- down-grade 协议兼容（旧客户端 ↔ 新 relay）。
- 断线注入（半途拔网线）：drill 是显式 round 驱动，未做 mid-kill（d9-loopback-restart-conflict 部分覆盖重启侧）。

## 结论基线（2026-10-10，HEAD a4b51d8a）

v1 在 S1/S2/S4 上是"已知会静默丢/复活数据"的架构；S3/S5/R1-R4 当前可作硬门禁。
**No-GO 判据：S1 或 S2 的 v1 baseline 行为在 v2 候选上未改变即 no-go；S3/S5/R1-R4 任一
回归即 no-go。**
