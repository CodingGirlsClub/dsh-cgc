# dsh-cgc-core

CGC-2046 平台连接器：让 DSH（DeepSeek Harness）成为与 OpenClacky 平级的一等 BYO agent 通道。

## 功能

- **MCP 桥**：`StreamableHTTPClientTransport` 连接 CGC-2046 平台的 `/mcp` 端点（Bearer token 鉴权），平台固定的 8 个工具以 `mcp__cgc-2046__<rawName>` 注册进 DSH 工具注册表，连接断开即注销。
- **连接状态面板**：侧边栏「CGC」入口 + 居中面板——连接表单（MCP URL + token）、状态徽标、平台网站链接、「在平台管理 / 吊销 token」链接、最近活动列表。
- **路由族** `/api/dsh-cgc-core`：`GET /status`、`POST /connect`、`DELETE /connect`（loopback-only）。
- **cgc-assistant 预设**：persona + skill-filesystem + tool-skill 组合，附带本插件的 onboarding skill。
- **onboarding skill** `cgc-core-onboarding`：首次连接 / 失败恢复引导。
- **错误 hook**：连接类失败（`CGC_MCP_AUTH` / `CGC_MCP_TIMEOUT` / `CGC_MCP_CONNECT`）脱敏后进活动列表；业务失败留在对话内；写工具成功按 R9 记名 + workspace_id。
- **系统提示公告**：连接后向 system prompt 宣告 8 工具可用与 workspace_id / 两段确认纪律。

## 安装（本地开发）

```bash
# 构建
pnpm -r build

# 装入某个 DSH profile（自动注册到 dsh.profile.bundles）
dsh plugin --profile <profile> add /path/to/dsh-plugin/packages/dsh-cgc-core

# 或一键安装整个家族（聚合包）
dsh plugin --profile <profile> add /path/to/dsh-plugin/packages/dsh-cgc-all
```

## 使用

1. 在 CGC-2046 网站的 MCP 页面创建连接 token（建议设备命名，如 `my-macbook`）。
2. 打开 DSH 侧边栏「CGC」面板，填入 MCP URL（本地开发默认 `http://localhost:4102/mcp`）与 token，点「连接」。
3. 状态变为「已连接」后，`mcp__cgc-2046__*` 工具对 agent 可用。

## 契约

与平台侧的稳定约定见仓库根目录 [`CONTRACT.md`](../CONTRACT.md)。
