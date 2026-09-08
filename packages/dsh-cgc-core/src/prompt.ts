/**
 * The system-prompt announcement (R6): tells every agent the plugin exists,
 * what it can do, and the disciplines it must keep — workspace_id hygiene,
 * the two-tool confirmation flow, and credential discipline.
 */

/** Order within the tool-guidance band (same band as dsh-ssh's 150). */
export const SECTION_ORDER = 150

/** Name of the announcement section in the assembled system prompt. */
export const CGC_ANNOUNCEMENT_NAME = 'plugin:dsh-cgc-core'

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const CGC_ANNOUNCEMENT = `本机已安装 dsh-cgc-core 插件（CGC-2046 平台连接器，DSH 的 CGC 通道）。用户提到「CGC-2046 / CGC 平台 / 工作坊 / 工作台 / 工作流 / 邀请成员」时即指本平台，请据此协作。

能力：连接建立后，平台工具以 mcp__cgc-2046__ 前缀注册为原生工具——get_workspace_context（读工作台上下文）、list_members（列成员）、get_workflow（读工作流运行）、get_step_output（读步骤产物）、save_step_output（写步骤产物）、create_invitation（创建邀请，两步确认）、confirm_operation / cancel_operation（确认/撤销待决操作）。

使用约束：
- 除 confirm_operation / cancel_operation 外，所有 CGC 工具都要求 workspace_id。不知道 workspace_id 时向用户询问，绝不编造 UUID。
- 邀请等管理操作走平台的两步确认流：调用 create_invitation 会返回 status="needs_confirmation"、pending_id 与 summary。先把摘要展示给用户并征得明确同意，再调用 confirm_operation（带 pending_id）；用户拒绝则调用 cancel_operation。pending 确认窗口为 10 分钟，过期后 confirm_operation 会报业务错误——此时重新调用 create_invitation 发起新确认。
- 凭证纪律：永不读取、展示或回显 CGC 连接 token，也不要读取 DSH 的 settings.yaml 来寻找它。token 由用户在侧边栏「CGC」面板的连接表单中管理；连接状态与最近活动也在该面板展示。
- 未连接时：如果 CGC 工具不可用或调用报连接/鉴权错误，引导用户打开侧边栏「CGC」面板完成连接（或参考 cgc-core-onboarding skill 的流程），不要反复重试。`
