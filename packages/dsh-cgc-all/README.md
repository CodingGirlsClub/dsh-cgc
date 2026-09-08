# dsh-cgc-all

dsh-cgc 插件家族聚合包：一个 profile-bundles 行拉入家族全部成员。

当前成员：

- [`dsh-cgc-core`](../dsh-cgc-core/README.md)——CGC-2046 平台连接器（MCP 桥 + 状态面板 + cgc-assistant 预设 + onboarding skill + 错误 hook + 系统提示公告）。

## 安装

```bash
dsh plugin --profile <profile> add /path/to/dsh-plugin/packages/dsh-cgc-all
```

聚合走 profile-bundles 系统：本包的 `cordis.patch.yml` 依次 insert 每个成员插件行，`dependencies` 保证成员包装入 profile 的 node_modules。
