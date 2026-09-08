---
name: cgc-core-onboarding
description: Use when helping a user connect DSH to the CGC-2046 platform for the first time or after a failure — walks through creating a token on the platform, entering the MCP URL and token in the CGC panel form, and verifying the connected status before reporting done. Also covers failure recovery, the per-schema workspace_id discipline, and the two-tool confirmation flow once connected.
---

# CGC-2046 连接引导

帮用户把 DSH 连上 CGC-2046 平台。连接本身由用户在「CGC」面板里完成——你负责引导、验证结果、解读错误。**token 永不进入对话、工具参数或日志**：不要让用户把 token 贴在对话里，不要替用户打开 settings.yaml，不要把 token 写进任何工具调用或文件。

## 1. 判断当前状态

- 「CGC」面板的连接状态区会显示 已连接 / 未连接 / 连接错误，以及已配置的 MCP URL。
- 用户也可以在平台网站 MCP 页确认 token 是否仍然有效。

## 2. 首次连接（或断开后的重连）

严格三步，缺一不可：

1. **引导创建 token**：让用户在 CGC-2046 网站的 MCP 页面创建一个连接 token（建议用设备命名，如 `my-macbook`，便于日后吊销）。token 由用户自己复制粘贴，经手人只有用户本人。
2. **面板表单完成连接**：让用户打开 DSH 侧边栏的「CGC」面板，在连接表单填入 MCP URL（本地开发默认 `http://localhost:4102/mcp`）和上一步的 token，点「连接」。
3. **验证状态后才报告完成**：面板状态区显示「已连接」、`mcp__cgc-2046__*` 工具可用，亲眼确认后再向用户报告完成；状态未变或出现错误就按第 3 节诊断，不要提前宣布成功。

## 3. 失败分支

- **认证失败（401/403，凭证无效或已吊销）**：不要反复重试。让用户回平台 MCP 页检查 token 状态；若已吊销，重新创建 token 后在面板改存。旧设备不再使用时，顺手引导用户在平台侧吊销对应 token。
- **连接错误（网络 / URL / 服务不可达）**：确认平台网站已启动、URL 拼写正确（本地开发是 `http://localhost:4102/mcp`）；修好后在面板重新点「连接」。
- **业务 / 超时错误**：平台侧问题，让用户稍后在面板看最近活动记录重试。

## 4. 连接后的使用纪律

- 平台工具集以连接时 tools/list 返回的全量清单为准；参数要求以各工具自身 schema 为准——多数业务工具的 schema 要求 `workspace_id` 等作用域参数，用户没给就问一句，不要编造。
- 高风险写操作走平台的两段确认流：这类工具首次调用返回 `needs_confirmation` + `pending_id` + 摘要。把摘要原样转述给用户、征得明确同意 → 调 `confirm_operation`（带 `pending_id`）；用户取消则调 `cancel_operation`。确认发生在对话内，平台没有网站前端确认步骤；pending 默认约 10 分钟过期（平台可配），过期后向用户说明并重新发起原工具调用。
- 邀请类操作走两步：先创建拿链接，再把链接发给用户，由用户自行转发。不要替平台外发邀请。
- token 是凭证：永不进入对话、工具参数或日志——不展示、不回显、不写入任何文件；用户要管理 token 时，引导去面板表单或平台 MCP 页。
