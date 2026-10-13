/**
 * Self-test for dsh-session-delete.
 *
 * Runs without a DSH runtime: a temporary session root, a fake host adapter,
 * and a fake Cordis context exercise the real trash logic and the real plugin
 * body, so a wiring mistake fails here instead of inside the desktop profile.
 *
 *   node test/verify.mjs
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { apply, createHostAdapter } from "../lib/index.js";
import { TYPERT } from "../lib/typert.host.js";
import { createSessionTrash, encodeSegment, projectKey, sessionDeleteError } from "../lib/session-trash.js";
import { createDirectoryTrashBackend, createSystemTrashBackend, TRASH_RECORD } from "../lib/trash.js";
import { createRestoreIndex } from "../lib/restore-index.js";

/** The bundles the plugin hands its backends and its trash logic. */
const trashPath = { basename, dirname, join };

let failures = 0;
const test = async (label, run) => {
	try {
		await run();
		console.log(`  ok  ${label}`);
	} catch (error) {
		failures += 1;
		console.error(`FAIL  ${label}\n      ${String(error?.stack ?? error)}`);
	}
};

/** A session root shaped exactly like the JSONL backend's layout. */
async function fixture({ live = false, running = false, activity = [] } = {}) {
	const home = await mkdtemp(join(tmpdir(), "dsh-session-delete-"));
	const root = join(home, "sessions");
	const header = { version: 4, id: "session-fixture-1", createdAt: 1_700_000_000_000, cwd: join(home, "proj"), isSeeded: false, delegationDepth: 0 };
	const directory = join(root, projectKey(header.cwd), encodeSegment(header.id));
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "session.v4.jsonl.zstd"), "log-bytes", "utf8");
	await writeFile(join(directory, "session.lock"), "", "utf8");
	const trashRoot = join(home, "session-trash");
	const state = {
		activity: [...activity],
		stopped: false,
		detached: [],
		announced: [],
		removedCacheRecords: []
	};
	const workspace = {
		id: "ws-1",
		detachSession: async (sessionId) => {
			state.detached.push(sessionId);
		}
	};
	const persistence = {
		root,
		locate: (meta) => ({ kind: "jsonl", path: join(root, projectKey(meta.cwd), encodeSegment(meta.id), "session.v4.jsonl.zstd") }),
		list: async () => [{ header }]
	};
	const sessions = {
		get: (id) => (live && id === header.id ? { header } : undefined)
	};
	const agents = {
		get: (id) => (id === header.id && running ? { status: "running" } : undefined)
	};
	const registry = {
		list: () => [workspace],
		unarchiveSession: async () => {},
		unpinSession: async () => {}
	};
	const cache = {
		table: {
			delete: async (id) => {
				state.removedCacheRecords.push(id);
			}
		}
	};
	const projections = {
		snapshot: () => ({ asOfSeq: 1, values: { title: "Fixture session" } })
	};
	const ctx = {
		logger: { warn: () => {} },
		get: (key) => (key === "sessionDelete" ? state.provided?.value : {
			sessions,
			sessionPersistence: persistence,
			sessionQuery: { readTitle: async () => "Fixture session" },
			sessionProjections: projections,
			workspaceRegistry: registry,
			sessionProjectionCache: cache,
			agents
		}[key]),
		provide: (key, value) => {
			if (state.provided !== undefined) throw new Error(`service "${key}" has been registered at <fixture>`);
			state.provided = { key, value };
		},
		emit: (event, ...args) => {
			state.announced.push([event, ...args]);
		},
		waterfall: async () => state.activity,
		parallel: async () => {
			state.stopped = true;
			state.activity = [];
		},
		inject: (_deps, callback) => callback(ctx),
		tools: {
			register: (definition) => {
				state.registeredTools = [...state.registeredTools ?? [], definition];
			}
		},
		effect: () => () => {}
	};
	return { home, root, trashRoot, indexRoot: join(home, "restore-index"), header, directory, persistence, ctx, state, config: { trash: trashRoot, restoreIndexRoot: join(home, "restore-index") } };
}

/** Run `apply` against a fixture and hand back the service plus recorded state. */
function mount(fx) {
	apply(fx.ctx, fx.config);
	const service = fx.state.provided.value;
	assert.equal(fx.state.provided.key, "sessionDelete");
	return service;
}

/** Capture the failure a rejected call carries. */
async function rejection(run) {
	try {
		await run();
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to reject");
}

console.log("dsh-session-delete self-test");

await test("the manifest is a valid host face with two invocations", () => {
	assert.equal(TYPERT.package, "dsh-session-delete");
	assert.equal(TYPERT.face, "host");
	assert.deepEqual(TYPERT.invocations.map((entry) => `${entry.namespace}/${entry.method}`), ["sessionDelete/delete", "sessionDelete/restore"]);
	for (const invocation of TYPERT.invocations) {
		assert.equal(invocation.invocation.kind, "direct");
		assert.equal(invocation.result.mode, "strict");
		assert.equal(typeof invocation.result.create, "function");
		for (const parameter of invocation.parameters) {
			assert.equal(parameter.source, "json");
			assert.equal(parameter.codec.mode, "strict");
			assert.equal(typeof parameter.codec.create, "function");
		}
	}
	assert.equal(TYPERT.model.services[0].key, "sessionDelete");
	assert.ok(TYPERT.model.services[0].members.length === 2);
});

await test("the delete codec accepts exactly the declared wire fields", () => {
	const codec = TYPERT.invocations[0].parameters[0].codec.create();
	assert.deepEqual(codec.parse({ sessionId: "s1" }), { sessionId: "s1" });
	assert.deepEqual(codec.parse({ sessionId: "s1", force: true, purge: false }), { sessionId: "s1", force: true, purge: false });
	assert.throws(() => codec.parse({}), TypeError);
	assert.throws(() => codec.parse({ sessionId: "" }), TypeError);
	assert.throws(() => codec.parse({ sessionId: "s1", surprise: 1 }), TypeError);
	assert.throws(() => codec.parse({ sessionId: "s1", force: "yes" }), TypeError);
	const restore = TYPERT.invocations[1].parameters[0].codec.create();
	assert.deepEqual(restore.parse({ sessionId: "s1" }), { sessionId: "s1" });
	assert.throws(() => restore.parse({ sessionId: "s1", force: true }), TypeError);
});

await test("path encoding matches the JSONL backend's rules", () => {
	assert.equal(encodeSegment("session-1"), "session-1");
	assert.equal(encodeSegment(".."), "~002E~002E");
	assert.equal(encodeSegment("a~b"), "a~007Eb");
	assert.equal(projectKey("/Users/me/proj"), "--Users-me-proj--");
	assert.equal(projectKey("C:\\work"), "--C-work--");
});

await test("the host plugin provides the service with a visible Typert binding", async () => {
	const fx = await fixture();
	const service = mount(fx);
	assert.equal(service.typertRemote.service, service);
	assert.equal(service.typertRemote.serviceKey, "sessionDelete");
	assert.equal(service.typertRemote.namespace, "sessionDelete");
	assert.equal(typeof service.delete, "function");
	assert.equal(typeof service.restore, "function");
	const marker = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(service), "@deepseek-ai/dsh-typert-protocol/remote-methods");
	assert.ok(marker, "the service prototype carries the Gateway's SRC fallback markers");
	assert.deepEqual(marker.value.methods.map((entry) => entry.method), ["delete", "restore"]);
	assert.equal(Object.getPrototypeOf(Object.getPrototypeOf(service)), Object.prototype, "no marker leaks onto Object.prototype");
	// SRC discovery derives the wire parameters from the prototype method's signature.
	assert.match(Function.prototype.toString.call(Object.getPrototypeOf(service).delete), /deleteSessionRemote\(request, signal\)/);
	assert.match(Function.prototype.toString.call(Object.getPrototypeOf(service).restore), /restoreSessionRemote\(request\)/);
	assert.deepEqual(fx.state.registeredTools.map((tool) => tool.name), ["session_delete", "session_restore"]);
	for (const tool of fx.state.registeredTools) {
		assert.equal(tool.parameters.type, "object");
		for (const key of tool.parameters.required) assert.ok(Object.hasOwn(tool.parameters.properties, key), `${tool.name} requires declared property ${key}`);
		assert.equal(tool.output.schema.type, "object");
		assert.equal(typeof tool.output.render, "function");
		assert.ok(Array.isArray(tool.output.render({}, {})));
	}
	await rm(fx.home, { recursive: true, force: true });
});

await test("the service satisfies the Gateway's SRC discovery contract", async () => {
	const fx = await fixture();
	const service = mount(fx);
	// Mirrors dsh-typert-protocol's remoteMethods() + dsh-api-gateway's SRC derivation:
	// markers live on the prototype, and parameter names come from the method source.
	const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(service), "@deepseek-ai/dsh-typert-protocol/remote-methods");
	const methods = descriptor.value.methods.map((entry) => ({ ...entry }));
	assert.deepEqual(methods.map((entry) => entry.method), ["delete", "restore"]);
	assert.ok(methods.every((entry) => entry.invocation.kind === "direct"));
	const parameterNames = (method) => {
		let prototype = Object.getPrototypeOf(service);
		let implementation;
		while (prototype !== null) {
			const found = Object.getOwnPropertyDescriptor(prototype, method);
			if (found !== undefined) {
				if ("value" in found && typeof found.value === "function") implementation = found.value;
				break;
			}
			prototype = Object.getPrototypeOf(prototype);
		}
		assert.ok(implementation, `${method} must be reachable through the prototype chain`);
		const source = Function.prototype.toString.call(implementation);
		const open = source.indexOf("(");
		const close = source.indexOf(")", open + 1);
		return source.slice(open + 1, close).trim().split(",").map((part) => part.trim());
	};
	assert.deepEqual(parameterNames("delete"), ["request", "signal"]);
	assert.deepEqual(parameterNames("restore"), ["request"]);
	const binding = service.typertRemote;
	assert.equal(binding.service, service);
	assert.equal(binding.serviceKey, "sessionDelete");
	assert.equal(binding.namespace, "sessionDelete");
	assert.deepEqual(methods.map((entry) => `${binding.namespace}/${entry.method}`), ["sessionDelete/delete", "sessionDelete/restore"]);
	await rm(fx.home, { recursive: true, force: true });
});

await test("mounting the row twice keeps the first service instead of failing", async () => {
	const fx = await fixture();
	const first = mount(fx);
	apply(fx.ctx, fx.config);
	assert.equal(fx.state.provided.value, first, "the mounted service survives a second mount");
	assert.equal(typeof first.delete, "function");
	await rm(fx.home, { recursive: true, force: true });
});

await test("an unknown session is refused", async () => {
	const fx = await fixture();
	const service = mount(fx);
	const error = await rejection(() => service.delete({ sessionId: "session-nope" }));
	assert.equal(error.code, "session/not-found");
	await rm(fx.home, { recursive: true, force: true });
});

await test("live work is refused without stopActivity", async () => {
	const fx = await fixture({ activity: [{ kind: "turn" }] });
	const service = mount(fx);
	const error = await rejection(() => service.delete({ sessionId: fx.header.id, force: true }));
	assert.equal(error.code, "session/delete-active");
	assert.deepEqual(error.details.activity, [{ kind: "turn" }]);
	assert.equal(fx.state.stopped, false, "a refused delete must not stop anything");
	assert.ok(await stat(fx.directory), "a refused delete must leave the log in place");
	await rm(fx.home, { recursive: true, force: true });
});

await test("stopActivity stops the work and then trashes the session", async () => {
	const fx = await fixture({ activity: [{ kind: "turn" }] });
	const service = mount(fx);
	const result = await service.delete({ sessionId: fx.header.id, stopActivity: true, force: true });
	assert.equal(fx.state.stopped, true);
	assert.equal(result.moved, true);
	assert.equal(result.stopped, true);
	assert.equal(result.purged, false);
	assert.equal(result.bytes, Buffer.byteLength("log-bytes"));
	assert.equal(result.files, 2);
	assert.equal(result.trashRoot, fx.trashRoot);
	assert.ok(result.trashedTo.startsWith(fx.trashRoot));
	assert.deepEqual(result.notes, []);
	await assert.rejects(() => stat(fx.directory), "the live directory is gone");
	const record = JSON.parse(await readFile(join(result.trashedTo, "trash.json"), "utf8"));
	assert.equal(record.sessionId, fx.header.id);
	assert.equal(record.title, "Fixture session");
	assert.equal(result.title, "Fixture session");
	assert.equal(record.originalDirectory, fx.directory);
	assert.equal(record.bytes, Buffer.byteLength("log-bytes"));
	await stat(join(result.trashedTo, "session.v4.jsonl.zstd"));
	assert.deepEqual(fx.state.detached, [fx.header.id]);
	assert.deepEqual(fx.state.removedCacheRecords, [fx.header.id]);
	assert.deepEqual(fx.state.announced, [["api-session/removed", fx.header.id]]);
	await rm(fx.home, { recursive: true, force: true });
});

await test("a resident session is refused without force, before anything stops", async () => {
	const fx = await fixture({ live: true, running: true, activity: [{ kind: "turn" }] });
	const service = mount(fx);
	const error = await rejection(() => service.delete({ sessionId: fx.header.id, stopActivity: true, force: false }));
	assert.equal(error.code, "session/delete-live");
	assert.equal(error.details.live, true);
	assert.equal(error.details.running, true);
	assert.deepEqual(error.details.activity, [{ kind: "turn" }]);
	assert.equal(fx.state.stopped, false, "the first confirmation must not stop live work");
	assert.ok(await stat(fx.directory), "the refusal left the log in place");
	await rm(fx.home, { recursive: true, force: true });
});

await test("force stops the resident running session and deletes it", async () => {
	const fx = await fixture({ live: true, running: true, activity: [{ kind: "turn" }] });
	const service = mount(fx);
	const result = await service.delete({ sessionId: fx.header.id, stopActivity: true, force: true });
	assert.equal(fx.state.stopped, true, "the forced call stops the running work");
	assert.equal(result.live, true);
	assert.equal(result.running, true);
	assert.equal(result.stopped, true);
	assert.equal(result.moved, true);
	await rm(fx.home, { recursive: true, force: true });
});

await test("an unreadable title degrades to absent instead of failing", async () => {
	const fx = await fixture();
	fx.ctx.get = ((original) => (key) => {
		if (key === "sessionProjections") return { snapshot: () => {
			throw new Error("projection unavailable");
		} };
		if (key === "sessionQuery") return { readTitle: async () => {
			throw new Error("title fold unavailable");
		} };
		return original(key);
	})(fx.ctx.get);
	const service = mount(fx);
	const result = await service.delete({ sessionId: fx.header.id, force: true });
	assert.equal(result.title, undefined);
	assert.equal(JSON.parse(await readFile(join(result.trashedTo, "trash.json"), "utf8")).title, null);
	await rm(fx.home, { recursive: true, force: true });
});

await test("purge deletes outright and never touches the trash", async () => {
	const fx = await fixture();
	const service = mount(fx);
	const result = await service.delete({ sessionId: fx.header.id, force: true, purge: true });
	assert.equal(result.purged, true);
	assert.equal(result.moved, false);
	assert.equal(result.trashedTo, null);
	assert.ok(result.notes.some((note) => note.includes("purge")));
	await assert.rejects(() => stat(fx.directory), "the directory is gone");
	await assert.rejects(() => stat(fx.trashRoot), "purge creates no trash directory at all");
	await rm(fx.home, { recursive: true, force: true });
});

await test("a missing session directory still cleans accounting and caches", async () => {
	const fx = await fixture();
	await rm(fx.directory, { recursive: true, force: true });
	const service = mount(fx);
	const result = await service.delete({ sessionId: fx.header.id, force: true });
	assert.equal(result.moved, false);
	assert.equal(result.trashedTo, null);
	assert.ok(result.notes.some((note) => note.includes("already absent")));
	assert.deepEqual(fx.state.detached, [fx.header.id]);
	assert.deepEqual(fx.state.announced, [["api-session/removed", fx.header.id]]);
	await rm(fx.home, { recursive: true, force: true });
});

await test("restore puts the log back and reports conflicts", async () => {
	const fx = await fixture();
	const service = mount(fx);
	await service.delete({ sessionId: fx.header.id, force: true });
	await mkdir(fx.directory, { recursive: true });
	const conflict = await rejection(() => service.restore({ sessionId: fx.header.id }));
	assert.equal(conflict.code, "session/restore-conflict");
	await rm(fx.directory, { recursive: true, force: true });
	const restored = await service.restore({ sessionId: fx.header.id });
	assert.equal(restored.restoredTo, fx.directory);
	assert.ok(await stat(join(fx.directory, "session.v4.jsonl.zstd")), "the log is back");
	assert.ok(restored.note.includes("readable again"));
	const missing = await rejection(() => service.restore({ sessionId: fx.header.id }));
	assert.equal(missing.code, "session/restore-missing");
	await rm(fx.home, { recursive: true, force: true });
});

await test("the agent tool deletes through the same service", async () => {
	const fx = await fixture();
	mount(fx);
	const tool = fx.state.registeredTools.find((entry) => entry.name === "session_delete");
	const value = await tool.execute({ session_id: fx.header.id }, {});
	assert.equal(value.moved, true);
	assert.equal(value.sessionId, fx.header.id);
	assert.equal(value.trashRoot, fx.trashRoot);
	const rendered = tool.output.render({}, value);
	assert.equal(rendered[0].type, "text");
	assert.ok(rendered[0].text.includes(fx.header.id));
	const restoreTool = fx.state.registeredTools.find((entry) => entry.name === "session_restore");
	const back = await restoreTool.execute({ session_id: fx.header.id }, {});
	assert.equal(back.restoredTo, fx.directory);
	await rm(fx.home, { recursive: true, force: true });
});

await test("every tool result is lossless plain JSON", async () => {
	const fx = await fixture();
	mount(fx);
	const plain = (value) => {
		if (value === null || typeof value === "string" || typeof value === "boolean") return true;
		if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
		if (typeof value !== "object") return false;
		const prototype = Object.getPrototypeOf(value);
		if (Array.isArray(value)) return prototype === Array.prototype && value.every(plain);
		if (prototype !== Object.prototype && prototype !== null) return false;
		return Object.keys(value).every((key) => plain(value[key]));
	};
	const check = (label, value) => {
		assert.ok(plain(value), `${label} must return plain JSON, got ${String(value?.constructor?.name)}`);
		assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
	};
	const deleteTool = fx.state.registeredTools.find((tool) => tool.name === "session_delete");
	const restoreTool = fx.state.registeredTools.find((tool) => tool.name === "session_restore");
	check("session_delete (purge)", await deleteTool.execute({ session_id: fx.header.id, purge: true }, {}));
	await mkdir(fx.directory, { recursive: true });
	await writeFile(join(fx.directory, "session.v4.jsonl.zstd"), "log-bytes", "utf8");
	check("session_delete (trash)", await deleteTool.execute({ session_id: fx.header.id, purge: false }, {}));
	check("session_restore", await restoreTool.execute({ session_id: fx.header.id }, {}));
	await rm(fx.home, { recursive: true, force: true });
});

await test("the macOS backend hands the directory to ~/.Trash", async () => {
	const home = await mkdtemp(join(tmpdir(), "dsh-sd-macos-"));
	const backend = createSystemTrashBackend({ fs, path: trashPath, env: {}, home, platform: "darwin" });
	assert.equal(backend.kind, "system");
	assert.equal(backend.detail, "macos-trash");
	const source = join(home, "sessions", "project", "session-a");
	await mkdir(source, { recursive: true });
	await writeFile(join(source, "session.v4.jsonl.zstd"), "log-bytes", "utf8");

	const first = await backend.place(source, "session-a-2026-10-12T00-00-00-000Z", Date.now());
	assert.equal(first.entry, join(home, ".Trash", "session-a-2026-10-12T00-00-00-000Z"));
	assert.equal(first.move, "renamed");
	assert.equal(await readFile(join(first.entry, "session.v4.jsonl.zstd"), "utf8"), "log-bytes");
	await assert.rejects(() => stat(source), "Finder's Trash is where the directory went");

	// Finder's own collision convention: the second entry gets a " 2" suffix.
	const second = join(home, "sessions", "project", "session-b");
	await mkdir(second, { recursive: true });
	const placed = await backend.place(second, "session-a-2026-10-12T00-00-00-000Z", Date.now());
	assert.equal(placed.entry, join(home, ".Trash", "session-a-2026-10-12T00-00-00-000Z 2"));

	assert.deepEqual(await backend.list("session-a-"), [first.entry, placed.entry]);
	const back = join(home, "sessions", "project", "restored");
	await backend.takeBack(first.entry, back);
	assert.equal(await readFile(join(back, "session.v4.jsonl.zstd"), "utf8"), "log-bytes");
	await backend.discard(placed.entry);
	assert.deepEqual(await backend.list("session-a-"), []);
	await rm(home, { recursive: true, force: true });
});

await test("the Linux backend writes an XDG trash entry the desktop can restore", async () => {
	const home = await mkdtemp(join(tmpdir(), "dsh-sd-xdg-"));
	const dataHome = join(home, "data");
	const backend = createSystemTrashBackend({ fs, path: trashPath, env: { XDG_DATA_HOME: dataHome }, home, platform: "linux" });
	assert.equal(backend.detail, "xdg-trash");
	const source = join(home, "sessions", "session-b");
	await mkdir(source, { recursive: true });
	await writeFile(join(source, "session.v4.jsonl.zstd"), "log-bytes", "utf8");
	const at = Date.now();
	const first = await backend.place(source, "session-b-2026-10-12T00-00-00-000Z", at);
	assert.equal(first.entry, join(dataHome, "Trash", "files", "session-b-2026-10-12T00-00-00-000Z"));
	const info = await readFile(join(dataHome, "Trash", "info", "session-b-2026-10-12T00-00-00-000Z.trashinfo"), "utf8");
	assert.match(info, /^\[Trash Info\]\n/);
	assert.ok(info.includes(`Path=${encodeURIComponent(source)}`), "Path is percent-encoded per the spec");
	assert.match(info, /DeletionDate=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

	const second = join(home, "sessions", "session-c");
	await mkdir(second, { recursive: true });
	const placed = await backend.place(second, "session-b-2026-10-12T00-00-00-000Z", at);
	assert.equal(basename(placed.entry), "session-b-2026-10-12T00-00-00-000Z.2");

	const back = join(home, "sessions", "restored");
	await backend.takeBack(first.entry, back);
	await assert.rejects(() => stat(join(dataHome, "Trash", "info", "session-b-2026-10-12T00-00-00-000Z.trashinfo")), "restoring withdraws the trashinfo");
	await backend.discard(placed.entry);
	await assert.rejects(() => stat(join(dataHome, "Trash", "info", "session-b-2026-10-12T00-00-00-000Z.2.trashinfo")), "discarding withdraws the trashinfo");
	await rm(home, { recursive: true, force: true });
});

await test("the Windows backend recycles through PowerShell and admits it cannot read back", async () => {
	const calls = [];
	const backend = createSystemTrashBackend({
		fs,
		path: trashPath,
		env: {},
		home: "C:\\Users\\fixture",
		platform: "win32",
		run: async (file, args) => {
			calls.push({ file, args });
		}
	});
	assert.equal(backend.detail, "recycle-bin");
	const placed = await backend.place("C:\\Users\\fixture\\sessions\\session-a", "session-a-2026-10-12T00-00-00-000Z", Date.now());
	assert.equal(placed.entry, null, "the bin's layout is not discoverable");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].file, "powershell.exe");
	const command = calls[0].args.at(-1);
	assert.ok(command.includes("Microsoft.VisualBasic.FileIO.FileSystem"));
	assert.ok(command.includes("SendToRecycleBin"));
	assert.ok(command.includes("DeleteDirectory"));
	assert.deepEqual(await backend.list("session-a-"), [], "nothing to enumerate");
});

await test("a platform without a system trash gets no backend", async () => {
	assert.equal(createSystemTrashBackend({ fs, path: trashPath, env: {}, home: "/home/x", platform: "freebsd" }), undefined);
	assert.equal(createSystemTrashBackend({ fs, path: trashPath, env: {}, home: "", platform: "darwin" }), undefined);
});

await test("deletion runs end to end over the real macOS backend", async () => {
	const fx = await fixture();
	const backend = createSystemTrashBackend({ fs, path: trashPath, env: {}, home: fx.home, platform: "darwin" });
	const trash = createSessionTrash({ fs, path: trashPath, backend, host: createHostAdapter(fx.ctx, {}) });
	const result = await trash.remove({ sessionId: fx.header.id, force: true });
	assert.equal(result.moved, true);
	assert.equal(result.backend, "system");
	assert.equal(result.detail, "macos-trash");
	assert.equal(result.trashRoot, null, "a system trash names no directory of ours");
	assert.equal(result.trashedTo, join(fx.home, ".Trash", basename(result.trashedTo)));
	const record = JSON.parse(await readFile(join(result.trashedTo, TRASH_RECORD), "utf8"));
	assert.equal(record.backend, "macos-trash");
	assert.equal(record.originalDirectory, fx.directory);
	const restored = await trash.restore({ sessionId: fx.header.id });
	assert.equal(restored.restoredTo, fx.directory);
	await assert.rejects(() => stat(join(fx.directory, TRASH_RECORD)), "the provenance record is withdrawn on restore");
	assert.deepEqual(fx.state.detached, [fx.header.id]);
	await rm(fx.home, { recursive: true, force: true });
});

await test("an unusable destination fails without half-deleting the log", async () => {
	const fx = await fixture();
	const backend = {
		kind: "system",
		detail: "fixture",
		describe: () => "the fixture trash",
		place: async () => {
			throw new Error("destination is read-only");
		},
		list: async () => [],
		takeBack: async () => "renamed",
		discard: async () => {}
	};
	const trash = createSessionTrash({ fs, path: trashPath, backend, host: createHostAdapter(fx.ctx, {}) });
	const error = await rejection(() => trash.remove({ sessionId: fx.header.id, force: true }));
	assert.equal(error.code, "session/delete-failed");
	assert.ok(error.message.includes("destination is read-only"));
	assert.ok(await stat(join(fx.directory, "session.v4.jsonl.zstd")), "the log is still there");
	await assert.rejects(() => stat(join(fx.directory, TRASH_RECORD)), "the provenance record was withdrawn");
	assert.deepEqual(fx.state.announced, [], "a failed deletion announces nothing");
	await rm(fx.home, { recursive: true, force: true });
});

await test("a directory trash can be selected explicitly", async () => {
	const fx = await fixture();
	const root = join(fx.home, "own-trash");
	const backend = createDirectoryTrashBackend({ fs, path: trashPath, root });
	const trash = createSessionTrash({ fs, path: trashPath, backend, host: createHostAdapter(fx.ctx, {}) });
	const result = await trash.remove({ sessionId: fx.header.id, force: true });
	assert.equal(result.backend, "directory");
	assert.equal(result.trashRoot, root);
	assert.ok(result.trashedTo.startsWith(root));
	await rm(fx.home, { recursive: true, force: true });
});

await test("a deletion records the entry it cannot list again", async () => {
	const fx = await fixture();
	// macOS in one line: the trash takes the directory, reads of a known child work,
	// and readdir is refused, so this backend can never answer `list`.
	const unlistable = {
		kind: "system",
		detail: "unlistable-trash",
		describe: () => "an unlistable trash",
		place: async (directory, name) => {
			const entry = join(fx.home, "unlistable", name);
			await mkdir(dirname(entry), { recursive: true });
			await fs.rename(directory, entry);
			return { entry, move: "renamed" };
		},
		list: async () => [],
		takeBack: async (entry, target) => fs.rename(entry, target).then(() => "renamed"),
		discard: async (entry) => fs.rm(entry, { recursive: true, force: true })
	};
	const index = createRestoreIndex({ fs, path: trashPath, root: join(fx.home, "index") });
	const trash = createSessionTrash({ fs, path: trashPath, backend: unlistable, index, host: createHostAdapter(fx.ctx, {}) });
	const result = await trash.remove({ sessionId: fx.header.id, force: true });
	assert.equal(result.moved, true);
	assert.deepEqual(result.notes, [], "writing the index is part of a normal deletion");

	const records = await index.list(`${encodeSegment(fx.header.id)}-`);
	assert.equal(records.length, 1);
	assert.equal(records[0].record.entry, result.trashedTo);
	assert.equal(records[0].record.originalDirectory, fx.directory);
	assert.equal(records[0].record.backend, "unlistable-trash");

	// The restore must work through the record alone: `list` contributes nothing.
	const restored = await trash.restore({ sessionId: fx.header.id });
	assert.equal(restored.restoredTo, fx.directory);
	assert.ok(await stat(join(fx.directory, "session.v4.jsonl.zstd")), "the log is back");
	assert.deepEqual(await index.list(`${encodeSegment(fx.header.id)}-`), [], "the record is withdrawn");
	await assert.rejects(() => stat(join(fx.directory, TRASH_RECORD)), "the provenance record is withdrawn");
	await rm(fx.home, { recursive: true, force: true });
});

await test("a stale record is pruned instead of blocking a restore", async () => {
	const fx = await fixture();
	const index = createRestoreIndex({ fs, path: trashPath, root: join(fx.home, "index") });
	const backend = createDirectoryTrashBackend({ fs, path: trashPath, root: join(fx.home, "trash") });
	const trash = createSessionTrash({ fs, path: trashPath, backend, index, host: createHostAdapter(fx.ctx, {}) });
	// A record whose entry has been emptied out of the trash by the user.
	await index.remember({ name: `${encodeSegment(fx.header.id)}-2026-01-01T00-00-00-000Z`, sessionId: fx.header.id, entry: join(fx.home, "trash", "gone"), originalDirectory: fx.directory });
	const error = await rejection(() => trash.restore({ sessionId: fx.header.id }));
	assert.equal(error.code, "session/restore-missing");
	assert.ok(error.message.includes("no longer exist"), "the message says the entry is gone");
	assert.deepEqual(await index.list(`${encodeSegment(fx.header.id)}-`), [], "the stale record is pruned");
	await rm(fx.home, { recursive: true, force: true });
});

await test("purge leaves no restore record, and a pathless entry records nothing", async () => {
	const fx = await fixture();
	const index = createRestoreIndex({ fs, path: trashPath, root: join(fx.home, "index") });
	const directory = createDirectoryTrashBackend({ fs, path: trashPath, root: join(fx.home, "trash") });
	const trash = createSessionTrash({ fs, path: trashPath, backend: directory, index, host: createHostAdapter(fx.ctx, {}) });
	await trash.remove({ sessionId: fx.header.id, force: true, purge: true });
	assert.deepEqual(await index.list(`${encodeSegment(fx.header.id)}-`), [], "a purge records nothing");

	// The Windows recycle bin reports no path it could restore from, so nothing is recorded.
	await mkdir(fx.directory, { recursive: true });
	await writeFile(join(fx.directory, "session.v4.jsonl.zstd"), "log-bytes", "utf8");
	const recycle = {
		kind: "system",
		detail: "recycle-bin",
		describe: () => "the Recycle Bin",
		place: async () => ({ entry: null, move: "recycled" }),
		list: async () => [],
		takeBack: async () => "renamed",
		discard: async () => {}
	};
	const windowsTrash = createSessionTrash({ fs, path: trashPath, backend: recycle, index, host: createHostAdapter(fx.ctx, {}) });
	const result = await windowsTrash.remove({ sessionId: fx.header.id, force: true });
	assert.equal(result.moved, true);
	assert.equal(result.trashedTo, null);
	assert.deepEqual(await index.list(`${encodeSegment(fx.header.id)}-`), [], "no path, no record");
	const error = await rejection(() => windowsTrash.restore({ sessionId: fx.header.id }));
	assert.equal(error.code, "session/restore-missing");
	assert.ok(error.message.includes("by hand"), "the failure tells the user to open the Recycle Bin");
	await rm(fx.home, { recursive: true, force: true });
});

await test("the host adapter degrades gracefully without optional services", async () => {
	const fx = await fixture();
	const bare = {
		logger: { warn: () => {} },
		get: (key) => (key === "sessions" ? { get: () => undefined } : undefined),
		emit: () => {},
		waterfall: async () => [],
		parallel: async () => {},
		inject: () => {},
		effect: () => () => {}
	};
	const adapter = createHostAdapter(bare, {});
	assert.equal(adapter.liveHeader("x"), undefined);
	assert.deepEqual(await adapter.storedHeaders(), []);
	assert.equal(adapter.running("x"), false);
	assert.equal(adapter.artifactPath({ id: "x" }), undefined);
	assert.deepEqual(await adapter.activity("x"), []);
	await adapter.detachAccounting("x");
	await adapter.dropCaches("x");
	adapter.announceRemoved("x");
	await rm(fx.home, { recursive: true, force: true });
});

await test("the client half survives being re-applied in one page", async () => {
	// Load the real browser module by giving it the module table it expects, then
	// drive its apply() against a locale registry shaped like the shipped one:
	// register() throws on a duplicate locale, and only the returned disposer
	// withdraws entries. That is exactly the failure reported as
	// `locale namespace "session-delete" already has locale "en"`.
	const loaded = [];
	globalThis.window = {
		__ModuleLoader__: {
			load: (registration) => {
				loaded.push(registration);
			}
		}
	};
	try {
		const url = new URL("../lib/client.js", import.meta.url).href;
		await import(`${url}?reload-safety=${Math.random()}`);
	} finally {
		delete globalThis.window;
	}
	assert.equal(loaded.length, 1);
	const registration = loaded[0];
	assert.equal(registration.id, "dsh-session-delete");

	const reactStub = {
		createElement: () => ({}),
		Fragment: {},
		useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
		useEffect: () => {},
		useState: (initial) => [initial, () => {}]
	};
	const reactJsxStub = {};
	const primitivesStub = new Proxy({}, { get: () => () => ({}) });
	const require = (specifier) => {
		if (specifier === "react") return reactStub;
		if (specifier === "react/jsx-runtime") return reactJsxStub;
		if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return primitivesStub;
		throw new Error(`unexpected require(${JSON.stringify(specifier)})`);
	};
	const exports = registration.factory(require);

	/** A locale registry that behaves like the shipped one (duplicate locales throw). */
	const makeLocale = () => {
		const dictionaries = new Map();
		const listeners = new Set();
		return {
			registered: [],
			register(namespace, dicts) {
				for (const locale of Object.keys(dicts)) {
					if (dictionaries.has(`${namespace}/${locale}`)) throw new Error(`locale namespace "${namespace}" already has locale "${locale}"`);
				}
				for (const [locale, entries] of Object.entries(dicts)) dictionaries.set(`${namespace}/${locale}`, entries);
				this.registered.push(...Object.keys(dicts));
				return () => {
					for (const locale of Object.keys(dicts)) dictionaries.delete(`${namespace}/${locale}`);
				};
			},
			has: (namespace, locale) => dictionaries.has(`${namespace}/${locale}`),
			bind(namespace) {
				return (key) => {
					for (const [, entries] of dictionaries) if (entries[key] !== undefined) return entries[key];
					return key;
				};
			},
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			}
		};
	};

	/** One page generation: a fiber-owned effect list plus the services apply() uses. */
	const makePage = (locale) => {
		const effectCleanups = [];
		const mounts = [];
		const slotInjections = [];
		const ctx = {
			locale,
			remote: {
				$mount: async (contribution) => {
					mounts.push(contribution.package);
					return async () => {};
				}
			},
			slots: {
				inject: (key, callback) => {
					slotInjections.push(key);
					const registrations = [];
					const iterator = callback();
					for (let next = iterator.next(); next.done !== true; next = iterator.next()) registrations.push(next.value);
					return () => {
						for (const dispose of registrations) dispose();
					};
				},
				register: () => () => {}
			},
			mounted: new Map(),
			get: (key) => ctx.mounted.get(key),
			effect: (callback) => {
				const cleanup = callback();
				if (typeof cleanup === "function") effectCleanups.push(cleanup);
				return () => {};
			},
			logger: { warn: () => {}, error: () => {} }
		};
		return { ctx, effectCleanups, mounts, slotInjections };
	};

	// Generation 1 mounts, generation 2 replaces it exactly as the module system does:
	// the old fiber is torn down first, then the fresh module is applied.
	const locale = makeLocale();
	const first = makePage(locale);
	await exports.apply(first.ctx);
	assert.deepEqual(first.mounts, ["dsh-session-delete"]);
	assert.deepEqual(first.slotInjections, ["sidebar.workspaces.session.menu.item", "shell.overlay"]);
	assert.deepEqual(locale.registered, ["en", "zh"]);
	assert.equal(locale.has("session-delete", "en"), true, "generation 1 owns the dictionaries");
	for (const cleanup of first.effectCleanups.reverse()) await cleanup();
	// The fiber-owned registration is withdrawn on teardown, which is what makes the
	// namespace registrable again for the next generation.
	assert.equal(locale.has("session-delete", "en"), false, "teardown withdrew the dictionaries");
	assert.equal(locale.has("session-delete", "zh"), false, "teardown withdrew the dictionaries");

	const second = makePage(locale);
	await exports.apply(second.ctx);
	assert.deepEqual(second.mounts, ["dsh-session-delete"]);
	assert.deepEqual(second.slotInjections, ["sidebar.workspaces.session.menu.item", "shell.overlay"]);

	// Worst case: an earlier generation that was never torn down. The probe must keep
	// the re-apply from throwing (the reported regression), and must not duplicate the
	// registration either.
	const third = makePage(locale);
	await exports.apply(third.ctx);
	assert.deepEqual(locale.registered, ["en", "zh", "en", "zh"]);
});

await test("sessionDeleteError is structurally a Remote failure", () => {
	const error = sessionDeleteError("session/not-found", "gone", { sessionId: "s" });
	assert.equal(error.isDSHRemoteError, true);
	assert.equal(error.code, "session/not-found");
	assert.deepEqual(error.details, { sessionId: "s" });
	assert.ok(error instanceof Error);
});

await test("dirname of a located artifact yields the session directory", async () => {
	const fx = await fixture();
	const adapter = createHostAdapter(fx.ctx, {});
	const located = adapter.artifactPath(fx.header);
	assert.equal(dirname(located), fx.directory);
	await rm(fx.home, { recursive: true, force: true });
});

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
