/**
 * dsh-cgc-panels surface copy: zh is the key source, en mirrors every key.
 * All human-readable strings in the panel family live here — components
 * never hard-code copy.
 */

export const zh = {
  // sidebar entry + shell
  'entry.label': 'CGC 面板',
  'entry.tooltip': 'CGC-2046 面板族（学习 / 教研 / 发现 / 管理）',
  'panel.title': 'CGC-2046 面板',
  'panel.close': '关闭',
  'panel.versionError': 'dsh-cgc-panels 需要 DSH >= {version}（宿主缺少 {missing}）。请升级 DSH 后重载。',
  // tabs
  'tabs.hub': '连接',
  'tabs.learning': '学习视图',
  'tabs.course': '课程学习',
  'tabs.discover': '发现',
  'tabs.tutor': '教研视图',
  'tabs.editor': '教研编辑',
  'tabs.admin': '管理视图',
  // shared state contract
  'state.loading': '加载中…',
  'state.notConnected': '未连接 CGC-2046。',
  'state.notConnectedHint': '请先在「连接」页完成连接。',
  'state.permission': '没有权限访问该数据（403）。',
  'state.tokenInvalid': '连接 token 无效或已吊销（401）。',
  'state.tokenReissue': '前往平台重新签发 token',
  'state.error': '错误：{message}',
  'state.retryAfter': '请求过于频繁，请等待 {seconds} 秒后重试。',
  'state.empty': '暂无数据。',
  'state.retry': '重试',
  // hub
  'status.connected': '已连接',
  'status.disconnected': '未连接',
  'status.notConfigured': '未配置',
  'status.url': 'MCP 地址',
  'status.web': '平台网站',
  'status.revoke': '在平台管理 / 吊销 token',
  'activity.title': '最近活动',
  'activity.empty': '暂无记录。',
  'activity.error.connect': '连接失败',
  'activity.error.tool': '工具调用失败',
  'activity.write': '写操作',
  // connect form
  'form.url': 'MCP URL',
  'form.urlHint': '本地开发默认为 http://localhost:4102/mcp',
  'form.token': '连接 token',
  'form.tokenHint': '在 CGC-2046 网站的 MCP 页面创建；建议用设备命名',
  'form.tokenStored': '已存 token，留空则保持不变',
  'form.connect': '连接',
  'form.connecting': '连接中…',
  'form.disconnect': '断开连接',
  'form.required': '请填写 MCP URL 与连接 token。',
  // workspace / course pickers
  'workspace.pick': '选择工作区',
  'course.pick': '选择课程',
  // row actions
  'action.send': '发送到会话',
  // injection notices (aria-live)
  'notice.injected': '指令已填入输入框，请核对后手动发送。',
  'notice.noSession': '请先打开一个会话再发送指令。',
  'notice.noComposer': '未找到会话输入框，注入未执行。',
  'notice.composerBusy': '会话输入框当前不可编辑，注入未执行。',
  'notice.invalidId': '该行缺少有效标识（UUID/数字），未生成指令。',
  // discover flow
  'discover.enroll': '报名',
  'discover.confirmTitle': '确认报名',
  'discover.confirm': '确认报名',
  'discover.cancel': '取消',
  'discover.enrolled': '报名成功。',
  'discover.paymentTitle': '待支付',
  'discover.paymentWaiting': '支付页已在新窗口打开；每 5 秒查询一次订单状态。',
  'discover.paymentOpen': '重新打开支付页',
  'discover.paymentDone': '支付完成。',
  'discover.paymentTimeout': '支付确认超时（已等待 10 分钟）。请重新打开本面板，并在平台网站手动刷新核实订单状态。',
  // editor
  'editor.content': '课程内容（JSON）',
  'editor.revision': '当前版本：{version}',
  'editor.save': '保存',
  'editor.saving': '保存中…',
  'editor.saved': '已保存。',
  'editor.invalidJson': '内容不是合法 JSON，未提交。',
  'editor.noCsrf': '缺少页面安全令牌（csrfToken），写入已禁用。请刷新页面，或确认 dsh-cgc-core 已激活。',
  'editor.conflictTitle': '版本冲突：课程内容已被他人更新（409）。本地草稿已保留。',
  'editor.conflictReload': '载入最新（放弃本地草稿）',
  'editor.conflictForce': '强制提交（以最新版本号覆盖）',
  'tutor.prep': '备课状态',
  'admin.offering': '选择课程 / 活动',
  // common
  'common.error': '错误：{message}',
  'common.refresh': '刷新',
}

export const en: Record<PanelsKey, string> = {
  'entry.label': 'CGC Panels',
  'entry.tooltip': 'CGC-2046 panel family (learning / tutoring / discover / admin)',
  'panel.title': 'CGC-2046 Panels',
  'panel.close': 'Close',
  'panel.versionError': 'dsh-cgc-panels requires DSH >= {version} (host lacks {missing}). Upgrade DSH and reload.',
  'tabs.hub': 'Connect',
  'tabs.learning': 'Learning',
  'tabs.course': 'Course',
  'tabs.discover': 'Discover',
  'tabs.tutor': 'Tutoring',
  'tabs.editor': 'Editor',
  'tabs.admin': 'Admin',
  'state.loading': 'Loading…',
  'state.notConnected': 'Not connected to CGC-2046.',
  'state.notConnectedHint': 'Connect first on the Connect tab.',
  'state.permission': 'No permission for this data (403).',
  'state.tokenInvalid': 'The connection token is invalid or revoked (401).',
  'state.tokenReissue': 'Re-issue a token on the platform',
  'state.error': 'Error: {message}',
  'state.retryAfter': 'Too many requests; retry in {seconds}s.',
  'state.empty': 'Nothing here yet.',
  'state.retry': 'Retry',
  'status.connected': 'Connected',
  'status.disconnected': 'Disconnected',
  'status.notConfigured': 'Not configured',
  'status.url': 'MCP endpoint',
  'status.web': 'Platform site',
  'status.revoke': 'Manage / revoke token on the platform',
  'activity.title': 'Recent activity',
  'activity.empty': 'Nothing yet.',
  'activity.error.connect': 'Connection failed',
  'activity.error.tool': 'Tool call failed',
  'activity.write': 'Write',
  'form.url': 'MCP URL',
  'form.urlHint': 'Local development defaults to http://localhost:4102/mcp',
  'form.token': 'Connection token',
  'form.tokenHint': 'Create one on the CGC-2046 site\'s MCP page; device names recommended',
  'form.tokenStored': 'A token is stored; leave empty to keep it',
  'form.connect': 'Connect',
  'form.connecting': 'Connecting…',
  'form.disconnect': 'Disconnect',
  'form.required': 'MCP URL and connection token are both required.',
  'workspace.pick': 'Choose a workspace',
  'course.pick': 'Choose a course',
  'action.send': 'Send to session',
  'notice.injected': 'Directive placed in the composer; review and send manually.',
  'notice.noSession': 'Open a session before sending directives.',
  'notice.noComposer': 'Composer not found; nothing was injected.',
  'notice.composerBusy': 'The composer is not editable right now; nothing was injected.',
  'notice.invalidId': 'The row has no valid identifier (UUID/number); no directive was built.',
  'discover.enroll': 'Enroll',
  'discover.confirmTitle': 'Confirm enrollment',
  'discover.confirm': 'Confirm enrollment',
  'discover.cancel': 'Cancel',
  'discover.enrolled': 'Enrolled.',
  'discover.paymentTitle': 'Payment pending',
  'discover.paymentWaiting': 'The checkout page opened in a new window; order status is polled every 5s.',
  'discover.paymentOpen': 'Reopen checkout page',
  'discover.paymentDone': 'Payment completed.',
  'discover.paymentTimeout': 'Payment confirmation timed out (10 minutes). Reopen this panel and refresh the order manually on the platform site.',
  'editor.content': 'Course content (JSON)',
  'editor.revision': 'Current revision: {version}',
  'editor.save': 'Save',
  'editor.saving': 'Saving…',
  'editor.saved': 'Saved.',
  'editor.invalidJson': 'Content is not valid JSON; not submitted.',
  'editor.noCsrf': 'The page security token (csrfToken) is missing; writes are disabled. Refresh the page, or make sure dsh-cgc-core is active.',
  'editor.conflictTitle': 'Version conflict: the course content was updated elsewhere (409). Your local draft is kept.',
  'editor.conflictReload': 'Reload latest (discard local draft)',
  'editor.conflictForce': 'Force submit (overwrite at latest revision)',
  'tutor.prep': 'Prep status',
  'admin.offering': 'Choose course / event',
  'common.error': 'Error: {message}',
  'common.refresh': 'Refresh',
}

/** Locale key union. */
export type PanelsKey = keyof typeof zh

/** Tiny interpolation: {name} -> value. */
export function t(dictionary: Record<string, string>, key: string, values?: Record<string, string | number>): string {
  let text = dictionary[key] ?? key
  if (values !== undefined) {
    for (const [name, value] of Object.entries(values)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}
