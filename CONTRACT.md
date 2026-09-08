# CGC-2046 平台契约（dsh-cgc / OpenClacky 双通道共用锚点）

本文件列举 CGC 插件家族（DSH 插件家族与 OpenClacky 通道）依赖的 CGC-2046 平台稳定约定，由 `CodingGirlsClub/dsh-cgc` repo 持有，双通道共用（R16）。平台变更任一约定时，本文件与两侧实现必须同步更新。

**核对纪律（KTD10）**：文末「机器可读核对集」是本文件的一部分，`scripts/check-contract.mjs` 把它对平台 repo 快照（env `CGC_PLATFORM_REPO` 指路）做结构匹配校验，并做三方相等比较「平台集合 = 本核对集 = `packages/dsh-cgc-core/src/protocol.ts` 早门名单常量 `CGC_CONFIRMATION_TOOLS`」。CI 在 push 与每日定时触发跑该脚本，任一锚点漂移即红。脚本只做**结构/内容锚点匹配**（组件名、`execute_confirmed/2` 命中集、关键字符串），不匹配行号——文中行号仅供人读定位。

平台核对面：`backend/lib/cgc_2046/mcp/server.ex`、`backend/lib/cgc_2046/mcp/confirmation.ex`、`backend/lib/cgc_2046/mcp/pending_operation.ex`、`backend/lib/cgc_2046/mcp/token.ex`、`backend/lib/cgc_2046/mcp/tools/*.ex`、`backend/lib/cgc_2046_web/plugs/mcp_auth_plug.ex`、`backend/lib/cgc_2046_web/plugs/mcp_protocol_compat_plug.ex`、`backend/lib/cgc_2046_web/router.ex`、`backend/config/*.exs`。

## 端点与传输

- MCP 端点路径 `/mcp`，streamable HTTP（Anubis `StreamableHTTP.Plug`，Phoenix forward）。
  锚点：`backend/lib/cgc_2046_web/router.ex`（`scope "/mcp"` + `forward("/", Anubis.Server.Transport.StreamableHTTP.Plug, ...)`，人读锚 router.ex:70-74）。
- pipeline 顺序：`McpProtocolCompatPlug` → `McpAuthPlug`（兼容 shim 必须在鉴权之前）。
  锚点：router.ex:57-60。
- MCP server name 固定为 `"cgc-2046"`，capabilities 仅 `[:tools]`，无动态工具（无 `tools/list_changed` 再同步）；elicitation 不启用。
  锚点：`backend/lib/cgc_2046/mcp/server.ex:72-75`。
- 本地开发默认地址 `http://localhost:4102/mcp`（联调值；生产域名确定后只改默认值，协议不变）。

## 协议版本兼容（McpProtocolCompatPlug）

- 客户端**不发送 `mcp-protocol-version` 头，或发送 ≥ `2025-03-26` 的版本**。
- 平台 shim 仅把恰好为 `2024-11-05` 的头删除（OpenClacky ≤1.5.6 旧客户端兼容），让 Anubis 走「header 缺失按 2025-03-26 放行」的向后兼容路径；其它不认识的旧版本仍被 Anubis 400。
  锚点：`backend/lib/cgc_2046_web/plugs/mcp_protocol_compat_plug.ex`（`@legacy_version "2024-11-05"` + `delete_req_header(conn, "mcp-protocol-version")`）。
- DSH 侧 MCP client 由插件控制，按现代 streamable-http 行为不发旧版头，天然满足本条款。

## 鉴权与 token 语义

- 鉴权头：`Authorization: Bearer <plain_token>`；成功即 assigns `:current_user`（anubis transport 透传进 tool frame.assigns）。
  锚点：`backend/lib/cgc_2046_web/plugs/mcp_auth_plug.ex:28-36`。
- **401 形状**：响应体 `{"error":"invalid_token"}`，带 `WWW-Authenticate: Bearer realm="cgc-2046-mcp", error="invalid_token"`。
  锚点：mcp_auth_plug.ex:47-53。
- **429 形状**：按 remote_ip 计失败认证（ETS 固定窗口，默认 20 次 / 15 分钟 = 900s），超限返回 429 + `Retry-After: 900`，响应体 `{"error":"rate_limited"}`；成功认证不计数不受节流。
  锚点：mcp_auth_plug.ex:22,42-59,64-67（`@throttle_window_seconds 900`、`Keyword.get(:max_attempts, 20)`）。
- **token 生成格式**：`cgc_` + 43 字符 base64url（`:crypto.strong_rand_bytes(32) |> Base.url_encode64(padding: false)`）。
  锚点：`backend/lib/cgc_2046/mcp/token.ex:149`。此格式同时是插件 redact 层精确替换 + 形状正则的锚（RSK6）：平台格式变更时 CI 红。
- **库存 SHA256，不落明文**：`token_hash = SHA256(token)` hex lower；明文仅 `:issue` 创建时经 `metadata.plain_token` / changeset context 一次性返回；`identity(:unique_token_hash, [:token_hash])`。
  锚点：token.ex:11-13,36-39,79,150-154,297。
- **90 天滚动闲置过期**：连续 90 天未使用即失效（`@idle_expiry_days 90`），锚点取 `last_used_at`（从未使用回退 `inserted_at`）；惰性派生判定，行保留不置 `revoked_at`；正常使用不断无需重签。
  锚点：token.ex:23-24,324-330。
- **每用户 active token 上限 10**：`@max_active_tokens_per_user 10`，资源层守卫；active = 未撤销且未闲置过期。
  锚点：token.ex:21-22,118-130。
- **撤销 = 置 `revoked_at`**：保留审计行不删记录；校验只看 `token_hash` 匹配 + `revoked_at IS NULL`；重复撤销报错，DB 原子条件兜底竞态。
  锚点：token.ex:13,170-198,300。
- **token 绑用户、不绑工作区**：`user_id` 归属；`workspace_id` 是每次调用的参数，不在 token 语义内（例外工具见下文工具面）。
- 吊销指引：token 建议以设备命名（如 `my-macbook`），旧设备不再使用时在平台网站 MCP 页吊销对应 token。

## 确认流机制（two-tool 模式，D8/D-D3）

高风险写工具走两段确认，**无 confirm 不落业务库**：

1. 工具 `execute/2` 先调 `Confirmation.request(actor, tool_name, params, summary)`：建 `PendingOperation`（params 经 `Redact.call` 脱敏落库）→ 返回 `needs_confirmation` + `{pending_id, summary}`（不落业务库）。
2. agent 在客户端对话内把摘要展示给用户、征得明确同意 → 调 `confirm_operation(pending_id)` → `Confirmation.confirm/2` 校验 pending 归属/状态/有效期 → 标记 confirmed → 按 `pending.tool` 经 `Wrapper.executor_for/1`（派生自组件注册表，无第二注册点）分派到对应工具的 `execute_confirmed/2` 真正落库。
3. 用户拒绝 → 调 `cancel_operation(pending_id)`（`Confirmation.cancel/2`）终结 pending，不留悬挂。

- **确认发生在 agent 客户端对话内，平台无独立的网站前端确认步骤。**
- `needs_confirmation` 响应只含 `pending_id` 与 `summary`（**无截止时间字段**）。
- **pending TTL 默认 600s**：`@default_ttl_seconds 600`，读时派生 expired（`expires_at < now`）；部署级可经 `config :cgc_2046, :mcp_confirmation_ttl_seconds` 覆盖。CI 核对平台 `config/*.exs`（及 `rel/env*`，若存在）无与默认值 600 不一致的 override；插件侧 `confirmation_ttl_seconds` 设置默认同为 600，须与平台部署值保持一致。
  锚点：`backend/lib/cgc_2046/mcp/pending_operation.ex:18,101`；confirmation.ex:31,60,81,145-150。
- 状态机：`pending → confirmed | cancelled`，`expired` 为读时派生（不落列）。
- pending 过期后：向用户说明并重新发起原工具调用（产生新 pending_id），不得复用旧 id。

## 工具面（68 工具）

锚点：`backend/lib/cgc_2046/mcp/server.ex:77-170` 的 `component(...)` 注册区（人读行号）；核对集按注册区分组冻结。工具集 = 运行时 `tools/list` 全量——平台新增工具后 agent 无需插件发版即可发现；本表用于契约核对与能力分类，不作运行时枚举依据。

| 分组（server.ex 注册区注释） | 工具 |
|---|---|
| 工作台/工作流基础（6） | `get_workspace_context` `list_members` `get_workflow` `get_step_output` `save_step_output` `create_invitation` |
| 成员管理（3） | `list_join_requests` `approve_join_request` `assign_roles` |
| 内置确认/取消（2） | `confirm_operation` `cancel_operation` |
| 课程内容（2） | `get_course_content` `save_course_content` |
| 公开浏览（2，membership: :public 豁免族） | `list_public_offerings` `get_public_offering` |
| 角色工作台基座（3） | `list_my_workspaces` `get_role_playbook` `list_my_tasks` |
| 平台治理（11，platform_admin 门控族） | `admin_list_users` `admin_list_workspaces` `admin_list_workspace_applications` `admin_list_audit_logs` `admin_list_reconciliation_findings` `admin_approve_workspace_application` `admin_reject_workspace_application` `admin_create_workspace` `admin_reassign_workspace_owner` `admin_promote_user` `admin_demote_user` |
| 工作台 Owner/Admin 管理面（20） | `create_course` `list_workspace_courses` `update_course` `launch_course` `close_course` `cancel_course` `create_event` `list_workspace_events` `update_event` `launch_event` `close_event` `cancel_event` `list_enrollments` `confirm_enrollment` `reject_enrollment` `waive_payment` `list_workspace_orders` `refund_order` `retry_refund` `update_join_policy` |
| 课程教研流程（9） | `get_prep_status` `assign_prep_tutor` `claim_prep_authoring` `update_prep_policy` `submit_prep_for_check` `submit_prep_quality_report` `override_prep_gate` `approve_prep` `request_changes_prep` |
| 课程版本读（1） | `get_course_revision` |
| 学员旅程（5） | `discover_offerings` `get_enrollment_summary` `create_enrollment` `get_my_enrollments` `get_order_status` |
| 学习循环 v2（4） | `start_learning_run` `submit_learning_attempt` `get_learning_state` `get_course_learning_analytics` |

**确认流工具集合（26 个）**——核对锚 = `backend/lib/cgc_2046/mcp/tools/*.ex` 中导出 `execute_confirmed/2` 的文件集（亦均调 `Confirmation.request/4`）：

`admin_approve_workspace_application` `admin_create_workspace` `admin_demote_user` `admin_promote_user` `admin_reassign_workspace_owner` `admin_reject_workspace_application` `approve_join_request` `approve_prep` `assign_roles` `cancel_course` `cancel_event` `close_course` `close_event` `confirm_enrollment` `create_invitation` `launch_course` `launch_event` `override_prep_gate` `refund_order` `reject_enrollment` `retry_refund` `update_course` `update_event` `update_join_policy` `update_prep_policy` `waive_payment`

**直接写工具集合（12 个，不经确认流）**：`assign_prep_tutor` `claim_prep_authoring` `create_course` `create_enrollment` `create_event` `request_changes_prep` `save_course_content` `save_step_output` `start_learning_run` `submit_learning_attempt` `submit_prep_for_check` `submit_prep_quality_report`。DSH 硬门纪律（R6）：直接写工具不挂本地硬门；早门名单 = 上述 26 确认流集合（核对集推导，CI 三方核对）；兜底锚门 = `confirm_operation` 单工具，天然跟随平台确认流集合不漂移。

**workspace_id 参数纪律**：除 `confirm_operation` / `cancel_operation` 与注册区标注 `workspace_id: :optional` 的工具（`list_my_workspaces`、`get_role_playbook`、`discover_offerings`、`get_enrollment_summary`、`get_my_enrollments`、`get_order_status` 等跨台/公开面，以各工具 schema 为准）外，所有工具都需要 `workspace_id`（Wrapper D12 必填校验 + membership 鉴权 + ToolCallLog 审计）。是否必填一律以运行时各工具 inputSchema 为准，不作全称命题。

## 归因约定（KTD1）

- 插件 initialize 握手固定上报 `clientInfo.name = "dsh"`（dsh-cgc-core `engine.ts` `CLIENT_IDENTITY`）。
- 平台把 `frame.context.client_info.name` 记入 `ToolCallLog.client_name`（`backend/lib/cgc_2046/mcp/wrapper.ex` `client_name/1`），供平台侧按宿主归因审计。

## 静态存储边界（RSK7）

- 连接 token 在 DSH 侧落 `~/.dsh/settings.yaml`（0600，明文）——宿主 `role('secret')` 只护 wire（日志/事件脱敏），**不护静态存储**；本机任何能读该文件的进程即持 token。
- token 生命周期暴露面（wizard 一次性明文 → 系统剪贴板 → 面板表单 → settings.yaml）为继承宿主/平台模型的残余风险；低成本加固（表单提交后清空、`type=password`、`autocomplete=off`、wizard 指引粘贴后清空剪贴板）在面板与网站侧条款承载。

## 插件家族侧保留

- 工具命名空间 `mcp__cgc-2046__<rawName>` 由 dsh-cgc-core 独占保留：平台 `tools/list` 全量原样桥接，不改名、不增删；家族其它插件不得注册该命名空间。
- 凭据存储：DSH settings 的 `dsh-cgc-core` namespace（`mcp_url` / `plain_token` / `web_url`），仅存本机 profile，不落对话、不落日志。
- 错误归一化：401/403 → `CGC_MCP_AUTH`（停止重连、面板 surface）；超时 → `CGC_MCP_TIMEOUT`；其余连接失败 → `CGC_MCP_CONNECTION`；业务失败（`isError: true`）→ `CGC_MCP_BUSINESS`（留在对话内，不进活动列表）。
- 日志与事件文本过 redact：先做当前 token 字面值精确替换，再跑形状正则——`cgc_` + 43 base64url token、Bearer 头值、裸 JWT、平台敏感 key 名单（token/password/secret/authorization 等，exact + `_xxx` snake 后缀 + `Xxx` camelCase 尾）。

## 机器可读核对集

以下 fenced block 由 `scripts/check-contract.mjs` 解析（`#` 起为注释）：

- `tool <name>`：平台 68 组件集合（锚 server.ex `component(Cgc2046.Mcp.Tools.*)` 注册区，模块名 Macro.underscore 即工具名）。
- `gate <name>`：26 确认流集合（锚 `mcp/tools/*.ex` 的 `def execute_confirmed(` 命中文件集）；三方相等比较的另一腿是 `packages/dsh-cgc-core/src/protocol.ts` 的早门名单常量 **`CGC_CONFIRMATION_TOOLS`**（plan U4 落地；缺席时脚本报明确错误而非静默通过）。
- `grep <path> <literal>`：`<path>`（相对平台 repo 根）必须含 `<literal>` 原文。

```contract-checklist
# --- 68 组件集合（server.ex 注册区，按分组注释排序） ---
tool get_workspace_context
tool list_members
tool get_workflow
tool get_step_output
tool save_step_output
tool create_invitation
tool list_join_requests
tool approve_join_request
tool assign_roles
tool confirm_operation
tool cancel_operation
tool get_course_content
tool save_course_content
tool list_public_offerings
tool get_public_offering
tool list_my_workspaces
tool get_role_playbook
tool list_my_tasks
tool admin_list_users
tool admin_list_workspaces
tool admin_list_workspace_applications
tool admin_list_audit_logs
tool admin_list_reconciliation_findings
tool admin_approve_workspace_application
tool admin_reject_workspace_application
tool admin_create_workspace
tool admin_reassign_workspace_owner
tool admin_promote_user
tool admin_demote_user
tool create_course
tool list_workspace_courses
tool update_course
tool launch_course
tool close_course
tool cancel_course
tool create_event
tool list_workspace_events
tool update_event
tool launch_event
tool close_event
tool cancel_event
tool list_enrollments
tool confirm_enrollment
tool reject_enrollment
tool waive_payment
tool list_workspace_orders
tool refund_order
tool retry_refund
tool update_join_policy
tool get_prep_status
tool assign_prep_tutor
tool claim_prep_authoring
tool update_prep_policy
tool submit_prep_for_check
tool submit_prep_quality_report
tool override_prep_gate
tool approve_prep
tool request_changes_prep
tool get_course_revision
tool discover_offerings
tool get_enrollment_summary
tool create_enrollment
tool get_my_enrollments
tool get_order_status
tool start_learning_run
tool submit_learning_attempt
tool get_learning_state
tool get_course_learning_analytics
# --- 26 确认流集合（execute_confirmed/2 命中集 = 早门名单） ---
gate admin_approve_workspace_application
gate admin_create_workspace
gate admin_demote_user
gate admin_promote_user
gate admin_reassign_workspace_owner
gate admin_reject_workspace_application
gate approve_join_request
gate approve_prep
gate assign_roles
gate cancel_course
gate cancel_event
gate close_course
gate close_event
gate confirm_enrollment
gate create_invitation
gate launch_course
gate launch_event
gate override_prep_gate
gate refund_order
gate reject_enrollment
gate retry_refund
gate update_course
gate update_event
gate update_join_policy
gate update_prep_policy
gate waive_payment
# --- 端点与传输 ---
grep backend/lib/cgc_2046_web/router.ex scope "/mcp" do
grep backend/lib/cgc_2046_web/router.ex plug(Cgc2046Web.Plugs.McpProtocolCompatPlug)
grep backend/lib/cgc_2046_web/router.ex plug(Cgc2046Web.Plugs.McpAuthPlug)
grep backend/lib/cgc_2046_web/router.ex Anubis.Server.Transport.StreamableHTTP.Plug
grep backend/lib/cgc_2046/mcp/server.ex name: "cgc-2046"
grep backend/lib/cgc_2046/mcp/server.ex capabilities: [:tools]
# --- 协议版本兼容 shim ---
grep backend/lib/cgc_2046_web/plugs/mcp_protocol_compat_plug.ex @legacy_version "2024-11-05"
grep backend/lib/cgc_2046_web/plugs/mcp_protocol_compat_plug.ex delete_req_header(conn, "mcp-protocol-version")
# --- 401/429 形状与节流参数 ---
grep backend/lib/cgc_2046_web/plugs/mcp_auth_plug.ex send_resp(401, ~s({"error":"invalid_token"}))
grep backend/lib/cgc_2046_web/plugs/mcp_auth_plug.ex Bearer realm="cgc-2046-mcp"
grep backend/lib/cgc_2046_web/plugs/mcp_auth_plug.ex send_resp(429, ~s({"error":"rate_limited"}))
grep backend/lib/cgc_2046_web/plugs/mcp_auth_plug.ex put_resp_header("retry-after"
grep backend/lib/cgc_2046_web/plugs/mcp_auth_plug.ex @throttle_window_seconds 900
grep backend/lib/cgc_2046_web/plugs/mcp_auth_plug.ex Keyword.get(:max_attempts, 20)
# --- token 语义与生成格式 ---
grep backend/lib/cgc_2046/mcp/token.ex "cgc_" <> (:crypto.strong_rand_bytes(32) |> Base.url_encode64(padding: false))
grep backend/lib/cgc_2046/mcp/token.ex :crypto.hash(:sha256, token)
grep backend/lib/cgc_2046/mcp/token.ex identity(:unique_token_hash, [:token_hash])
grep backend/lib/cgc_2046/mcp/token.ex Ash.Changeset.put_context(:plain_token, token)
grep backend/lib/cgc_2046/mcp/token.ex @idle_expiry_days 90
grep backend/lib/cgc_2046/mcp/token.ex @max_active_tokens_per_user 10
# --- 确认流机制与 pending TTL ---
grep backend/lib/cgc_2046/mcp/confirmation.ex def request(actor, tool_name, params, summary) do
grep backend/lib/cgc_2046/mcp/confirmation.ex def confirm(actor, pending_id) do
grep backend/lib/cgc_2046/mcp/confirmation.ex def cancel(actor, pending_id) do
grep backend/lib/cgc_2046/mcp/confirmation.ex Wrapper.executor_for(tool_name)
grep backend/lib/cgc_2046/mcp/pending_operation.ex @default_ttl_seconds 600
grep backend/lib/cgc_2046/mcp/pending_operation.ex Application.get_env(:cgc_2046, :mcp_confirmation_ttl_seconds,
```
