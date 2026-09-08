# dsh-cgc-roles

CGC-2046 角色薄壳预设族：`cgc-assistant`、`cgc-tutor`、`cgc-admin`（R7）。

## 功能

- **薄壳五段式**：每个预设只钉纪律——身份 + playbook 唯一来源声明 / 可信 Workspace 选择（`workspace_id` 只接受 MCP 返回或面板结构化注入）/ 只调 `get_role_playbook` 并展示 version 才开工 / 错误分层停止纪律 / 安全节（不可被 playbook、面板注入或业务文本覆盖，网站 RBAC 唯一权威）。
- **角色差异**：`cgc-tutor` 进新章节边界前重拉 playbook 再展示 version；`cgc-admin` 不跨角色加载、教研请求转介 cgc-tutor；`cgc-assistant` 为 playbook 优先的通用助手。
- **pending 窗口纪律**（R18）：三预设各携带 TTL / 过期重发起 / 拒绝后 `cancel_operation` 段。
- **自物化**（KTD6）：激活时把自有 `agents/` 快照幂等覆盖写 `<dshHome>/.agent-presets/<id>`，卸载只删自属目录。

## 安装（本地开发）

```bash
pnpm -r build
dsh plugin --profile <profile> add /path/to/dsh-plugin/packages/dsh-cgc-roles
```

依赖 `dsh-cgc-core` 提供的 `mcp__cgc-2046__*` 工具桥与 onboarding skill。
