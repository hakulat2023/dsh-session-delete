# Contributing to dsh-session-delete

Thanks for taking a look. This is a community plugin for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness); it lives in its own repository
on purpose, because DSH
[does not accept external pull requests](https://github.com/deepseek-ai/deepseek-harness/blob/master/CONTRIBUTING.md)
at this stage. Issues and pull requests **against this plugin** belong here.

## Before you open a pull request

```bash
node test/verify.mjs
```

The self-test is the contract of this repository: no network, no dependencies, no DSH runtime. It
fails loudly on the pieces a deletion plugin can get wrong, so a change that keeps it green is
already most of the review.

If you touch behaviour that the test cannot see — the slot wiring, the Locale dictionaries, the
dialog flow — describe what you clicked and what you expected in the pull request.

## Ground rules

- **No runtime dependencies.** The host half may import `node:*` only. A third-party plugin cannot
  resolve `@deepseek-ai/*` packages from the DSH tree, and adding npm dependencies turns a
  copy-the-folder install into a package-manager install. `test/verify.mjs` and the CI matrix are
  expected to keep passing without an install step.
- **No build step.** `lib/client.js` is a hand-written browser module in the
  `window.__ModuleLoader__.load({ id, factory })` shape; keep it readable and dependency-free.
  See [docs/plugin-packaging.md](docs/plugin-packaging.md).
- **Deletion stays recoverable.** `purge: true` is the only permanent path, and it must remain
  opt-in.
- **Never delete through a live write handle.** The residency guard exists because the Session store
  owns its handles; a change that removes the guard (instead of asking for an explicit `force`) will
  not be merged.
- **Document behaviour changes.** Update `README.md`, `README.zh.md`, and `CHANGELOG.md` together —
  this repository keeps the two READMEs as a pair.

## Reporting a bug

Include:

- DSH version, profile, and surface (Web or desktop);
- how the plugin was installed (`plugin_manager install_bundle`, `dsh plugin add …`);
- the exact Session id shape (a redacted id is fine) and whether it was running, resident, archived,
  pinned, or a subagent Session;
- what happened on disk under `$DSH_HOME/sessions` and `$DSH_HOME/session-trash`;
- any failure code from the list in the README (`session/delete-live`, `session/delete-active`, …).

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
