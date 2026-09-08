---
name: cgc-core-onboarding
description: Use when helping a user connect DSH to the CGC-2046 platform for the first time or after a failure — walks through entering the MCP URL and token in the CGC panel, verifying the connection, and recovering from auth or network errors. Also covers the workspace_id discipline, the two-tool confirmation flow, and the invitation link flow once connected.
---

# CGC-2046 连接引导

帮用户把 DSH 连上 CGC-2046 平台。连接本身由用户在「CGC」面板里完成——你负责引导、验证结果、解读错误。**你不经手 token**：不要让用户把 token 贴在对话里，不要替用户打开 settings.yaml。

## 1. 判断当前状态

- 「CGC」面板的连接状态区会显示 已连接 / 未连接 / 连接错误，以及已配置的 MCP URL。
- 用户也可以在平台网站 MCP 页确认 token 是否仍然有效。

## 2. 首次连接（或断开后的重连）

1. 让用户在 CGC-2046 网站的 MCP 页面创建一个连接 token（建议用设备命名，如 `my-macbook`，便于日后吊销）。
2. 打开 DSH 侧边栏的「CGC」面板，在连接表单填入 MCP URL（默认 `http://localhost:4102/mcp`）和上一步的 token，点「连接」。
3. 面板状态变为「已连接」即成功，此时 `mcp__cgc-2046__*` 工具可用。

## 3. 失败分支

- **认证失败（401/403，凭证无效或已吊销）**：不要反复重试。让用户回平台 MCP 页检查 token 状态；若已吊销，重新创建 token 后在面板改存。旧设备不再使用时，顺手引导用户在平台侧吊销对应 token。
- **连接错误（网络 / URL / 服务不可达）**：确认平台网站已启动、URL 拼写正确（本地开发是 `http://localhost:4102/mcp`）；修好后在面板重新点「连接」。
- **业务 / 超时错误**：平台侧问题，让用户稍后在面板看最近活动记录重试。

## 4. 连接后的使用纪律

- 除 `confirm_operation` / `cancel_operation` 外，所有 `mcp__cgc-2046__*` 工具都需要 `workspace_id`；用户没给就问一句，不要编造。
- 写操作分两类：`save_step_output` 直接落库；`create_invitation` 走两段确认——返回 `needs_confirmation` + `pending_id` + 摘要时，把摘要原样转述给用户、征得明确同意 → 调 `confirm_operation`（带 `pending_id`）；用户取消则调 `cancel_operation`。确认发生在对话内，平台没有网站前端确认步骤；pending 约 10 分钟过期，过期需重新发起。
- `create_invitation` 走两步：先创建拿链接，再把链接发给用户，由用户自行转发。不要替平台发送邀请。
- token 是凭证：永远不在对话、日志、工具输出里展示或回显它；用户要管理 token 时，引导去面板表单或平台 MCP 页。
