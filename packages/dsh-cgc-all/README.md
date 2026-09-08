# dsh-cgc-all

dsh-cgc 插件家族聚合包：一个 profile-bundles 行拉入家族全部成员。

当前成员：

- [`dsh-cgc-core`](https://github.com/CodingGirlsClub/dsh-cgc/tree/main/packages/dsh-cgc-core)——CGC-2046 平台连接器（MCP 桥 + 状态面板 + onboarding skill + 错误 hook + 系统提示公告）。
- [`dsh-cgc-roles`](https://github.com/CodingGirlsClub/dsh-cgc/tree/main/packages/dsh-cgc-roles)——角色薄壳预设 cgc-assistant / cgc-tutor / cgc-admin（KTD6 物化）。
- [`dsh-cgc-panels`](https://github.com/CodingGirlsClub/dsh-cgc/tree/main/packages/dsh-cgc-panels)——面板家族（学习视图 / 课程学习 / 发现 / 教研视图 / 教研编辑 / 管理视图）。

## 安装

```bash
dsh plugin --profile <profile> add dsh-cgc-all
```

聚合走 profile-bundles 系统：本包的 `cordis.patch.yml` 依次 insert 每个成员插件行（带 double-mount 护栏，成员已以其他 id 挂载时本层自动退让），`dependencies` 保证成员包装入 profile 的 node_modules 且去重为唯一一份 `dsh-cgc-core` 实例。

注意：若此前单独装过成员包（如 `dsh plugin add dsh-cgc-core`），切换到聚合包前请把该成员从 `dsh.profile.bundles` 中移除——同 id 重复行会在 loader 处直接报错（护栏无法兜底同 id 冲突）。
