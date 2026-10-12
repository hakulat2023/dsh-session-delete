# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/hakulat2023/dsh-session-delete/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/hakulat2023/dsh-session-delete/releases/tag/v0.1.0
