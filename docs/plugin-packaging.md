# Packaging notes: a third-party DSH plugin with a Web UI

This is the practical part of building a plugin like this one: which files a bundle needs, how a
browser half is loaded, how to expose a Remote namespace without the generated toolchain, and what
biting constraints a package outside the DSH repository lives under.

Everything here was verified on DSH `0.2.0-rc.2` with the desktop profile.

## The four faces of the package

| Face | Declared by | Consumed by |
|---|---|---|
| Host plugin | `package.json` `main` + `exports["."]` | the Cordis Loader row the bundle patch inserts |
| Bundle patch | `dsh.bundle.patch: "./cordis.patch.yml"` | the profile composition |
| Browser half | `dsh.client.platform: "web"` + `exports["./client"]` | `dsh-client-modules`, which serves it to the page |
| Typert manifest | `exports["./typert"]` | `dsh-typert-loader`, which registers it into `ctx.typert` |

```json
{
  "exports": {
    ".": { "default": "./lib/index.js" },
    "./client": { "default": "./lib/client.js" },
    "./typert": { "default": "./lib/typert.host.js" }
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }
  }
}
```

`cordis.patch.yml` is one `insert` row naming the package:

```yaml
- insert:
    - id: session-delete
      name: dsh-session-delete
```

The row name must be the package name: that is how the Loader resolves the module from the profile's
`node_modules`, how `typert-loader` finds `package.json`, and how `client-modules` addresses the
browser module.

## The browser half

`dsh-client-modules` scans the **Loader entries** for packages declaring `dsh.client`, then serves
`exports["./client"]` to the page. The file must be a module-table registration, not a plain ES
module:

```js
window.__ModuleLoader__.load({
  id: "dsh-session-delete",            // must equal the package name
  factory: (require) => {
    const React = require("react");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    // ...
    exports.apply = apply;             // Cordis plugin body
    exports.inject = ["remote", "slots", "locale"];
    return module.exports;
  }
});
```

- `require` resolves only modules already in the table. `react` and the shared UI primitives are
  vendored into the Web frontend, so they are always available; anything else needs a row of its
  own, which is what `dsh.client.inject` / `dsh.client.external` declare. A third-party plugin
  should stay within `react` + primitives + `ctx.get(...)` services.
- **No build step is required.** A hand-written module in this shape is served as-is. The first-party
  packages use a bundler, but nothing in the loader demands one.
- Editing the browser half takes effect on the next page load. Editing the **host** half does not:
  the process keeps the module generation it already imported, so a plugin author restarts the app
  (DSH's own note: a replaced package needs a restart to load fresh JavaScript).

### Contributing to a slot

```js
slots.inject("sidebar.workspaces.session.menu.item", function* () {
  yield slots.register({
    name: "sidebar.workspaces.session.menu.item",
    id: "session-delete",     // your own id: a new cell beside the shipped rows
    order: 500,               // shipped rows use 100/200/300/400
    locale: NS                // the renderer injects `t` bound to this namespace
  }, DeleteSessionMenuItem);
});
```

`inject(key, callback)` runs the callback once the slot exists and owns its disposal; the generator
form yields the registrations. Locale dictionaries come from `ctx.locale.register(ns, { en, zh })`
and `t` reads them (with an `en` fallback chain).

Slot entries receive the owner's props (for a Session row: `sessionId`, `displayTitle`), the slot's
declared hooks (`useMenuOpenState`, `useShortcuts`), the entry's own `inject` values, and `t`. A
component that opens UI elsewhere registers into `shell.overlay`, which is where this plugin's
confirmation dialog lives.

## A Remote namespace without the generator

The first-party API packages ship machine-generated `lib/typert.host.js` (host descriptors) and a
generated client contribution. Both are hand-writable.

### Host

1. Provide a service value whose methods are the operations, and give it the two things the Gateway
   looks for:
   - a **visible `typertRemote` binding** — the object `bindTypertRemote()` produces
     (`{ service, serviceKey, namespace }`, where `service` is the service object itself). Without
     it every call fails `gateway/binding-invalid`.
   - the **Remote markers**, on the service's prototype
     (property name `@deepseek-ai/dsh-typert-protocol/remote-methods`), if you want the Gateway's
     descriptor-free fallback to work too.
2. Export a Typert manifest from `./typert` with a strict codec per parameter and for the result:

```js
{ mode: "strict", typeSymbol: "…#SessionDeleteRequest", create: () => ({ parse(value) { /* validate */ } }) }
```

The Gateway calls `create().parse(args[wire])` for every parameter, so the codec is the wire
boundary: reject unknown fields and wrong types there (a throw becomes `gateway/input-invalid`). The
result codec needs only `create` — omit `encode` to pass the handler's value through unchanged. All
of this is plain JavaScript: **no zod or schemastery import is needed**, which matters below.

Resolve the endpoint by `namespace/method`; the manifest's `model.services` section is documentation
the service catalog reads, and `typert-loader` validates its shape strictly (every member needs a
`kind` and a `signature`, every type a `declaration`).

### Client

```js
const unmount = await ctx.remote.$mount({ package: "dsh-session-delete", descriptors: [ /* … */ ] });
const service = ctx.get("remote.sessionDelete");
const result = await service.delete({ sessionId });   // { ok: true, value } | { ok: false, error }
```

`$mount` installs the namespace as a Cordis service named `remote.<namespace>`; methods return the
result envelope rather than throwing. The client descriptor's codecs must be *declared* strict but
are otherwise inert (`create: () => ({ parse: (value) => value })` is enough), while the wire field
names in `parameters[].wire` must match the host manifest's exactly.

### Two discovery modes, one fallback

The Gateway resolves an endpoint in one of two ways:

- **strict** — the manifest registered above;
- **SRC** — no manifest: it walks `ctx.reflect.props`, finds services with a `typertRemote` binding,
  reads the Remote markers from the service **prototype**, and derives the wire parameters from the
  method's source text. That is why this plugin defines its methods on a prototype and why the
  signatures use plain identifiers (`delete(request, signal)`) — destructuring, defaults, or a rest
  parameter make SRC discovery refuse the method.

Implementing both costs a dozen lines and removes a whole class of "works on my machine" failures —
for example when a plugin is hot-installed from a `file:` entry that the loader's package scan does
not see.

## Agent tools without `defineTool`

`defineTool` and its schema helpers live in `@deepseek-ai/dsh-tools`, which a third-party package
cannot import. Register the definition directly instead — the registry only requires the model-facing
fields plus a renderer:

```js
ctx.inject(["tools"], (toolCtx) => {
  toolCtx.tools.register({
    name: "session_delete",
    description: "…",
    parameters: { type: "object", additionalProperties: false, properties: { /* … */ }, required: ["session_id"] },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { /* … */ }, required: ["sessionId"] },
      render: (_args, value) => [{ type: "text", text: "…" }]
    },
    execute: async (args, exec) => { /* … */ }
  });
});
```

Two contracts to keep in mind:

- The parameter and output schemas must stay inside the supported JSON Schema subset
  (`type`/`oneOf`/`properties`/`required`/`additionalProperties`/`items`/`enum`/`const` plus
  annotations), with `required` as an array of names.
- **The returned value must be lossless plain JSON** — plain objects, arrays, strings, finite
  numbers, booleans, `null`. A `Promise`, class instance, `Map`, `undefined` property, or `-0`
  anywhere makes the call fail with `INVALID_TOOL_OUTPUT` *after* the tool body already ran. This
  plugin learned that the hard way with an `async` title lookup returned by mistake; the self-test
  now asserts plain-JSON results for both tools.

## Make re-application idempotent

The client module system replaces a row by tearing the old fiber down and then re-evaluating the
bundle, so **`apply()` runs again in the same page** — after an HMR reload, after a plugin is disabled
and re-enabled from the Plugins page, and after every module-graph change. Anything that registers
into a page-global registry must either be owned by the fiber or tolerate a surviving generation:

- **Locale.** `ctx.locale.register()` returns a disposer and owns nothing itself. Register through
  `ctx.effect(() => ctx.locale.register(ns, dicts), "…")`; a registration that is merely dropped makes
  the *next* mount throw
  `locale namespace "…" already has locale "en"` and takes the whole row down with it — no menu row,
  no dialog, only an error. A cheap probe (`ctx.locale.bind(ns)("some.key") !== "some.key"`) keeps a
  re-apply safe even while an earlier generation is still live.
- **Remote.** `ctx.remote.$mount()` refuses the same contribution twice. Hand its async unmount to
  `ctx.effect` verbatim (`ctx.effect(() => unmount, "…")`) so a teardown *awaits* it, and skip
  mounting when the namespace is already present (`ctx.get("remote.<namespace>")`).
- **Slots and tools.** Their registrations are already fiber-owned through the service that created
  them, but wrapping the injection in `ctx.effect` makes that ownership explicit instead of implicit.
- **Host services.** Cordis refuses a duplicate `ctx.provide(name, …)`, so guard it
  (`if (ctx.get(name) === undefined) ctx.provide(name, value)`) — two rows can mount the same package,
  for example an installed copy beside a hot-installed one.
- **Injected styles.** Tag them `data-plugin-css="<package>/<file>"`: the module system removes owned
  styles on replacement, and the tag is what lets it.

`test/verify.mjs` covers this contract: it loads the real browser bundle with a stub module table and
applies it twice against a locale registry that throws on duplicates — once with a teardown in
between, once without.

## Installing and iterating

```bash
plugin_manager install_bundle   target: /absolute/path/to/dsh-session-delete
```

The manager runs `pnpm add` in the profile, which links a local path as a `link:` dependency, appends
the package to `dsh.profile.bundles`, and re-applies the composition. Because the dependency is a
link, editing the checkout *is* editing the installed plugin; the host half needs an app restart and
the browser half a page reload to pick changes up.

For a published plugin, the same manager accepts a registry spec, a tarball, or a git address
(`github:owner/repo#tag`), which is how this repository is meant to be installed.
