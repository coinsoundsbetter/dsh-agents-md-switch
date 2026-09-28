# dsh-agents-md-switch

一个全局开关，只回答一个问题：**是否把工作区指令文件（`AGENTS.md` / `CLAUDE.md`）注入模型上下文？**

这是一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 bundle：宿主半体 + 客户端半体各一个文件，**不需要 DSH 源码构建**。English: [README.md](./README.md)。

## 它补的是哪个缺口

DSH 的工作区指令文件由 `@deepseek-ai/dsh-agent-instructions` 投递。那个插件**不走** `ctx.systemPrompt`：它在 `agent/pre-step` 瀑布里往本步的消息批次追加一条 `source.kind === 'agent-instructions'` 的用户消息，而且是**按 agent 预设**挂载的。

所以没有本插件时，关闭注入只有两条原生路径：

1. 在你在用的每个预设里删掉那一行；
2. 在 profile 补丁里把它的 `maxBytes` 设成 `0`。

两条都意味着长期维护一份预设副本，而且都不是干活时能随手拨的开关。

## 它做什么

本插件改为在**步边界**拦截。开关打开时，指令消息会从即将进入模型上下文的批次里被移除，同时指令插件停在 agent 收件箱里的待投递条目会被清掉，避免每一步都重新发现并读取文件。

| 性质 | 表现 |
| --- | --- |
| 与预设无关 | `standard` / `ptc` / `cordis` 以及任何自定义预设都服从同一个开关。 |
| 立即生效 | 从**当前会话的下一步**起生效，不需要重启，也不需要新开会话。 |
| 不破坏数据 | 不重写磁盘上的会话历史，也不删除你仓库里的任何文件。 |
| 与挂载顺序无关 | 监听器以 `{ prepend: true }` 注册，始终位于瀑布最外层，不受插件挂载顺序或热重载重注册影响。 |
| 默认关闭 | 开关默认关闭，注入保持开启；只有配置里出现显式的 `false`（即把开关打开）才拦截，因此缺失值或 schema 变化绝不会意外改变既有行为。 |

它**不是**：它不阻止指令插件继续发现并读取文件，也无法压制别的插件用自己的 source kind 注入的类似内容。开关打开后的含义是**不注入上下文**，不是**不读取**。

## 安装

在插件管理页：侧栏 **插件** → **添加插件** → 填入 `dsh-agents-md-switch`（裸包名、带版本号的包名、Git 地址、压缩包或本地绝对路径都可以）→ **安装** → **立即启用**。

在**自带 CLI 的构建**上，等价的命令是：

```bash
dsh plugin add dsh-agents-md-switch
```

安装源默认为 pnpm 自身指向的注册表；首次使用时宿主会并发探测 npm 官方源与国内镜像源，取最先响应的那个。声明的 DSH peer 范围会在 pnpm 运行**之前**检查，因此在不受支持的 DSH 版本上安装会直接失败，不会下载任何内容。

要求 DSH `0.1.7-rc.2` 或更新，Node `^22.19.0 || >=24.0.0`。

## 使用

两个界面入口，它们是同一个设置：

- **设置 → 通用** —— 一行「关闭 AGENTS.md 注入」。这一行本身就是开关，点一下即可。
- **设置 → 插件 → dsh-agents-md-switch → 行 → 配置** —— 本 bundle 自己的配置页；卡片上还有一行状态摘要。

写入由 DSH 的 config editor 持久化到你 profile 的 `cordis.patch.yml`，表现为 `inject-agents-md` 的 override 行，因此重启后依然有效，并对该 profile 下的所有会话生效。

## 兼容性与风险

本插件耦合了两个内部契约：`agent/pre-step` 瀑布，以及 `source.kind === 'agent-instructions'` 标记。它已在 DSH `0.1.7-rc.2` 上验证；`package.json` 声明了 `"@deepseek-ai/dsh-settings": ">=0.1.7-rc.2"`，因此在更旧的运行时上安装时，宿主自己的兼容性检查会给出告警。如果未来版本改名了事件或 source kind，开关会**静默失效**——升级 DSH 前请先看 `CHANGELOG.md` 里记录的已验证版本。

## 实现要点

如果你要写同类插件，这四点值得知道。每一点在这里都花掉了真实的调试时间。

1. **Config 字段必须 `.volatile()`。** `dsh-settings` 的 `volatileForm()` 只投影 volatile 字段；没标记就不产生 descriptor，而没有 descriptor 时设置界面里那一行**根本没有控件**。标记 volatile 还让写入变成原地更新配置、而不是重挂载插件，因此 `apply` 捕获的 `config` 对象在整个生命周期内保持有效。

2. **注入面（`inject` face）不是原样展开的。** `ctx.slots.register(options, Comp)` 的 `options.inject` 返回值会成为组件 props，但 `dsh-client-ui-renderer` 会先把 `hooks` 里的每一项**提到顶层**，把名字改写成 `use<首字母大写>` 并包装成 selector Hook。所以 `inject: () => ({ hooks: { agentsMd: form } })` 给到组件的是 `props.useAgentsMd`，**不存在** `props.hooks`。失败症状很阴：读错 prop 得到 `undefined`，点击时在 React 事件处理器里**同步抛错**，被 React 吞掉，界面永远停在「正在写入…」，而实际什么都没写。因此本插件的写入路径每一个出口都会变成可见文字——同步抛错、被拒绝、以及 12 秒超时。

3. **客户端半体是预构建产物。** `dsh-client-modules` 原样提供 `lib/client.js`，不做编译，所以该文件手写成懒加载 CJS 形态 `window.__ModuleLoader__.load({ id, factory })`。代价是不能用 JSX，组件用 `React.createElement`；好处是本仓库不需要打包器，`lib/client.js` 可直接发布。只依赖 `react` 与静态 UI 基座，两者外壳都已提供。

4. **写入不需要自建 RPC。** 「通用」那一行走 `ctx.configForms.get(ns)` 拿到的 `ConfigFormController`（`getSnapshot` / `subscribe` / `set`）；插件行用 owner 给的 `form` prop（`{ state, mutate }`）。两者最终都落到 `ctx.remote.settings.mutate`，由宿主的 config editor 持久化。两个入口都只在宿主确实提供该命名空间时才注册（`ctx.configForms.whileServed`）——一个点不动的控件比没有控件更糟。

## 开发

```bash
node scripts/check-release.mjs   # 发版前守卫：占位符、声明文件、locale 键一致性
DSH_AGENTS_MD_SWITCH_DEBUG=1 ... # 打开宿主侧 stderr 调试日志（默认关闭）
```

- 改 `lib/client.js` 只需要重新组合 bundle；客户端 bundle 的 revision 由文件元信息推导，HMR 会实时拾取。
- 改 `index.js` 或 `package.json` 需要重启宿主（或换新包名 + 新目录），因为 Node 的 ESM 缓存与客户端模块元信息在进程生命周期内被缓存。
- 宿主半体**刻意不写任何文件**。发布前请确保没有留下写日志的习惯。

## 发布

npm 不允许重复发布同一版本号，所以每次发版都要升版本。一条命令完成「预检 → 升 `package.json` → 发布」：

```bash
npm run release -- patch        # patch | minor | major | 或精确的 x.y.z
npm run release -- patch --dry-run   # 预演：只跑预检，不改动任何东西
git add -A && git commit -m "release: vX.Y.Z" && git tag vX.Y.Z && git push --follow-tags
```

发布前先把 `CHANGELOG.md` 定稿——`npm run release` 不会碰它，而它会随包一起发布，所以顶部仍写着 `Unreleased` 的段落会原样出现在 npm 包页上：

1. 把 `## [Unreleased]` 改名为 `## [x.y.z]`，并补上发布日期。
2. 把引用链接指向新 tag（`…/compare/v1.0.0...v1.1.0`）；若想继续累积，再加一行新的 `[Unreleased]: …/compare/v1.1.0...HEAD`。
3. 用能产出同一版本号的 bump 执行 `npm run release`——从 `1.0.0` 起，`minor` 得到 `1.1.0`。

`npm run release` **刻意不碰 git**：它用 `--no-git-tag-version` 只改 `package.json`，然后把 commit、tag、push 命令打印出来，由你自己执行。

如果账号的第二因子是安全密钥，CLI 无法应答 npm 的 OTP 挑战，发布就需要一枚**勾了 “bypass 2FA” 的 granular access token**（npmjs.com → Access Tokens → Generate New Token → Granular Access Token → *Read and write* → *Allow this token to bypass 2FA*）：

```bash
export NPM_TOKEN=npm_...        # PowerShell：$env:NPM_TOKEN = 'npm_...'
npm run release -- patch
```

令牌只从环境变量读取，**绝不写入** `package.json`、`.npmrc` 或本仓库；用完请到网页撤销。

`.github/workflows/publish.yml` 通过 npm trusted publishing（OIDC，无长期令牌）在 GitHub Release 时发布。trusted publisher 只需配置一次——包 → Settings → Trusted publishing → GitHub Actions → 本仓库，workflow 填 `publish.yml`，environment 留空——之后发版**既不需要令牌也不需要第二因子**。全新包仍需先用令牌手动发布一次，因为 trusted publisher 只能挂到已存在的包上；详见该 workflow 里的注释。

身份字段曾是占位符，在首次发布前用 `npm run fill-identity` 填过一次。

## 许可证

[MIT](./LICENSE)
