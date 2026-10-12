# dsh-session-delete

[English](README.md) | 中文

[![test](https://github.com/hakulat2023/dsh-session-delete/actions/workflows/test.yml/badge.svg)](https://github.com/hakulat2023/dsh-session-delete/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/topic-dsh--plugin-0b7285)](https://github.com/topics/dsh-plugin)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 补上**会话删除**。

DSH 只能「存档」——存档只是隐藏,并没有办法真正摆脱一个会话。这个插件补上这个缺失的动作:
会话行 “…” 菜单里的 **删除会话**、宿主命名空间 `remote.sessionDelete`,以及
`session_delete` / `session_restore` 两个 Agent 工具。

删除刻意做成**可恢复**的:会话日志被移动到本机回收站目录,误删的代价是一条 `mv`,而不是一段对话。

- [功能](#功能)
- [要求](#要求)
- [安装](#安装)
- [使用](#使用)
- [配置](#配置)
- [语义与边界](#语义与边界)
- [开发](#开发)
- [已验证的行为](#已验证的行为)
- [License](#license)

## 功能

一次删除做四件事:

1. **准入检查。** 用存档同一套 `workspace/session-activity` 瀑布询问该会话的状态。正在运行的
   工作在没有停止授权时会被拒绝;授权后由 `workspace/session-stop` 取消该回合,插件在预算内等待
   会话空闲。仍驻留在宿主进程内存中的会话会在**任何副作用之前**被拒绝,只有再次显式确认才会删除。
2. **移动日志。** 把会话自己的目录移动(同一文件系统内是原子 `rename`,跨设备退化为复制+删除)
   到 `$DSH_HOME/session-trash/<sessionId>-<时间戳>/`,并在同级写入 `trash.json`:会话 id、标题、
   `cwd`、原始目录、字节数、文件数、删除时间。
3. **清理登记。** 从每个工作区的 `sessionIds` 账户中摘除该会话,清掉全局存档集合与置顶集合中的
   条目,并删除投影缓存记录。
4. **通知界面。** 发出 `api-session/removed`,所有已连接的浏览器立即移除该行。

会话目录优先通过持久化后端自己的 `locate(header)` 定位,后端换布局时插件无需跟着改;没有
`locate` 时回退到文档化的 `sessions/<projectKey(cwd)>/<encodeSegment(id)>` 布局。

## 要求

| | |
|---|---|
| DeepSeek Harness | `0.2.x`(针对 `0.2.0-rc.2` 开发与验证) |
| Node.js | `>= 20` |
| 表面 | 任何挂载了会话存储、JSONL 持久化后端、工作区注册表与 Web 客户端的 profile(`dsh-web-app` / 桌面版) |

插件**没有任何 npm 依赖**、**没有构建步骤**:浏览器半边是按 Web 客户端本就消费的
`window.__ModuleLoader__.load({ id, factory })` 形状手写的模块,宿主半边除了 `node:*` 不导入任何东西。
原因见 [docs/plugin-packaging.md](docs/plugin-packaging.md)。

## 安装

这个包是一个 DSH **bundle**:`package.json` 声明 `dsh.bundle.patch` 与 `dsh.client`,
`cordis.patch.yml` 插入宿主行。

```bash
# 本地目录
plugin_manager install_bundle   target: /absolute/path/to/dsh-session-delete

# 或从 GitHub 按 tag 安装(自带 CLI)
dsh plugin --profile desktop add github:hakulat2023/dsh-session-delete#v0.1.0

# 或发布到 registry 之后
dsh plugin --profile desktop add dsh-session-delete
```

被挂载的 bundle 补丁只有一行:

```yaml
- insert:
    - id: session-delete
      name: dsh-session-delete
```

安装后请**重启一次应用**。宿主半边是 Node ESM 模块,运行中的进程保留它已经加载的模块代
(DSH 自身的限制:被替换的包需要重启才能加载新的 JavaScript);浏览器半边从磁盘读取,只需刷新页面。

## 使用

### 界面

会话行 → **“…”** → **删除会话** → 确认。

- **运行中**的会话会先被停止:首次确认就已经是这个意图。
- 仍然**驻留在内存中**(通常是你正打开的那个)的会话会被明确提示,需要第二次确认;第一次点击
  不产生任何副作用。
- 成功后该行在所有地方消失,并弹出提示。

### Agent 工具

| 工具 | 参数 | 作用 |
|---|---|---|
| `session_delete` | `session_id`(必填)、`stop_activity`(默认 `true`)、`force`(默认 `false`)、`purge`(默认 `false`) | 把会话移入回收站;`purge: true` 直接永久删除字节。 |
| `session_restore` | `session_id`(必填) | 把回收站里的会话目录放回原位。 |

### Remote 命名空间

`remote.sessionDelete.delete({ sessionId, stopActivity?, force?, purge? })` 与
`remote.sessionDelete.restore({ sessionId })` —— 界面弹窗用的就是这两个方法。

### 手动恢复

回收站里的会话就是一个普通目录:

```bash
cat ~/.dsh/session-trash/<sessionId>-*/trash.json      # originalDirectory、title、cwd、大小
mv ~/.dsh/session-trash/<sessionId>-*/  <originalDirectory>   # 或者用 session_restore
```

工作区注册表会在下一次组合时重新索引已存储的 header(重载应用,或下次启动),届时恢复的会话
会重新出现在列表里。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `trashRoot` | `$DSH_HOME/session-trash` | 会话目录被移动到的位置;不存在时按需创建。`DSH_HOME` 未设置时回退到持久化根目录的父目录。 |

```yaml
- id: session-delete
  name: dsh-session-delete
  config:
    trashRoot: /Volumes/big/dsh-session-trash
```

## 语义与边界

- **删除是移动,不是抹除。** 在 `purge` 之前,字节仍在 `trashRoot` 下;回收站不会自动清理。
- **驻留内存的会话无法被第三方释放。** 会话存储自己持有写句柄且没有删除动词,因此删除一个仍被
  存活 Agent 持有的会话会破坏该 Agent 的追加写入。插件选择拒绝,只有显式 `force` 才继续
  (日志消失,内存副本随之失效)。
- **停止是有预算的。** 等待运行中的工作结束的预算为 15 秒,并尊重调用的 `AbortSignal`;工作超出
  预算时以 `session/delete-active` 失败,且不会移动任何东西。
- **只动会话自己的目录。** 附件与 spill 是内容寻址的全局存储,不做回收,可能留下孤儿文件。
- **搜索索引无需清理。** 当前组合里的会话查询索引是内存索引,会自动丢弃消失的会话。
- **Subagent 会话也是会话。** 可以用同一个工具删除,界面通过同一个事件移除它。

Remote 命名空间会暴露这些失败码:`session/not-found`、`session/delete-live`、
`session/delete-active`、`session/delete-failed`、`session/restore-missing`、
`session/restore-conflict`。

## 开发

```bash
node test/verify.mjs      # 或 npm test
```

自测不需要 DSH 运行时、不需要网络、不需要任何依赖:它搭一个临时会话根目录,用假的宿主适配器
驱动真实的回收站逻辑,用假的 Cordis context 挂载真实的插件主体,并检查最容易出错的地方——

- Typert 清单的形状**以及**严格编解码器的边界校验;
- Gateway 的兜底(「SRC」)发现契约:原型上的 Remote 标记 + 由方法签名推导的参数名;
- 回收站、恢复、永久删除、目录缺失、强制、拒绝、中断各分支;
- 每个工具返回值都是无损的纯 JSON(宿主会拒绝其它东西);
- 同一次页面内重复挂载:用真实的浏览器 bundle,对一个「重复注册即抛错」的 locale 注册表挂载两次
  (一次有 teardown、一次没有),必须既不报错也不重复注册;
- 宿主行被挂载两次时必须保留第一个服务,而不是抛错。

目录结构:

| 路径 | 作用 |
|---|---|
| `lib/session-trash.js` | 注入式宿主适配器之上的回收站语义(可单测) |
| `lib/index.js` | 宿主插件:`sessionDelete` 服务、它的 Typert 绑定、两个 Agent 工具 |
| `lib/typert.host.js` | 手写 Typert 清单(严格编解码;由 `typert-loader` 注册) |
| `lib/client.js` | 浏览器半边:菜单项、确认弹窗、`remote.sessionDelete` 调用 |
| `cordis.patch.yml` | bundle 补丁:插入宿主行 |
| `test/verify.mjs` | 上面的自测 |
| `docs/` | [架构](docs/architecture.md)与[打包](docs/plugin-packaging.md)笔记 |

## 已验证的行为

macOS 桌面版、DSH `0.2.0-rc.2`、profile `desktop`,针对为测试专门创建的一次性会话:

| 步骤 | 观察结果 |
|---|---|
| `session_delete` | 目录移动到 `~/.dsh/session-trash/<id>-<时间戳>/`,含 `trash.json`(`bytes: 13184`、`files: 2`、`move: "renamed"`);原目录消失;`session_projcache` 无记录;`workspace.json` 的 `sessionIds` 中不含该 id |
| `session_restore` | 日志回到原始目录 |
| `session_delete(purge: true)` | 回收站条目与日志都消失;零残留 |
| 客户端 | 槽位检查显示 `sidebar.workspaces.session.menu.item` 的占用者中含 `session-delete`(order 500, active) |

## 社区插件

DeepSeek Harness [目前不接受外部 PR](https://github.com/deepseek-ai/deepseek-harness/blob/master/CONTRIBUTING.md),
并明确鼓励插件放在各自的仓库里。因此本仓库带上
[`dsh-plugin`](https://github.com/topics/dsh-plugin) topic 以便被发现;针对**这个插件**的
issue 与 PR 欢迎提到本仓库。

## License

[MIT](LICENSE) © 2026 hakulat2023
