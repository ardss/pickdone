# Billing — 沙箱计费垂直切片 (2026-10-10)

**状态: SANDBOX ONLY。无真实商户、无真实收款、无真实支付链接。** 仓库审计(2026-10-10)确认此前无任何支付代码;本切片是第一个可运行的服务端计费闭环,provider-agnostic,等拿到真实商户证据后再落具体 provider 实现。

## 商业形态

- **local**(免费): 本地功能永久免费,不可被计费。
- **cloud**(付费): 托管多设备同步 — 我们跑 relay、存数据、付托管费。$4.99/月 或 $49.99/年,1GiB 配额,5 设备。
- **selfhost**(免费): 自建 relay,出口免费,不进计费管线。

不做储值钱包(合规风险),只做订阅权益;ledger 是审计账本,不是可消费余额。

## 架构 (pickdone/server/billing/)

| 模块 | 职责 |
|---|---|
| `plans.mjs` | 档位目录;价格只从这里来,客户端永远不报价 |
| `orders.mjs` | 订单 + 状态机 pending→paid/failed; paid→refunded/chargeback; 未列出的转换一律拒绝 |
| `webhook.mjs` | **唯一的钱入口**: 验签→规范化→金额/币种精确比对→事件去重→状态机→ledger→订阅 |
| `ledger.mjs` | append-only 哈希链账本 (charge/refund/chargeback),任何回改/删除/重排破坏 verifyChain |
| `entitlements.mjs` | 权益纯计算(不落库): 冻结>配额>档位; grace 3天; 过期降级 local |
| `providers/provider.mjs` | provider 契约: createPaymentIntent / verify / normalize |
| `providers/sandbox.mjs` | 沙箱 provider: 假 checkout URL (`sandbox://`)+ 签名 webhook 事件发射器 |
| `reconcile.mjs` | 账本 vs provider statement 双向对账 + 链校验 + 未应用事件 |
| `store.mjs` | 内存/文件存储; API key 只存哈希; 账本 JSONL fsync 落盘; 损坏即 fail-closed 只读隔离（见下节） |
| `service.mjs` + `server/billing-service.mjs` | 独立薄 HTTP 服务(node:http,与 sync relay 同风格) |

## 账本 fail-closed 隔离（2026-10-10 加固）

历史行为是 fail-open：`ledger.jsonl` 链损坏 → 重命名为 `.bad` → **空账本继续接新交易**（支付事实丢失、新链从 GENESIS 重开、权益照发）。已改为 fail-closed，异常一律只读隔离，**绝不自动改名/删除/重建任何文件**：

| 异常 | 判定 | 恢复路径 |
|---|---|---|
| `ledger-chain-broken` | 条目可解析但哈希链断裂（篡改/删行/重排） | 仅人工对账：`GET /v1/reconcile/report`（含完好前缀 totals + `ledgerHealth`），带外修文件后重启 |
| `ledger-corrupt-line` | 中途出现不可解析/空行 | 同上（人工） |
| `ledger-torn-tail` | 末行未终止（断电撕裂写）或未终止但可解析 | `POST /v1/reconcile/ledger/recover {"confirm":true}`（admin）：先逐字节归档到 `ledger.jsonl.torn-<ts>`，再原子重写为完好前缀；可解析尾条目仅在链式接得上时保留 |
| `state-corrupt` / `ledger-unreadable` | `billing-state.json` 不可解析 / 账本文件不可读 | 仅人工（带外修文件后重启） |

隔离期行为：`store.isWritable()===false`；webhook 一律 503（不记事件、不动订单，provider 恢复后重投天然放行，去重表未污染）；权益 503（先于鉴权，fail-closed 优先）；accounts/orders/usage/reconcile-POST 全部 503；store 层一切可变方法抛 `BILLING_READONLY`。只读面保留：`GET /v1/healthz`（编排层据此摘流量）、admin 对账报告。密码学完好的**前缀**仍以只读方式加载（`ledger.loadReadOnly`）供人工对账；`ledger.append` 抛 `LEDGER_READONLY`。

撕裂尾判定依据：`appendLine` 单次 `writeSync` 写入整行（含 `\n`）后才 fsync 确认，短写只会留下残缺前缀——"未终止的末行"必然未被确认，丢弃不损失已确认支付事实（provider 重投）。

## 安全模型

- 权益**只**由验签 webhook→订单 paid 发放;账号 key 本身买不了任何东西。
- webhook: HMAC-SHA256(`${ts}.${rawBody}`), ±5min 防重放窗口 + (provider,eventId) 持久去重;事件乱序(refund 先于 charge)记 deferred,paid 后回放收敛。
- 金额/币种必须与**服务端**订单精确一致;零/负/非整数金额直接拒。
- admin/internal token 来自 env,缺失则随机生成打印一次,绝不落盘入库。
- 身份是 mock(注册发 key,只显示一次);客户端自报 accountId 不授任何权益。

## 运行

```bash
node server/billing-service.mjs --port 58481 [--data ./billing-data]
# env: PICKDONE_BILLING_WEBHOOK_SECRET / _ADMIN_TOKEN / _INTERNAL_TOKEN
node --test tests/unit/billing/*.test.mjs   # 35 tests
```

## 上真实 provider 前的证据门槛

1. 真实商户账号 + 其 webhook 签名文档(非模板);
2. 沙箱环境的实测回调样本;
3. 实现对应 adapter(verify/normalize),现有核心零改动接入;
4. 合规确认订阅计费司法辖区要求(此切片刻意回避储值)。

## 已知缺口 (有意为之,非事故)

- 身份是 mock:真实部署需接正式身份体系(ISS/邮箱验证),当前 API key 即身份。
- usage 上报信任 internal token(给 relay 的接缝);relay 侧自动调用未接线(下一代理/后续 PR)。
- 对账是拉模式(管理员手动 statement POST);无定时任务。
- 退订未付清/部分退款(partial refund)未建模,真实 provider 接入时按其语义扩展。
- 税务/发票:完全未涉及。

## 账本/持久化真实隐患清单（2026-10-10 审计,未在本轮改动）

按"最小改动"原则,以下隐患**只记录不重构**,真实 provider 接入前必须处理:

1. **状态与账本无跨文件事务**:一次 paid 结算是 `recordEvent→persist(state)`→`patchOrder→persist(state)`→`ledger.append(fsync)`→`setSubscription→persist(state)` 多次独立落盘。进程在中间任一点崩溃都可能留下"账本已记 charge 但订单 pending/无订阅"或反之的半态;重启后 provider 重投会被事件去重挡住 → 订单停在 pending,靠 `sweepExpiredOrders`+对账报告发现。规范做法是单一 write-ahead 决定 + 幂等重放,属框架级改动。
2. **ledger.jsonl 追加是单 fd 同步写**(writeSync+fsyncSync),正确但无并发防护设计——当前单线程同步临界区成立,若未来引入 async 写路径会破坏"fsync 先于确认"的承诺。
3. **哈希链不防全量重写**:攻击者/事故若重写整个文件(含重算 hash),链仍自洽。防篡改需把尾部 hash 外部锚定(对账报告定期导出/异地比对),当前只有 `verifyChain` 自检。
4. **state 快照全量重写**,条目多时放大写延迟;JSONL state 或增量日志是后续选项。
5. **恢复入口只覆盖撕裂尾**;state-corrupt / chain-broken / corrupt-line 都是纯人工带外流程,没有受控的"导入完好前缀+冻结差异段"工具(有意如此——自动化它等于自动改钱史)。
