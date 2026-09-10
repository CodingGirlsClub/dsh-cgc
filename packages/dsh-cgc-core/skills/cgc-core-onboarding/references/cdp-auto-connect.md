# CDP 自动连接（首选路径的机械细节）

SKILL.md 第 2 节的首选路径：agent 通过 CDP 接管一个**带用户 CGC 登录态的可调试浏览器**，自动完成「打开 MCP 页 → 签发 token → 剪贴板管道写入 connect → 验证」。本文件是机械细节；安全纪律以 SKILL.md 为准。

## 1. 发现可用 CDP 端点（按序探测，命中即用）

1. **OpenClacky browser daemon**：`curl -s -m 2 http://127.0.0.1:7070/api/browser/status` 返回 `daemon_running:true` 时，它管理的 Chrome 就是目标（通常已登录 CGC）。ws 端点读 `~/Library/Application Support/Google/Chrome/DevToolsActivePort`（macOS）：第一行是端口，第二行拼出 `ws://127.0.0.1:<port>/devtools/browser/<id>`。
2. **用户日常 Chrome 直接带 CDP**：同上读 DevToolsActivePort；文件不存在即未开调试。
3. **都没有**：告诉用户「全自动需要一个带调试端口的浏览器」，给两个选择——(a) 由你启动一个 DSH 专用的 Chrome profile（`open -na "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir=$HOME/.dsh/cgc-browser`，用户在里面登录一次 CGC，以后都自动）；(b) 回退剪贴板路径。不要擅自重启用户正在用的浏览器。

## 2. CDP 直连纪律（Node ≥22，全局 WebSocket）

- `Target.attachToTarget` 必须带 `flatten: true`；之后所有页面级消息（`Runtime.evaluate`、`Page.navigate` 等）必须带 `sessionId`，否则报 `'Runtime.evaluate' wasn't found`。
- 每条 CDP 消息加超时保护（如 10s），避免 await 永久挂起。
- 脚本输出用文件重定向（`node script.mjs > /tmp/cgc-cdp.out 2>&1; cat /tmp/cgc-cdp.out`），不要用 `head` 管道——截断会误判为超时。
- 按钮点击优先 `el.click()`（`Runtime.evaluate` 内）；不行再 `Input.dispatchMouseEvent` 按 bounding rect 坐标点。
- **探测脚本永不打印 `document.body.innerText` / 页面全文**——token 一次性展示期间页面里有明文凭证，全文探测会把 token 泄进命令输出（实测发生过一次）。只返回结构化信号：布尔（有无 Copy 按钮）、元素标签、URL、标题。若不慎泄出：立即在页面上撤销该 token、重新签发、并向用户如实报告。

## 3. 页面流程（CGC 网站 MCP 页）

URL 形态：`<站点>/w/<slug>/settings/integrations/agents/mcp`（`<slug>` 是工作台 slug；不知道就先导航站点首页从界面进入，或问用户）。**注意网站页面与 MCP 端点可能不同源**：本地开发页面在 Next.js 前端（默认 `http://localhost:3000`），MCP 端点在 Phoenix 后端（默认 `http://localhost:4000/mcp`）；生产页面在 `https://codingirlsclub.com`，MCP 端点在 `https://api.codingirlsclub.com/mcp`——签发 token 去页面所在站点，connect 的 `url` 字段写 MCP 端点。不同源时 connect 还要带 `web_url` 字段（站点源：生产 `https://codingirlsclub.com`、本地 `http://localhost:3000`），面板的「打开网站 / 吊销 token」链接才指向可访问的页面站点。

1. `Target.createTarget {url}` 打开 MCP 页（或激活已有 tab）。
2. **登录态判定**：`Runtime.evaluate` 读 `location.href` / `document.title` / 是否有密码输入框。跳到登录页 → 告诉用户「请在刚打开的那个浏览器里登录 CGC，完成后告诉我」，绝不代填密码或验证码；用户确认后重新判定。
3. **清理旧自动 token**：只撤销名称以 `dsh-auto-` 开头的旧 token；**用户手动创建的 token 一律保留**。
4. **签发**：新建 token，名称 `dsh-auto-<YYYYMMDD>`（如 `dsh-auto-20260909`）。
5. **复制**：点击一次性 token 的「复制」按钮。**绝不读取、打印、转述明文**——token 只经剪贴板进入下一步管道。
6. **写入并验证**：执行 SKILL.md 第 2 节的剪贴板管道命令（本机 connect 是 fence-only，无需 CSRF 预取），然后轮询 `GET /api/dsh-cgc-core/status` 至 `connected:true`（约 5 秒）。
7. 任何一步失败：保留现场，向用户说明具体卡在哪、下一步是什么；不要改为要求用户手动配置，除非 CDP 路径确实全部不可用。

## 4. 回退顺序

CDP 端点探测失败 → attach/evaluate 全崩 → 用户拒绝启动专用浏览器 → 才落到 SKILL.md 的剪贴板路径（用户手动复制一次），最后是面板手动粘贴。
