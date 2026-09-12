# shared/ — 跨进程共享纯函数模块

本目录存放被 **两个及以上异构消费方**（渲染端 + CLI / 主进程 + 渲染端）共享的纯函数模块。

## 准入标准（三条件缺一不可）

1. **纯函数、零运行时依赖**——不 import DOM、i18n、electron、dayjs 等有状态库。需要 dayjs 实例或 locale 格式串时由调用方注入（参照 `nl-date-core.mjs` 的 `base` / `cnFullFormat` 参数模式）。
2. **至少两个异构消费方**——只有一方用的逻辑留在该方目录内，不上浮。
3. **ESM `.mjs` 格式**——`check-esm-graph` 门禁把渲染端可达文件全按 ESM 解析，CJS 不可见。CJS 消费端（CLI / 主进程）用 Node ≥22.12 的 `require(esm)` 加载（engines 已钉）。

## 现有模块

| 模块 | 消费方 | 说明 |
|---|---|---|
| `limits.mjs` | db.js / cli/lib.js / renderer store+tomato | 番茄时长 600 存储钳制 / 720 UI 输入上限 |
| `nl-date-core.mjs` | renderer utils/nlDate.js + cli/nl-date.cjs | 中文自然语言日期解析纯函数核心 |
| `quit-ack.js`（main 内） | index.js | 退出冲刷 ack 状态机 |
| `watch-baseline.js`（main 内） | index.js | 外部写监视器基线更新 |

## 边界声明格式

参照 `nl-date-core.mjs` 头注释的三段式：标明哪些逻辑在本模块（SHARED）、哪些留在渲染端（RENDERER-ONLY）、哪些由调用方供给（CALLER-SUPPLIED）。

## 红线

- **不做垃圾抽屉**——"可能有用"的函数不上浮，等第二个消费方出现再提。
- **禁止导出 RegExp 对象**（有状态 `lastIndex` 风险源）。
- 内联常量（如 600/720）在第二个消费方出现时必须提取到 `limits.mjs`，禁止继续散布。
