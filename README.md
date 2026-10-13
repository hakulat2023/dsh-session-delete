# dsh-session-delete

English | [中文](README.zh.md)

[![test](https://github.com/hakulat2023/dsh-session-delete/actions/workflows/test.yml/badge.svg)](https://github.com/hakulat2023/dsh-session-delete/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/topic-dsh--plugin-0b7285)](https://github.com/topics/dsh-plugin)

Session **deletion** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

DeepSeek Harness can archive a Session, but archiving only hides it — there is no way to get rid of
one. This plugin adds that missing verb: **Delete session** in the Session row's “…” menu, a
`remote.sessionDelete` host namespace, and the `session_delete` / `session_restore` agent tools.

Deletion is deliberately **recoverable**: the Session's durable log is moved into a local trash
directory, so a mistake costs a `mv`, not a conversation.

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Install](#install)
- [Use](#use)
- [Configuration](#configuration)
- [Semantics and limits](#semantics-and-limits)
- [Development](#development)
- [Verified behaviour](#verified-behaviour)
- [License](#license)

## What it does

One deletion performs four steps:

1. **Admission.** The Session is asked the same questions archiving asks, through the
   `workspace/session-activity` waterfall. Live work is refused unless the caller allows a stop;
   when it is, `workspace/session-stop` cancels the turn and the plugin waits (bounded) for the
   Session to go idle. A Session still resident in the host process is refused *before any side
   effect* and only deleted after a second, explicit confirmation.
2. **Trash the log.** The Session's own directory is handed to the **platform's own trash** — the
   Finder's Trash on macOS, the XDG trash on Linux, the Recycle Bin on Windows — as
   `<sessionId>-<timestamp>`, carrying a `trash.json` record with the title, `cwd`, original
   directory, byte/file counts, and deletion time. `purge: true` deletes it outright instead.
   A small record is also written under `$DSH_HOME/session-delete/entries/` (entry path plus original
   directory, **no Session content**), because macOS refuses to let a process *enumerate* `~/.Trash`
   (TCC): without it a trashed Session could not be found again. See
   [docs/architecture.md](docs/architecture.md).
3. **Drop the registrations.** The Session is detached from every Workspace account
   (`sessionIds`), removed from the registry-global archive and pin sets, and its projection-cache
   record is deleted.
4. **Tell the UI.** `api-session/removed` is emitted, so every connected browser drops the row
   immediately.

The Session directory is located through the persistence backend's own `locate(header)` when it
offers one, so a backend that changes its on-disk layout does not need a plugin update; otherwise the
plugin falls back to the documented `sessions/<projectKey(cwd)>/<encodeSegment(id)>` layout.

## Requirements

| | |
|---|---|
| DeepSeek Harness | `0.2.x` (developed and verified against `0.2.0-rc.2`) |
| Node.js | `>= 20` |
| Surface | any profile that mounts the Session store, the JSONL persistence backend, the Workspace registry, and the Web client (`dsh-web-app` / desktop) |

The plugin has **no npm dependencies** and **no build step**: the browser half is a hand-written
module in the `window.__ModuleLoader__.load({ id, factory })` shape the Web client already consumes,
and the host half imports nothing outside `node:*`. See
[docs/plugin-packaging.md](docs/plugin-packaging.md) for why that matters for third-party plugins.

## Install

The package is a DSH **bundle**: `package.json` declares `dsh.bundle.patch` and `dsh.client`, and
`cordis.patch.yml` inserts the host row.

```bash
# from a local checkout (this repository)
plugin_manager install_bundle   target: /absolute/path/to/dsh-session-delete

# or from GitHub, by tag, with the bundled CLI
dsh plugin --profile desktop add github:hakulat2023/dsh-session-delete#v0.1.0

# or from the registry, once published
dsh plugin --profile desktop add dsh-session-delete
```

The bundle patch that gets mounted is one row:

```yaml
- insert:
    - id: session-delete
      name: dsh-session-delete
```

After installing, **restart the application once**. The host half is a Node ESM module and the
running process keeps the module generation it already loaded (DSH's own limitation: a replaced
package needs a restart to load fresh JavaScript). The browser half is served from disk and only
needs a page reload.

## Use

### Web UI

Session row → **“…”** → **Delete session** → confirm.

- A **running** Session is stopped first: the first confirmation already carries that intent.
- A Session that is still **resident** in the host (typically the one you have open) is described as
  such and needs a second confirmation; the first click has no side effect at all.
- On success the row disappears everywhere and a toast reports the outcome **and the trash directory**
  (a Session whose log was already gone is reported as such, never as a move).

### Agent tools

| Tool | Arguments | Effect |
|---|---|---|
| `session_delete` | `session_id` (required), `stop_activity` (default `true`), `force` (default `false`), `purge` (default `false`) | Moves the Session to the trash; `purge: true` deletes the bytes permanently instead. |
| `session_restore` | `session_id` (required) | Moves a trashed Session directory back to its original location. |

### Remote namespace

`remote.sessionDelete.delete({ sessionId, stopActivity?, force?, purge? })` and
`remote.sessionDelete.restore({ sessionId })` — the same operations the UI dialog uses.

### Restoring by hand

A trashed Session is an ordinary directory in the platform's trash:

| Platform | Where it went | Notes |
|---|---|---|
| macOS | `~/.Trash/<sessionId>-<timestamp>/` | Finder shows it; “Put Back” is not offered (Finder did not move it), but `session_restore` works |
| Linux | `$XDG_DATA_HOME/Trash/files/…` with its `.trashinfo` | the desktop's own “Restore” works as well |
| Windows | the Recycle Bin | the plugin cannot read the bin back, so restore it by hand |

```bash
cat ~/.Trash/<sessionId>-*/trash.json      # originalDirectory, title, cwd, sizes
```

`session_restore(session_id)` puts it back and withdraws both records; the Session reappears in the
list once the Workspace registry next indexes stored headers (a reload, or the next launch).

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `trash` | `"system"` | Destination: `"system"` uses the platform's own trash, `"directory"` uses `trashRoot`, and any other string is taken as an absolute directory. |
| `trashRoot` | `$DSH_HOME/session-trash` | The directory used by `trash: directory` (and by `trashRoot` alone, for 0.1 compatibility). |
| `restoreIndexRoot` | `$DSH_HOME/session-delete` | Where the restore records live (`entries/<entry name>.json`). Metadata only — never Session content. |

```yaml
# keep the platform trash (the default): nothing to configure
- id: session-delete
  name: dsh-session-delete

# or own the destination, e.g. on a machine whose ~/.Trash is undesirable
- id: session-delete
  name: dsh-session-delete
  config:
    trash: directory
    trashRoot: /Volumes/big/dsh-session-trash
```

## Semantics and limits

- **Your trash, your decision.** Deleted Sessions land in the platform's trash and stay there until
  *you* empty it; the plugin never empties it, and it leaves no trash directory of its own behind.
- **macOS will not let a process list `~/.Trash`.** Moving in, reading a known entry, and moving it
  back out all work; `readdir` is refused by TCC. That is the only reason a restore record exists —
  `session_restore` follows the record instead of searching the trash. Emptying the trash makes the
  record stale, and a stale record is pruned rather than reported as a failure.
- **Windows restore is manual.** The Recycle Bin has no consumer-facing API for finding an entry
  again, so `session_delete` reports `trashedTo: null` and `session_restore` explains that the folder
  has to be restored from the Recycle Bin. A platform without a reachable system trash logs a warning
  and falls back to `trash: directory`.
- **A resident Session cannot be disposed by a third party.** The Session store owns its write
  handles and exposes no delete verb, so deleting a Session that a live Agent still holds would break
  that Agent's appends. The plugin refuses instead, and only proceeds on an explicit `force` (the log
  is gone; the in-memory copy becomes unusable).
- **Stopping is bounded.** The wait for running work to settle has a budget (15 s) and honours the
  call's `AbortSignal`; if the work outlives it, the call fails with `session/delete-active` and
  nothing is moved.
- **An unusable destination fails loudly.** If the trash refuses the directory, the deletion fails
  with `session/delete-failed` and the log is left exactly as it was — the provenance record written
  for the attempt is withdrawn.
- **Only the Session directory is touched.** Attachments and spills are content-addressed global
  storage and are not collected, so they may leave orphaned blobs.
- **The search index needs no cleaning.** The session query index in the shipped composition is
  in-memory and drops vanished Sessions on its own.
- **Subagent Sessions are Sessions too.** They can be deleted with the same tool; the UI shows the
  removal through the same event.

Failure codes surfaced by the Remote namespace: `session/not-found`, `session/delete-live`,
`session/delete-active`, `session/delete-failed`, `session/restore-missing`,
`session/restore-conflict`.

## Development

```bash
node test/verify.mjs      # or: npm test
```

The self-test needs no DSH runtime, no network, and no dependencies: it builds a temporary session
root, drives the real trash logic through a fake host adapter, mounts the real plugin body against a
fake Cordis context, and checks the pieces that are easy to get wrong —

- the Typert manifest's shape *and* the strict codecs' boundary validation;
- the Gateway's fallback (“SRC”) discovery contract: Remote markers on the prototype plus
  signature-derived parameter names;
- trash, restore, purge, missing-directory, forced, refused, and aborted paths;
- the platform backends: `~/.Trash` naming, the XDG `files`/`info` pair and its `.trashinfo`, and the
  PowerShell recycle command;
- restore on a trash that refuses to be listed (macOS), stale records, and an unusable destination
  that must not half-delete a log;
- that every tool result is lossless plain JSON (the host rejects anything else);
- re-application in one page: the real browser bundle, applied twice against a locale registry that
  throws on duplicates (once with a teardown, once without) must not fail or duplicate anything;
- a second mount of the host row, which must keep the first service instead of throwing.

Layout:

| Path | Role |
|---|---|
| `lib/session-trash.js` | Admission, cleanup and restore over an injected host adapter (unit-testable) |
| `lib/trash.js` | Platform trash backends: macOS `~/.Trash`, the XDG trash, the Recycle Bin, or a directory |
| `lib/restore-index.js` | The metadata record that makes restore work on a trash that cannot be listed |
| `lib/index.js` | Host plugin: the `sessionDelete` service, its Typert binding, and the two agent tools |
| `lib/typert.host.js` | Hand-written Typert manifest (strict codecs; registered by `typert-loader`) |
| `lib/client.js` | Browser half: menu row, confirmation dialog, `remote.sessionDelete` calls |
| `cordis.patch.yml` | Bundle patch: inserts the host row |
| `test/verify.mjs` | The self-test above |
| `docs/` | [Architecture](docs/architecture.md) and [packaging](docs/plugin-packaging.md) notes |

## Verified behaviour

| What | Evidence |
|---|---|
| Real macOS trash | a directory renamed into the real `~/.Trash`, read back by path, then renamed out — `readdir('~/.Trash')` refused throughout (TCC), which is exactly what the restore record covers |
| Delete, in the packaged app | macOS / desktop / DSH `0.2.0-rc.2`, after a restart so the host half really was 0.2.0: a disposable Session's 13,241-byte log landed in `~/.Trash/<id>-<timestamp>/` with its `trash.json` (`backend: "macos-trash"`, title recorded) and a restore record; the original directory, its projection-cache record, and its `workspace.json` account were gone |
| Restore, in the packaged app | `session_restore` put the log back and withdrew both records — the directory then held only `session.lock` and the log |
| Purge, in the packaged app | `session_delete(purge: true)` reported `deleted permanently` and left nothing in the trash |
| Client | the Session menu's occupants include `session-delete` (order 500, active) — once, after the 0.1.1 reload-safety fix |
| Self-test | 32 checks (`node test/verify.mjs`): the platform backends, an unlistable trash covered only by the restore record, stale records, an unusable destination that must not half-delete a log, the Typert manifest and SRC discovery, lossless-JSON tool results, browser-side re-application |
| CI | Node 20/22/24 × Ubuntu/macOS/Windows |

## Community plugin

DeepSeek Harness [does not accept external pull requests](https://github.com/deepseek-ai/deepseek-harness/blob/master/CONTRIBUTING.md)
at this stage, and explicitly invites plugins to live in their own repositories. This repository
therefore carries the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic so it can be
discovered; issues and pull requests against *this* plugin are welcome here.

## License

[MIT](LICENSE) © 2026 hakulat2023
