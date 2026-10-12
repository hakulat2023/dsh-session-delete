# Architecture: how a Session is deleted

DeepSeek Harness has no delete verb for Sessions, and that is not an oversight to route around: the
Session store owns the write handles of live Sessions, and `sessionPersistence` is an append-only
seam. This note records the public seams this plugin composes instead, so the next person can either
reuse them or argue with the design.

## Why not just remove the file?

The pieces that name a Session are spread across four owners:

| Owner | What it holds | How it reacts to a vanished log |
|---|---|---|
| `sessionPersistence` (JSONL) | the durable log and the write lease, under `<root>/<projectKey(cwd)>/<encodeSegment(id)>/` | `list()` stops returning it; a live write handle keeps appending to a file that no longer has a directory (the append opens the path directly, so it fails loudly) |
| `workspaceRegistry` | the ordered `sessionIds` account of every Workspace, plus the registry-global archive and pin sets | its `sessionIds` getter already filters ids whose header it cannot resolve, and it drops unknown ids on the next bootstrap |
| `sessionProjectionCache` | one durable record per Session under the `session_projcache` domain | nothing — the record is simply never read again |
| connected browsers | the row, projected from the session catalog | only via the `api-session/removed` event |

Deleting the directory alone therefore *looks* like it works until the list refreshes, leaves a stale
account entry behind, and can break a Session that is still live. The plugin does all four,
in the only order that cannot lose data.

## The four steps

### 1. Admission — the archive waterfall

The Workspace registry already models "is this Session busy?" for archiving, so the plugin asks the
same question through the same public waterfall instead of inventing a second liveness check:

```js
const activity = await ctx.waterfall("workspace/session-activity", { sessionId }, () => Promise.resolve([]));
if (activity.length > 0) {
  await ctx.parallel("workspace/session-stop", { sessionId });   // only when the caller allows a stop
  // then wait, with a budget, for activity to drain
}
```

`workspace/session-activity` is answered by the Agent that owns the Session (it reports a `turn`
while a turn is running, approvals and pending questions included), and `workspace/session-stop`
cancels that turn the same way the user's own stop button does. Two properties matter:

- **No side effect before consent.** A Session that is still resident in the host is refused *before*
  the stop is issued, so the first confirmation of a running Session changes nothing at all.
- **Bounded waiting.** The drain wait has a budget and honours the call's `AbortSignal`; if the work
  outlives it the call fails with `session/delete-active` and nothing has moved.

### 2. The move

```js
const located = ctx.sessionPersistence.locate?.(header);        // { kind: "jsonl", path }
const directory = path.dirname(located.path);
await fs.rename(directory, join(trashRoot, `${encodeSegment(id)}-${timestamp}`));
```

- `locate(header)` is the backend's own answer for where one Session lives, so a backend that
  changes its on-disk layout does not need a plugin update. When a backend does not offer it, the
  plugin reproduces the documented layout (the JSONL backend's lossy-but-readable `projectKey(cwd)`
  project directory plus the injective `encodeSegment(id)` session directory).
- `rename` is atomic on one filesystem and is the reason the trash lives beside the session root by
  default; across devices the plugin degrades to `fs.cp` + `fs.rm`.
- A `trash.json` next to the moved directory records the Session id, title, `cwd`, original
  directory, byte and file counts, the move kind, and the deletion time — the same facts
  `session_restore` and a human with `mv` need.

### 3. Dropping the registrations

```js
for (const workspace of ctx.workspaceRegistry.list()) await workspace.detachSession(sessionId);
await ctx.workspaceRegistry.unarchiveSession(sessionId);   // pure id removal: safe for stale ids
await ctx.workspaceRegistry.unpinSession(sessionId);
await ctx.sessionProjectionCache.table.delete(sessionId);
```

`detachSession` runs the registry's single write path for a Workspace record, so it is race-free
against concurrent attach/reorder writes. `unarchiveSession`/`unpinSession` deliberately skip the
existence check (removing an id can never introduce an unknown one), which is exactly what is needed
for a Session whose log is already gone.

### 4. The announcement

```js
ctx.emit("api-session/removed", sessionId);
```

`api-session/removed` is on the Remote event allowlist, so every connected browser drops the row
through the same code path the session controller uses when a Session is disposed. This is what makes
the UI correct without a reload — and it is also why the plugin can delete a Session that the client
still has open: the row disappears, and the only thing left pointing at the log is the in-memory
conversation the user is looking at.

## The residency guard

A Session that a live Agent still holds cannot be deleted safely: the Agent owns the persistence
write handle, and its next append targets a directory that no longer exists. The plugin has no
public way to dispose that Agent — the Session store's `enter()` returns a detach capability to the
*creator*, not to bystanders — so it refuses with `session/delete-live` and reports whether the
Session is running, what activity it reported, and that a `force` call would proceed anyway.

`force` is deliberately a second, explicit user decision (the dialog re-asks): by then the user has
been told that the in-memory copy becomes unusable. It is never a default, and never silent.

## Restore

`session_restore` reads the newest trash entry for the Session id, moves the directory back to the
`originalDirectory` recorded in `trash.json`, and refuses with `session/restore-conflict` if
something already occupies that path. The restored Session becomes *visible* on the next workspace
re-index — the registry caches headers for the life of the process, so the plugin documents a reload
rather than pretending it can re-index another plugin's state.

## What is intentionally left alone

- **Attachments and spills** are content-addressed global storage; collecting them would mean
  garbage-collecting blobs another Session may still reference. They may leave orphans.
- **The session query index.** The shipped composition mounts `session-query-sqlite` on `:memory:`,
  which derives itself from the persistence listing and drops vanished Sessions on its own. A
  persistent index would need its own story; the plugin does not guess.
- **`session.lock`.** It travels with the Session directory, so a restored Session keeps it; the
  JSONL backend treats a stale lock as recoverable.
