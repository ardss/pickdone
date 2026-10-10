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
| `store.mjs` | 内存/文件存储; API key 只存哈希; 账本 JSONL fsync 落盘,篡改启动即隔离(.bad) |
| `service.mjs` + `server/billing-service.mjs` | 独立薄 HTTP 服务(node:http,与 sync relay 同风格) |

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
node --test tests/unit/billing/*.test.mjs   # 26 tests
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
