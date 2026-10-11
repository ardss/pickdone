# INSTALL-DODO — Dodo Payments OpenCode 插件安装记录

安装日期：2026-10-10 · 隔离 worktree：`C:\Users\13397\.paseo\worktrees\37tvj1z6\dodo-plugin`（分支 `feat/dodo-opencode-plugin`）

## 安装内容

- **OpenCode 项目根**：`pickdone/`（本仓库唯一含 `package.json` + `package-lock.json` 的 npm 项目；`opencode.json` 与其同级，`skills.paths` 相对该目录解析，与 `node_modules` 同级）。
- **插件**：`@dodopayments/opencode-plugin@0.6.5`（npm 官方 registry `registry.npmjs.org`，发布者 Dodo Payments，MIT）。
- **改动文件**：`pickdone/package.json`（devDependencies 新增 `^0.6.5`）、`pickdone/package-lock.json`、`pickdone/opencode.json`（新建，本仓库此前无任何 opencode 配置，未覆盖任何既有 plugins/mcp/skills）、本文件。
- `node_modules/` 被 `.gitignore` 排除，不入库。

## 安装方式（本 worktree 实际执行）

```bash
cd pickdone
# 1) 只更新 package.json + lock（不安装整棵 Electron 依赖树），钉官方 registry：
npm install --package-lock-only --save-dev --ignore-scripts --registry=https://registry.npmjs.org/ @dodopayments/opencode-plugin
# 2) 拉取插件包本体用于技能目录验证：
npm pack @dodopayments/opencode-plugin@0.6.5 --registry=https://registry.npmjs.org/
tar -xzf dodopayments-opencode-plugin-0.6.5.tgz -C node_modules/@dodopayments/opencode-plugin --strip-components=1
```

说明：

- `--ignore-scripts` 依据：npm 安装会执行不可信包 scripts（如 electron postinstall 下载二进制），隔离环境无需执行。
- 本 worktree 的 `node_modules` **只含插件包本体**，项目其余 devDependencies（Electron 全家桶）未安装；完整安装请在该目录正常跑 `npm install`。
- 常规机器上直接 `npm install --save-dev @dodopayments/opencode-plugin` 即可等效。

## opencode.json（pickdone/ 下）

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@dodopayments/opencode-plugin"],
  "skills": { "paths": ["node_modules/@dodopayments/opencode-plugin/skills"] }
}
```

## 实测结果（2026-10-10，OpenCode 1.18.35）

- `opencode --version` → `1.18.35`（exit 0）。
- `opencode mcp list`（在 pickdone/ 下）→ 两个 MCP 真实注册：
  - `dodopayments-api`（`https://mcp.dodopayments.com/mcp`）→ **needs authentication**（已注册，待授权）。
  - `dodo-knowledge`（`https://knowledge.dodopayments.com/mcp`）→ **connected**。
  - 既有 MCP（context7/github/memory/playwright 等）未受影响。
- 技能目录：`node_modules/@dodopayments/opencode-plugin/skills` 下 **18 个** `SKILL.md`（官方文档口径约 17，实际 18）：better-auth-integration、billing-sdk、checkout-integration、credit-based-billing、customer-management、discounts-and-promotions、dodo-best-practices、dodo-mcp-usage、framework-adapters、license-keys、localized-pricing、mobile-checkout、product-catalog-management、refunds-and-disputes、subscription-integration、testing-and-go-live、usage-based-billing、webhook-integration。
- `npm ls @dodopayments/opencode-plugin --depth=0` → `@dodopayments/opencode-plugin@0.6.5`（exit 0）。
- `package.json` / `package-lock.json` / `opencode.json` 均 JSON 可解析（node 校验 exit 0）。
- **未通过**：`opencode run 'List every skill…'` 返回 `Unexpected server error`（ref err_b999623a，原因未确认）。技能的 LLM 侧识别验证未完成；MCP 与技能文件本身已实证存在。可在干净终端重试：
  `DODO_DISABLE_API_MCP=1 opencode run 'List every skill available to you by name.'`

## 启动 / 重启 OpenCode

- 在 `pickdone/` 目录下启动（或重启已开着的 OpenCode）即可加载本配置：`opencode`。
- 需要纯知识模式（禁用 API MCP、避免任何账号交互）时：`DODO_DISABLE_API_MCP=1 opencode`。
- 也可用 `DODO_DISABLE_KNOWLEDGE_MCP=1` 单独禁用知识 MCP（插件源码 `opencode-plugin/index.js` 实证支持这两个开关）。

## 待用户本人完成：OAuth 登录

`dodopayments-api` 当前 **未授权**。授权需本人交互完成，AI 不得代做：

```
opencode mcp auth dodopayments-api
```

（浏览器 OAuth 流程，无需在安装时提供 API 密钥。）授权完成前，涉及 Dodo 账户的调用不可用。

## 安全边界

- **默认两个 MCP 均为远端（mcp.dodopayments.com / knowledge.dodopayments.com），经 OAuth 认证。默认接入远端 API MCP 后不要用它触碰 live 账户/真实资金；如需真实交易验证，请先用 Dodo 测试模式（test mode）。**
- 本仓库（及本次提交）**未写入任何** `DODO_PAYMENTS_API_KEY` / `DODO_PAYMENTS_WEBHOOK_KEY`、测试 key 或 token——json/日志/Git 中一律不得硬编码。密钥只应来自 OS 环境变量（且默认 OAuth 方案根本不需要密钥）。
- 本次安装只完成**插件与技能接入**，不代表 Dodo 真实支付/结算已开通。
