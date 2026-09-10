---
name: cgc-core-onboarding
description: Use when helping a user connect DSH to the CGC-2046 platform for the first time or after a failure — prefer the CDP auto-connect path (drive a logged-in debuggable browser to mint and pipe the token, zero manual copy), fall back to the clipboard-pipe command, then the CGC panel form. Verifies the connected status before reporting done. Also covers failure recovery, the per-schema workspace_id discipline, and the two-tool confirmation flow once connected.
---

# CGC-2046 连接引导

帮用户把 DSH 连上 CGC-2046 平台。**默认由你（agent）执行连接命令**——用户只需在网站上创建 token 并复制到剪贴板，其余一条管道命令完成；面板手动粘贴只是备选。**token 永不进入对话、工具参数或日志**：不要让用户把 token 贴在对话里，不要替用户打开 settings.yaml，不要把 token 写进任何工具调用或文件，命令输出不回显 token。

## 1. 判断当前状态

- 「CGC」面板的连接状态区会显示 已连接 / 未连接 / 连接错误，以及已配置的 MCP URL。
- 也可以直接查状态路由：`curl -s http://127.0.0.1:3080/api/dsh-cgc-core/status`（端口以 DSH 启动 banner 的 web 地址为准，默认 3080），看 `configured` / `connected` / `activity`。
- 用户也可以在平台网站 MCP 页确认 token 是否仍然有效。
## 2. 首次连接（或断开后的重连）

按优先级选路，**首选全自动**：

1. **CDP 自动连接（首选，用户零复制）**：探测本机可调试浏览器（OpenClacky daemon / Chrome DevToolsActivePort），接管后自动打开平台 MCP 页、签发 `dsh-auto-<日期>` token、经剪贴板管道写入 connect、轮询验证。机械细节与排障读 [references/cdp-auto-connect.md](references/cdp-auto-connect.md)。没有可用 CDP 端点时，可向用户提议启动一个 DSH 专用浏览器 profile（登录一次，以后都自动），或直接落第 2 条。
2. **剪贴板管道（次选，用户只复制一次）**：引导用户在平台 MCP 页创建 token 并**复制到剪贴板**（建议设备命名，如 `my-macbook`，便于日后吊销），然后你执行管道命令完成连接——token 走 stdin，不进 argv、不回显：

   macOS：
   ```bash
   pbpaste | python3 -c "
   import json, sys, urllib.request
   token = sys.stdin.read().strip()
   if not token.startswith('cgc_'): raise SystemExit('剪贴板里不是 CGC token，未写入任何东西——请回 MCP 页重新复制')
   req = urllib.request.Request('http://127.0.0.1:3080/api/dsh-cgc-core/connect',
       data=json.dumps({'token': token}).encode(),
       headers={'Content-Type': 'application/json'}, method='POST')
   print(urllib.request.urlopen(req).read().decode())
   "
   ```
   Linux 把 `pbpaste` 换成 `xclip -selection clipboard -o`（或 `xsel -b`）；端口非默认时替换 URL。

   - 只需发 `token` 字段：MCP URL 有默认值（本地开发 `http://localhost:4000/mcp`），partial 更新不会动已存 URL。需要改 URL 时在 JSON 里加 `'url'` 字段一起发。页面与端点不同源的环境（生产 `api.codingirlsclub.com`、本地前后端分离）还要带上 `'web_url'`（站点源：生产 `https://codingirlsclub.com`、本地 `http://localhost:3000`），否则面板里的「打开网站 / 吊销 token」链接会指向 API 源。
   - connect 是 fence-only 写路由：本机 loopback、无 `Origin` 头的调用直接放行，**不需要先取 CSRF token**（与 OpenClacky 扩展不同，不要照搬它的文档去取不存在的字段）。
   - 响应里的 `status` 投影永不包含 token；`token_configured:true` 即写入成功。
3. **面板手动粘贴（兜底）**：用户打开 DSH 侧边栏的「CGC」面板，在连接表单填入 MCP URL 和 token 点「连接」——与上面等价，适合不愿用剪贴板/浏览器的用户。

**验证后才报告完成**（三条路径通用）：引擎异步重连，connect 返回时 `connected` 可能还是 `false`——轮询 `GET /status`（约 5 秒内）至 `connected:true`，或确认「CGC」面板状态区显示「已连接」、`mcp__cgc-2046__*` 工具可用。亲眼确认后再报告完成；状态未变或出现错误就按第 3 节诊断，不要提前宣布成功。

## 3. 失败分支

- **认证失败（401/403，凭证无效或已吊销）**：不要反复重试。`activity` 里会出现 `CGC_MCP_AUTH` 条目且引擎已停止重连。让用户回平台 MCP 页检查 token 状态；若已吊销，重新创建 token 后重跑第 2 节的管道（或在面板改存）。旧设备不再使用时，顺手引导用户在平台侧吊销对应 token。
- **连接错误（网络 / URL / 服务不可达）**：确认平台网站已启动、URL 拼写正确（本地开发是 `http://localhost:4000/mcp`）；修好后重新执行连接。
- **管道命令本身失败**（无 python3、剪贴板工具缺失等）：回退到第 2 节的手动备选项，引导用户在面板表单粘贴。
- **业务 / 超时错误**：平台侧问题，让用户稍后在面板看最近活动记录重试。

## 4. 连接后的使用纪律

- 平台工具集以连接时 tools/list 返回的全量清单为准；参数要求以各工具自身 schema 为准——多数业务工具的 schema 要求 `workspace_id` 等作用域参数，用户没给就问一句，不要编造。
- 高风险写操作走平台的两段确认流：这类工具首次调用返回 `needs_confirmation` + `pending_id` + 摘要。把摘要原样转述给用户、征得明确同意 → 调 `confirm_operation`（带 `pending_id`）；用户取消则调 `cancel_operation`。确认发生在对话内，平台没有网站前端确认步骤；pending 默认约 10 分钟过期（平台可配），过期后向用户说明并重新发起原工具调用。
- 邀请类操作走两步：先创建拿链接，再把链接发给用户，由用户自行转发。不要替平台外发邀请。
- token 是凭证：永不进入对话、工具参数或日志——不展示、不回显、不写入任何文件；用户要管理 token 时，引导去面板表单或平台 MCP 页。
