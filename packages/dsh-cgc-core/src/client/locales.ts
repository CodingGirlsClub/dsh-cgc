/**
 * dsh-cgc-core surface copy: zh is the key source, en mirrors every key.
 */

export const zh = {
  'entry.label': 'CGC',
  'entry.tooltip': 'CGC-2046 连接面板',
  'panel.title': 'CGC-2046 连接',
  // status
  'status.connected': '已连接',
  'status.disconnected': '未连接',
  'status.notConfigured': '未配置',
  'status.url': 'MCP 地址',
  'status.web': '平台网站',
  'status.revoke': '在平台管理 / 吊销 token',
  // connect form
  'form.url': 'MCP URL',
  'form.urlHint': '本地开发默认为 http://localhost:4102/mcp',
  'form.token': '连接 token',
  'form.tokenHint': '在 CGC-2046 网站的 MCP 页面创建；建议用设备命名',
  'form.tokenStored': '已存 token，留空则保持不变',
  'form.tokenRequiredOnUrlChange': '更换 URL 后需重新填写 token',
  'form.connect': '连接',
  'form.connecting': '连接中…',
  'form.disconnect': '断开连接',
  'form.required': '请填写 MCP URL 与连接 token。',
  // activity
  'activity.title': '最近活动',
  'activity.empty': '暂无记录。',
  'activity.error.connect': '连接失败',
  'activity.error.tool': '工具调用失败',
  'activity.write': '写操作',
  // common
  'common.error': '错误：{error}',
  'common.close': '关闭',
  'common.refresh': '刷新',
}

export const en: Record<CgcKey, string> = {
  'entry.label': 'CGC',
  'entry.tooltip': 'CGC-2046 connection panel',
  'panel.title': 'CGC-2046 Connection',
  // status
  'status.connected': 'Connected',
  'status.disconnected': 'Disconnected',
  'status.notConfigured': 'Not configured',
  'status.url': 'MCP endpoint',
  'status.web': 'Platform site',
  'status.revoke': 'Manage / revoke token on the platform',
  // connect form
  'form.url': 'MCP URL',
  'form.urlHint': 'Local development defaults to http://localhost:4102/mcp',
  'form.token': 'Connection token',
  'form.tokenHint': 'Create one on the CGC-2046 site\'s MCP page; device names recommended',
  'form.tokenStored': 'A token is stored; leave empty to keep it',
  'form.tokenRequiredOnUrlChange': 'Changing the URL requires re-entering the token',
  'form.connect': 'Connect',
  'form.connecting': 'Connecting…',
  'form.disconnect': 'Disconnect',
  'form.required': 'MCP URL and connection token are both required.',
  // activity
  'activity.title': 'Recent activity',
  'activity.empty': 'Nothing yet.',
  'activity.error.connect': 'Connection failed',
  'activity.error.tool': 'Tool call failed',
  'activity.write': 'Write',
  // common
  'common.error': 'Error: {error}',
  'common.close': 'Close',
  'common.refresh': 'Refresh',
}

/** Locale key union. */
export type CgcKey = keyof typeof zh

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
