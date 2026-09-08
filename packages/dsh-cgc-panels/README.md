# dsh-cgc-panels

DSH 插件家族 `dsh-cgc` 的面板包:右侧停靠的 CGC 面板族(hub + 六个角色视图),消费 `dsh-cgc-core` 暴露的 `/api/dsh-cgc-core` 数据路由族与事件通道。本包自身**不注册任何路由、工具或 MCP 连接**——所有数据经 core 的白名单数据面(KTD5)与 WS/轮询事件通道(U7)到达浏览器。

## 七个面板面(Appendix B)

| 面 | 预设(AE4) | 主要路由消费 |
|---|---|---|
| hub(总览) | 始终可见 | `GET /status`、`POST|DELETE /connect`、`GET /activity` |
| 学习视图 | cgc-assistant | `GET /me/enrollments`、`GET /me/workspaces`、`GET /tasks` |
| 课程学习 | cgc-assistant | `GET /courses/:id/content`、`GET /learning_state` |
| 发现 | cgc-assistant | `GET /discover`、`GET /enrollment_summary`、`POST /enrollments`、`GET /order_status` |
| 教研视图 | cgc-tutor | `GET /workspace/courses`、`GET /workspace/events`、`GET /courses/:id/prep` |
| 教研编辑 | cgc-tutor | `GET /courses/:id/content|revision`、`POST /courses/:id/content`(409 冲突保留本地草稿,提供 reload-latest / force-submit 两个出口) |
| 管理视图 | cgc-admin | `GET /workspace/orders`、`GET /workspace/enrollments` |

所有面共享同一状态契约:Loading / NotConnected / Permission(403/401)/ Error(含 429 Retry-After)/ Empty / Ready。事件推送(WS 主通道 + `afterSeq` 轮询回退,gap → 全量重取)触发各面刷新。

## 安全纪律

- **CSRF 引导通道(KTD3/KTD5/RSK5)**:宿主半通过 `webServer.tapIndex` 把 core 家族单例(`familyCsrfBootstrapField`)的 csrfToken 注入 `window.__DSH_CGC_PANELS_BOOT__`;写请求头 `X-CGC-CSRF-Token` 由此而来。token 不出现在任何路由响应体、URL 或 DOM 中。
- **连接表单(RSK7)**:token 输入框 `type=password autocomplete=off`,连接成功后立即清空;401 内联 token-invalid 文案 + 平台重发链接;429 渲染 Retry-After 等待文案。
- **行点击注入(RSK4/AE5)**:行操作只把「固定动词 + 已校验 id(UUID/数字)」写入会话草稿框,平台自由文本永不进入 composer,且**永不自动提交**;无会话时点击为 no-op 并给出可见提示。
- **纯文本渲染**:所有平台负载以 React 文本节点渲染,无 markup/markdown 注入面。

## 宿主扩展点(RSK1 fail-fast)

激活时探测 `webServer.registerUpgrade`、`webServer.tapIndex`、`ctx.approval`(approval seam 形状对照 `@deepseek-ai/dsh-tools` 的 `approval.request(...)` 运行时调用);缺失即抛出命名最低 DSH 版本(`MIN_DSH_VERSION`)的错误。浏览器半另有 sidebar `footer.action` 槽位探针:启动 5s 内槽位未声明则在页面上显示命名最低版本的错误横幅。

## 可访问性基线

入口与每个标签/动作都是原生 `button`/`a`;面板打开时焦点移入(关闭按钮),Escape 关闭并把焦点还给入口触发器;通知经 `aria-live="polite"` 区域播报。

## 开发

```bash
pnpm --filter dsh-cgc-panels typecheck
pnpm --filter dsh-cgc-panels test      # vitest(jsdom)
pnpm --filter dsh-cgc-panels build     # tsc 类型 + tsdown(宿主 ESM + 浏览器 CJS 单文件)
```

依赖:`dsh-cgc-core`(workspace,仅类型与家族单例的运行时动态 import——永不打包进产物)。
