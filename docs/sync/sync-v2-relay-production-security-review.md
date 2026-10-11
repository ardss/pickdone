# Sync v2 Relay 生产安全评审（b953a50e + 168dbb10）

- 评审日期：2026-10-11
- 评审方式：纯离线代码审读 + 本地测试复跑（D 盘隔离工作树，零远程操作）
- 评审对象：
  - `b953a50e` fix(relay): reject retired device bearer credentials
  - `168dbb10` test(relay): tolerate full-suite load flakes at the HTTP transport level（含生产加固主体）
- 测试证据（均为独立离线复跑，非代理自报）：
  - 定向面 42 pass / 0 fail / 0 skip（4.4s，node v22.22.0 原生 test runner，04:35 复核）
  - b6a14fb2 全量 4182 pass / 0 fail / 0 skip，exit 0（227s，04:31 复核，日志 `supervisor/qa-scratch/full-suite-b6a14fb2-independent-0431.log`）
  - b953a50e 所在 relay 树：19/19 + 全量复跑通过（17:31 复核）

## 1. 退役凭证即死凭证（b953a50e）

`pickdone/server/sync-relay.mjs`：设备被退役（retire/revoke）后，其 bearer secret 在**全部数据路由**上一律 401，包括账号级快照路径。配套 `relay-retired-revocation.test.mjs` 覆盖四个 P0 场景：

| 场景 | 结论 |
|---|---|
| 退役 bearer 在每条数据路由上均为死凭证 | PASS |
| 账号级快照路径拒绝退役 secret，活跃设备不受影响 | PASS |
| 盗取者自复活被轮换守卫阻断——轮换保持 retired 状态，新 secret 仍 401 | PASS |
| 退役不存在的设备行也无法借认证（无行即无访问） | PASS |

评审意见：撤销语义是"状态在服务端，凭证在客户端"，客户端持旧 secret 无法自救，符合预期。无发现。

## 2. 传输安全：原生 TLS（168dbb10）

- `startRelayServer` 新增 `tls: { cert, key }`（PEM 字符串），同一请求处理器在 HTTP/HTTPS 上**逐字节一致**——路由、守卫、限速、计费门控两套 scheme 完全相同。
- 意义：bearer secret 端到端保密，单二进制部署无需外挂反向代理终结 TLS。
- 部署约束保留：默认仍绑定 `127.0.0.1`；暴露 `0.0.0.0` 仍限受信网络（沿用头部注释约定）。
- 测试：`relay-production-hardening.test.mjs` "TLS: the identical route surface over HTTPS"（register/push/pull 带 bearer 认证全程 HTTPS）PASS；本地 TLS fixtures 仅测试用。

## 3. 计费门控持久化：fail-closed（168dbb10，PRODUCTION_NO_GO #4 修复）

- 用量账本由内存改为文件持久化：每次变更 write-through JSON 快照（tmp → fsync → rename，与 relay-state.json 同原语），构造时重载。
- **快照损坏/不可读的失败方向是安全的**：隔离至 `<path>.bad`、计量归零重启。推放（push）不因计量故障而拒绝，重放由 store 按 opId 去重、操作员 `setUsage` 重同步为权威——不会导致多计或少放。
- 门控策略：写操作 fail-closed，读操作（pull / snapshot latest / device state）永不计量不限流；`USAGE_OPS_CAP_PER_ACCOUNT = 200_000` 限制 op 记录规模。
- `--hosted <billingDataDir>`：把默认关闭的门控接到持久化 billing store，操作员绑定与用量随中继重启保留；绑定快照损坏时隔离并"信任归零"（fail-closed 方向正确）。
- 测试：配额跨 relay+gate 重启存活（重启不再绕过配额）、损坏快照隔离、绑定持久化与隔离、`main()` 启动卫生（tls 参数必须成对；hosted 模式落盘 billing 目录）全部 PASS。

## 4. 既有纵深防御确认（此前 CTO sweep，本次未改动）

- 注册限速：per-IP register limiter（默认 10 次/60s，容量上限），防未认证洪泛撑爆设备表。
- 连接预算：并发 TCP 连接上限 64。
- enrollment 比对使用 `timingSafeEqual`（等长 + 恒时比较）。
- 请求体上限 8 MiB。

## 5. 测试基建韧性（168dbb10 测试侧）

全量套件 ~11 进程并行下，新 relay 首批 HTTP 交换偶发 `fetch failed`：测试侧加**仅传输层的有限重试**——HTTP 状态码是真实答案永不重试；`registerT` 在唯一不安全重试情形（服务端已铸 secret 但响应丢失）回退全新 device id，避免撞轮换守卫 409；断言 409 的用例以 `fallback409:false` 关闭回退。评审意见：重试边界收在传输层、不吞业务语义，方向正确。

## 6. 范围外与遗留

- **范围外**：journey 三机、installer、release candidate——随 e4871981 任务被用户取消而作废，不属本评审。
- `relay-provision.mjs`（integration 树未跟踪文件，取消任务遗留）：仅留档，**未执行、未评审为交付代码**；未来若采纳须重新走评审。
- LAN 路径仍为 v1 LWW，已有留档，不阻塞本评审。
- 集成树 dirty 三处为取消任务现场留证，原样保留，不纳入本次提交。

## 7. 结论

**GO（代码与测试侧）**：b953a50e + 168dbb10 的 relay 生产加固（退役凭证撤销、TLS、计量/绑定持久化 fail-closed、限速与连接预算）测试证据完整且经独立离线复核，生产安全评审文档化缺口就此关闭。发布流程本身仍按 `docs/SOP-06-发布流程.md` 走，本评审不构成 release 许可。
