# CGC-2046 平台契约（DSH 插件家族侧锚点）

本文件列举 dsh-cgc 插件家族依赖的 CGC-2046 平台稳定约定。每一行都标注了平台源码锚点；平台变更任一锚点时，本文件与插件实现必须同步更新。核对集：`backend/lib/cgc_2046/mcp/server.ex`、`backend/lib/cgc_2046_web/plugs/mcp_auth_plug.ex`、`backend/lib/cgc_2046_web/plugs/mcp_protocol_compat_plug.ex`、`backend/lib/cgc_2046/mcp/token.ex`、`backend/lib/cgc_2046/mcp/tools/*.ex`、`backend/lib/cgc_2046_web/router.ex`。

## 端点与传输

- MCP 端点路径 `/mcp`，POST，streamable HTTP（Phoenix forward）。
  锚点：`backend/lib/cgc_2046_web/router.ex`（`:mcp` pipeline + forward）。
- pipeline 顺序：`McpProtocolCompatPlug` → `McpAuthPlug`。
- MCP server name 固定为 `"cgc-2046"`，capabilities 仅 `[:tools]`，无动态工具（无 `tools/list_changed` 再同步）。
  锚点：`backend/lib/cgc_2046/mcp/server.ex:16-19`。
- 本地开发默认地址 `http://localhost:4102/mcp`（联调值；生产域名确定后只改默认值，协议不变）。

## 鉴权与 token 语义

- 鉴权头：`Authorization: Bearer <plain_token>`；成功即 assigns `:current_user`。
  锚点：`backend/lib/cgc_2046_web/plugs/mcp_auth_plug.ex:21-27`。
- 401 响应体 `{"error":"invalid_token"}`，带 `WWW-Authenticate: Bearer realm="cgc-2046-mcp"`。
  锚点：`mcp_auth_plug.ex:29-32`。
- token 形态：`cgc_` + 43 字符 base64url（32 字节强随机，`Base.url_encode64(padding: false)`）。
  锚点：`backend/lib/cgc_2046/mcp/token.ex:128`。
- **token 绑用户、不绑工作区**：`user_id` 归属，policy 约束 `user_id == actor`；`workspace_id` 是每次调用的参数，不在 token 语义内。
  锚点：`token.ex:44,94-109,195-199,211`。
- **token 无过期，仅 `revoked_at`**：撤销 = 置 `revoked_at`（保留审计行，不删记录）；校验只看 `revoked_at IS NULL`。
  锚点：`token.ex:13,58,150-176,279`。
- 吊销指引：token 建议以设备命名（如 `my-macbook`），旧设备不再使用时在平台网站 MCP 页吊销对应 token（F3）。

## 工具清单（固定 8 个）

锚点：`backend/lib/cgc_2046/mcp/tools/*.ex`（一文件一工具）。

| 工具 | 参数 | 类别 |
|---|---|---|
| `get_workspace_context` | `workspace_id` string **必填** | 读 |
| `list_members` | `workspace_id` string **必填** | 读 |
| `get_workflow` | `workspace_id` string **必填** | 读 |
| `get_step_output` | `workspace_id`、`run_id`、`step_key` 均 string **必填** | 读 |
| `save_step_output` | `workspace_id`、`run_id`、`step_key` 均 string **必填**、`output` map **必填**（浅合并入 `facts[step_key]`）、`reason` string 可选（随 output 同次浅合并） | 写（直接写，不走两段确认） |
| `create_invitation` | `workspace_id` string **必填**、`target_email` string 可选（空 = 公开链接）、`expires_in_hours` integer 可选 | 写（**唯一的两段确认工具**） |
| `confirm_operation` | `pending_id` string **必填**（needs_confirmation 返回） | 确认 |
| `cancel_operation` | `pending_id` string **必填** | 取消 |

- 除 `confirm_operation` / `cancel_operation` 外，所有工具都需要 `workspace_id`（D6/D12；token.ex 头注同样写明 workspace_id 是参数判定）。
- 两段确认流（仅 `create_invitation`，confirmation.ex / wrapper.ex）：写调用先建 PendingOperation 并返回 `needs_confirmation` + `pending_id` + `summary`（不落业务库）→ agent 把摘要展示给用户、征得明确同意 → 调 `confirm_operation`（带 `pending_id`）→ `execute_confirmed/2` 真正落库；用户拒绝则调 `cancel_operation`。**确认发生在 agent 客户端对话内，平台无独立的网站前端确认步骤。**pending 默认 10 分钟窗口（`mcp_confirmation_ttl_seconds`，默认 600s，读时派生 expired），过期后需重新发起。

## 插件家族侧保留

- 工具命名空间 `mcp__cgc-2046__<rawName>` 由 dsh-cgc-core 保留（8 个工具原样桥接，不改名、不增删）。
- 凭据存储：DSH settings 的 `dsh-cgc-core` namespace（`mcp_url` / `plain_token` / `web_url`），仅存本机 profile，不落对话、不落日志。
- 错误归一化：401/403 → `CGC_MCP_AUTH`（停止重连、面板 surface）；超时 → `CGC_MCP_TIMEOUT`；其余连接失败 → `CGC_MCP_CONNECTION`；业务失败（`isError: true`）→ `CGC_MCP_BUSINESS`（留在对话内，不进活动列表）。
- 日志与事件文本过 redact：`cgc_` + 43 base64url token、Bearer 头值、裸 JWT、平台敏感 key 名单（token/password/secret/authorization 等，exact + `_xxx` snake 后缀 + `Xxx` camelCase 尾）。
