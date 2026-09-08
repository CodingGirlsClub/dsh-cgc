# dsh-cgc

CGC-2046 平台的 DSH（DeepSeek Harness）插件家族：让 DSH 成为与 OpenClacky 平级的一等 BYO agent 通道。

## 包

| 包 | 说明 |
| --- | --- |
| [`dsh-cgc-core`](packages/dsh-cgc-core/README.md) | 核心连接器：MCP 桥（`mcp__cgc-2046__*` 工具）、连接状态面板、`/api/dsh-cgc-core` 路由族、onboarding skill、错误 hook、系统提示公告。 |
| [`dsh-cgc-roles`](packages/dsh-cgc-roles/README.md) | 角色薄壳预设：cgc-assistant / cgc-tutor / cgc-admin（KTD6 物化到 `<dshHome>/.agent-presets/`）。 |
| [`dsh-cgc-panels`](packages/dsh-cgc-panels/README.md) | 面板家族：学习视图 / 课程学习 / 发现 / 教研视图 / 教研编辑 / 管理视图（消费 core 的数据路由与事件通道）。 |
| [`dsh-cgc-all`](packages/dsh-cgc-all/README.md) | 聚合包：一个 profile-bundles 行拉入以上全部成员。 |

## 安装

```bash
# 一键安装整个家族（推荐）
dsh plugin --profile web add dsh-cgc-all

# 或只装单个成员
dsh plugin --profile web add dsh-cgc-core
```

聚合包走 profile-bundles 系统：`dsh-cgc-all` 把三个成员包声明为依赖（npm 安装时去重为**唯一一份** `dsh-cgc-core` 实例），其 `cordis.patch.yml` 依次 insert 每个成员的插件行。CLI 会自动把 `dsh-cgc-all` 注册进 profile 的 `dsh.profile.bundles`。

## 更新

```bash
dsh plugin --profile web update dsh-cgc-all
```

## 卸载

```bash
dsh plugin --profile web remove dsh-cgc-all
```

成员插件随聚合包的依赖一起移除；卸载时各成员自行清理物化产物（角色预设目录、skills 等）。

## 发布（维护者）

发布只由 GitHub Actions 的 [release 工作流](.github/workflows/release.yml) 执行，本地不发布。

### 授权模型

1. **打 tag**：在默认分支（`main`）上打 `v*` tag 并推送（`main` 受分支保护，build-test 与 contract-drift 两个检查必须通过才能合入）。工作流会先校验被 tag 的提交是 `origin/main` 的祖先，拒绝侧支发布。
2. **环境门禁**：发布 job 运行在 GitHub environment `npm-release` 中，该环境配置了 required reviewers——每次发布都必须经指定评审人手动批准。**仅合入 main 不会触发任何发布**。
3. **npm provenance**：job 以 `id-token: write` 运行，`pnpm -r publish --provenance` 为每个包生成 Sigstore 签名的 provenance 声明；四个包的 `repository.url` 均指向本仓库，npm 会校验声明与仓库元数据一致。
4. **发布顺序**：`pnpm -r publish` 按 workspace 拓扑序发布——`dsh-cgc-core` → `dsh-cgc-roles` / `dsh-cgc-panels` → `dsh-cgc-all`，聚合包永远最后。

### 一次性 npm 侧设置（首次发布前必做）

四个包尚未在 npm 注册（registry 无 `dsh-cgc-*`），首次发布需要一次人工设置，二选一：

- **方案 A（先 token，后 link）**：在仓库 secrets 中设置 `NPM_TOKEN`（npm granular access token，对四个 `dsh-cgc-*` 包有 publish 权限），完成首次发布；随后在 npm 网站为每个包配置 trusted publisher（包 Settings → Trusted Publisher → GitHub Actions，repository = `CodingGirlsClub/dsh-cgc`，workflow = `release.yml`，environment = `npm-release`）。四个包全部 link 后可移除 `NPM_TOKEN`，改走纯 OIDC trusted publishing。
- **方案 B（先 link，零 token）**：npm 支持为尚未存在的包预创建 trusted publisher 时，直接按上面的参数为四个包逐一 link，无需 `NPM_TOKEN`。

无论哪种方案，都需要先在 GitHub 仓库 Settings → Environments 创建 `npm-release` 环境并添加 required reviewers，否则发布 job 不会等待人工批准。

### 首次发布步骤

1. 确认上述一次性设置完成。
2. `git tag v0.1.0 main && git push origin v0.1.0`。
3. 在 Actions 的 release 运行中批准 `npm-release` 环境门禁。
4. 验证（见下）。

### 发布后验证

```bash
npm view dsh-cgc-all          # version、repository、license 元数据
npm view dsh-cgc-core dist.attestations 2>/dev/null || true
```

- npm 包页面应显示 provenance 徽章（"Built and signed on GitHub Actions"），链接回本仓库与对应 Actions 运行。
- `npm view <pkg> repository.url` 指向 `CodingGirlsClub/dsh-cgc`。
- 实际安装验证：`dsh plugin --profile web add dsh-cgc-all` 后，profile 的 `cordis.patch.yml` dump 中应出现全部四个插件行。

## 开发

```bash
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm -r test
```

跨仓库契约（token 语义、MCP URL、工具清单）见 [CONTRACT.md](CONTRACT.md)；parity 计划见 [docs/plans](docs/plans)。

## License

AGPL-3.0-only
