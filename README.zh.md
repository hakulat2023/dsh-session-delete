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
2. **把日志交给系统回收站。** 会话自己的目录被交给**平台自带的回收站** —— macOS 的废纸篓、
   Linux 的 XDG trash、Windows 的回收站 —— 条目名为 `<sessionId>-<时间戳>`,目录内带一份
   `trash.json`(标题、`cwd`、原始目录、字节数、文件数、删除时间);`purge: true` 直接永久删除、
   不经过回收站。同时在 `$DSH_HOME/session-delete/entries/` 留一条小记录(条目路径 + 原始目录,
   **不含任何会话内容**),因为 macOS 不允许进程**枚举** `~/.Trash`(TCC):没有它,删掉的会话就
   再也找不回来。详见 [docs/architecture.md](docs/architecture.md)。
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
- 成功后该行在所有地方消失,提示里会给出**回收站目录**;日志本就不存在的会话会明确说明,而不会
  谎称已移动。

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

| 平台 | 位置 | 说明 |
|---|---|---|
| macOS | `~/.Trash/<sessionId>-<时间戳>/` | 访达里可见;不会出现"放回原处"(不是访达移的),但 `session_restore` 可用 |
| Linux | `$XDG_DATA_HOME/Trash/files/…` 及其 `.trashinfo` | 桌面环境的"还原"同样可用 |
| Windows | 回收站 | 插件读不回回收站,需要手动还原 |

```bash
cat ~/.Trash/<sessionId>-*/trash.json      # originalDirectory、title、cwd、大小
```

`session_restore(session_id)` 会把它放回原位并撤回两条记录;工作区注册表下一次索引已存储 header
时(重载应用,或下次启动),该会话会重新出现在列表里。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `trash` | `"system"` | 目的地:`"system"` 用平台自带回收站;`"directory"` 用 `trashRoot`;其它字符串按绝对路径当作目录。 |
| `trashRoot` | `$DSH_HOME/session-trash` | `trash: directory` 使用的目录(只写 `trashRoot` 时等价,兼容 0.1)。 |
| `restoreIndexRoot` | `$DSH_HOME/session-delete` | 恢复记录(`entries/<条目名>.json`)的位置;只存元数据,绝不含会话内容。 |

```yaml
# 默认就用系统回收站,无需配置
- id: session-delete
  name: dsh-session-delete

# 或者自己指定目的地(例如机器的 ~/.Trash 不合适时)
- id: session-delete
  name: dsh-session-delete
  config:
    trash: directory
    trashRoot: /Volumes/big/dsh-session-trash
```

## 语义与边界

- **回收站是你的,清空也由你决定。** 删除的会话进入平台回收站并一直留到你清空它;插件不会自动
  清理,也不会自建任何回收站目录。
- **macOS 不允许进程列举 `~/.Trash`。** 移入、按已知路径读取、再移出都可用,但 `readdir` 会被
  TCC 拒绝。这正是需要那条恢复记录的唯一原因:`session_restore` 沿记录直达条目,而不是搜索回收站。
  清空回收站会让记录过期,而过期记录会被静默剪除,不会变成假失败。
- **Windows 的恢复是手动的。** 回收站没有面向消费者的"按条目找回"API,所以 `session_delete` 会
  返回 `trashedTo: null`,`session_restore` 会明确提示去回收站手动还原。平台没有可用系统回收站时
  会记一条警告并退回到 `trash: directory`。
- **驻留内存的会话无法被第三方释放。** 会话存储自己持有写句柄且没有删除动词,因此删除一个仍被
  存活 Agent 持有的会话会破坏该 Agent 的追加写入。插件选择拒绝,只有显式 `force` 才继续
  (日志消失,内存副本随之失效)。
- **停止是有预算的。** 等待运行中的工作结束的预算为 15 秒,并尊重调用的 `AbortSignal`;工作超出
  预算时以 `session/delete-active` 失败,且不会移动任何东西。
- **目的地不可用就明确失败。** 回收站拒收时以 `session/delete-failed` 结束,日志原样保留 —— 为这
  次尝试写下的记录会被撤回。
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
- 各平台后端:`~/.Trash` 命名、XDG 的 `files`/`info` 与 `.trashinfo`、PowerShell 回收命令;
- 无法枚举的回收站上的恢复(依赖恢复记录)、过期记录、以及"目的地不可用也不能半删日志";
- 每个工具返回值都是无损的纯 JSON(宿主会拒绝其它东西);
- 同一次页面内重复挂载:用真实的浏览器 bundle,对一个「重复注册即抛错」的 locale 注册表挂载两次
  (一次有 teardown、一次没有),必须既不报错也不重复注册;
- 宿主行被挂载两次时必须保留第一个服务,而不是抛错。

目录结构:

| 路径 | 作用 |
|---|---|
| `lib/session-trash.js` | 注入式宿主适配器之上的准入、清理与恢复逻辑(可单测) |
| `lib/trash.js` | 平台回收站后端:macOS `~/.Trash`、XDG trash、Windows 回收站,或自建目录 |
| `lib/restore-index.js` | 让"无法枚举的回收站"仍可恢复的元数据记录 |
| `lib/index.js` | 宿主插件:`sessionDelete` 服务、它的 Typert 绑定、两个 Agent 工具 |
| `lib/typert.host.js` | 手写 Typert 清单(严格编解码;由 `typert-loader` 注册) |
| `lib/client.js` | 浏览器半边:菜单项、确认弹窗、`remote.sessionDelete` 调用 |
| `cordis.patch.yml` | bundle 补丁:插入宿主行 |
| `test/verify.mjs` | 上面的自测 |
| `docs/` | [架构](docs/architecture.md)与[打包](docs/plugin-packaging.md)笔记 |

## 已验证的行为

| 项目 | 证据 |
|---|---|
| 真实 macOS 回收站 | 把目录 rename 进真实 `~/.Trash`,按路径读回,再 rename 出去;全程 `readdir('~/.Trash')` 被拒(TCC)—— 这正是恢复记录要覆盖的场景 |
| 打包应用内的删除 | macOS / 桌面版 / DSH `0.2.0-rc.2`,重启后宿主半边确为 0.2.0:一次性会话 13,241 字节的日志落到 `~/.Trash/<id>-<时间戳>/`,带 `trash.json`(`backend: "macos-trash"`、标题已记录)与恢复记录;原目录、投影缓存记录、`workspace.json` 账户里的 id 均已消失 |
| 打包应用内的恢复 | `session_restore` 把日志放回原位并撤回两条记录,恢复后的目录只剩 `session.lock` 与日志 |
| 打包应用内的永久删除 | `session_delete(purge: true)` 返回 `deleted permanently`,回收站无残留 |
| 客户端 | 会话菜单占用者含 `session-delete`(order 500, active),且只有一个实例(0.1.1 的幂等挂载修复) |
| 自测 | 32 项(`node test/verify.mjs`):各平台后端、只能靠恢复记录的不可枚举回收站、过期记录、目的地不可用时不半删日志、Typert 清单与 SRC 兜底、无损 JSON 工具结果、浏览器半边重复挂载 |
| CI | Node 20/22/24 × Ubuntu/macOS/Windows |

## 社区插件

DeepSeek Harness [目前不接受外部 PR](https://github.com/deepseek-ai/deepseek-harness/blob/master/CONTRIBUTING.md),
并明确鼓励插件放在各自的仓库里。因此本仓库带上
[`dsh-plugin`](https://github.com/topics/dsh-plugin) topic 以便被发现;针对**这个插件**的
issue 与 PR 欢迎提到本仓库。

## License

[MIT](LICENSE) © 2026 hakulat2023
