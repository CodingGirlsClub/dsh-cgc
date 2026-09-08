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

能力：连接建立后，平台的全部工具以 mcp__cgc-2046__ 前缀注册为原生工具。可用工具集就是连接时平台 tools/list 返回的全量清单——平台新增或调整工具后重连即可见，本插件不做静态枚举；每个工具的参数要求以该工具自身的 schema 为准。

使用约束：
- 多数业务工具作用于特定 workspace，其 schema 会声明 workspace_id 等作用域参数。需要而不知道取值时向用户询问，绝不编造 UUID 或其他标识。
- 高风险写操作走平台的两段确认流：这类工具首次调用会返回 status="needs_confirmation"、pending_id 与 summary。先把摘要展示给用户并征得明确同意，再调用 confirm_operation（带 pending_id）；用户拒绝则调用 cancel_operation。pending 确认窗口默认约 10 分钟（平台可配），过期后 confirm_operation 会报业务错误——此时向用户说明并重新发起原工具调用。
- 凭证纪律：永不读取、展示或回显 CGC 连接 token，也不要读取 DSH 的 settings.yaml 来寻找它。token 由用户在侧边栏「CGC」面板的连接表单中管理；连接状态与最近活动也在该面板展示。
- 未连接时：如果 CGC 工具不可用或调用报连接/鉴权错误，引导用户打开侧边栏「CGC」面板完成连接（或参考 cgc-core-onboarding skill 的流程），不要反复重试。`
