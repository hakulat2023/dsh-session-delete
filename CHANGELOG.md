# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-12

### Changed

- **Deletion now uses the platform's own trash** instead of a directory this plugin invented:
  `~/.Trash` on macOS, the XDG trash (`$XDG_DATA_HOME/Trash`, `.trashinfo` included) on Linux, and
  the Recycle Bin on Windows. The Session is therefore where the user already knows to look, and
  emptying it stays the user's decision — the plugin never cleans its own trash or leaves one behind.
- `config.trash` selects the destination: absent or `"system"` (the default) uses the platform trash,
  `"directory"` uses `config.trashRoot` (or `$DSH_HOME/session-trash`), and any other string is taken
  as an explicit directory. `trashRoot` alone still means `"directory"`.
- `purge: true` now deletes the directory outright instead of moving it to the trash and removing it
  again.
- The provenance record (`trash.json`) is written **inside** the Session directory before it moves, so
  it travels with the entry — including into the Windows Recycle Bin, whose contents the plugin
  cannot read back.
- The deletion result and the agent tool now report `backend` (`system` / `directory`) and `detail`
  (`macos-trash` / `xdg-trash` / `recycle-bin` / `directory`), and `trashRoot` is `null` for a system
  trash.
- A **restore record** is written per deletion under `$DSH_HOME/session-delete/entries/`
  (`config.restoreIndexRoot`), holding the entry path and the original directory — no Session content.
  macOS refuses to let a process enumerate `~/.Trash` (TCC), so without it a trashed Session could not
  be found again; the backend's own listing stays a second candidate source where it is allowed.

### Fixed

- Restoring a Session also withdraws its provenance record, so a restored directory holds only what
  the session store expects.

### Added

- Platform trash backends with their own tests: macOS `~/.Trash` (Finder's ` 2` collision naming), the
  XDG trash spec (percent-encoded `Path`, `DeletionDate`, `files`/`info` pairs), and the Windows
  Recycle Bin through PowerShell.
- A test proving an unusable destination fails with `session/delete-failed` **without** half-deleting
  the log or leaving the provenance record behind.

## [0.1.1] - 2026-10-12

### Fixed

- The success toast now reports what actually happened: a real move names the trash directory to
  look in, and a Session whose log was already gone says so instead of claiming a move — which is how
  a deletion could look like it "did nothing" while the directory stayed empty.

## [0.1.0] - 2026-10-12

### Added

- **Delete session** row in the Session “…” menu (`sidebar.workspaces.session.menu.item`, order 500)
  with a confirmation dialog that reports running and resident Sessions before it acts.
- Host `sessionDelete` service behind the `remote.sessionDelete` namespace: `delete` and `restore`.
- Agent tools `session_delete` (`session_id`, `stop_activity`, `force`, `purge`) and
  `session_restore` (`session_id`).
- Trash semantics: the Session directory is moved to `$DSH_HOME/session-trash/<id>-<timestamp>/`
  with a `trash.json` record, and `purge: true` removes the bytes immediately instead.
- Workspace accounting, archive-set, pin-set, and projection-cache cleanup, plus an
  `api-session/removed` announcement so connected browsers drop the row.
- Hand-written Typert manifest with strict codecs, and a Gateway “SRC” fallback binding so the
  namespace keeps working if the manifest is never registered.
- Self-test (`node test/verify.mjs`) covering the trash paths, the manifest and codecs, the SRC
  discovery contract, and lossless-JSON tool results.

### Fixed

- The client half now owns every registration through its fiber, so a browser-side reload (HMR, or a
  Plugins enable/disable toggle) neither throws `locale namespace "session-delete" already has
  locale "en"` nor leaves duplicate slot rows or a stale Remote mount behind.
- Mounting the plugin row twice keeps the first `sessionDelete` service instead of failing on a
  duplicate `ctx.provide`.

[Unreleased]: https://github.com/hakulat2023/dsh-session-delete/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/hakulat2023/dsh-session-delete/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/hakulat2023/dsh-session-delete/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/hakulat2023/dsh-session-delete/releases/tag/v0.1.0
