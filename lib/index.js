/**
 * dsh-session-delete host half.
 *
 * One loader row provides the `sessionDelete` Cordis service — the Remote
 * namespace the Web sidebar calls — plus two agent tools over the same logic:
 *
 *  - `session_delete`  : hand one Session's durable log to the platform trash.
 *  - `session_restore` : move a trashed Session back where it was.
 *
 * The destination is the **platform's own trash** (`~/.Trash`, the XDG trash, the
 * Windows Recycle Bin) by default; `config.trash` can point at a directory
 * instead when a deployment has no usable system trash.
 *
 * Deletion is deliberately composed from public host seams (`sessions`,
 * `sessionPersistence`, `workspaceRegistry`, `sessionProjectionCache`, and the
 * Workspace archive admission waterfall) instead of reaching into the session
 * store: the store owns its write handles and offers no delete verb, so the
 * only safe deletion is one that respects the same liveness rules as archiving.
 *
 * No `@deepseek-ai/*` runtime package is imported: a third-party plugin is not
 * resolvable from the DSH package tree, so this module uses only the context it
 * is handed and Node built-ins.
 *
 * @module dsh-session-delete
 */

import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createSessionTrash } from "./session-trash.js";
import { createDirectoryTrashBackend, createSystemTrashBackend } from "./trash.js";
import { createRestoreIndex } from "./restore-index.js";

/** Promisified `execFile`, used only for the Windows recycle-bin hop. */
const runFile = promisify(execFile);

/** Cordis plugin name. */
export const name = "session-delete";

/**
 * The property `remoteMethods()` reads for its Remote method markers. It is a
 * plain string on `dsh-typert-protocol`'s side (not a Symbol), so replicating it
 * here costs no import — which matters because a third-party plugin cannot
 * resolve `@deepseek-ai/*` packages from the DSH tree.
 */
const REMOTE_METHOD_DESCRIPTOR = "@deepseek-ai/dsh-typert-protocol/remote-methods";

/**
 * Build one service whose Remote shape works under both Gateway discovery modes.
 *
 * The generated Typert manifest in `./typert` is what this composition normally
 * uses. The markers below are the Gateway's own fallback ("SRC" discovery), so
 * the namespace keeps working even if that manifest is never registered — for
 * example when a hot-installed entry mounts outside the loader's package scan.
 * SRC discovery reads each method from the service's PROTOTYPE (it derives the
 * wire parameters from the method signature), which is why the handlers live
 * here and the service instance is created from this prototype.
 *
 * @param {object} handlers - the two business operations.
 * @param {(request: object, signal?: AbortSignal) => Promise<object>} handlers.deleteSession - deletion.
 * @param {(request: object) => Promise<object>} handlers.restoreSession - restore.
 * @returns the service value to `ctx.provide`.
 */
function createSessionDeleteService({ deleteSession, restoreSession }) {
	const prototype = {};
	Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
		configurable: true,
		value: Object.freeze({
			version: 1,
			methods: Object.freeze([
				Object.freeze({ method: "delete", invocation: Object.freeze({ kind: "direct" }) }),
				Object.freeze({ method: "restore", invocation: Object.freeze({ kind: "direct" }) })
			])
		})
	});
	/**
	 * Delete one Session: stop its work when asked, then move its durable
	 * directory into the trash and drop every registration that named it.
	 * @param request - Session identity and deletion policy.
	 * @param signal - caller lifetime, honoured while waiting for work to stop.
	 * @returns the deletion summary.
	 */
	prototype.delete = async function deleteSessionRemote(request, signal) {
		return await deleteSession(request, signal);
	};
	/**
	 * Restore one trashed Session directory to its original location.
	 * @param request - Session identity.
	 * @returns the restore summary.
	 */
	prototype.restore = async function restoreSessionRemote(request) {
		return await restoreSession(request);
	};
	const service = Object.create(prototype);
	// The Typert gateway validates this visible binding before dispatching any
	// Remote call; the shape is the one `bindTypertRemote` produces.
	Object.defineProperty(service, "typertRemote", {
		configurable: false,
		enumerable: false,
		writable: false,
		value: { service, serviceKey: "sessionDelete", namespace: "sessionDelete" }
	});
	return service;
}

/**
 * The directory a profile-owned trash uses when it asks for one and names no
 * path: beside the session root, i.e. `$DSH_HOME/session-trash`.
 */
function defaultDirectoryTrashRoot(env) {
	const home = typeof env?.DSH_HOME === "string" && env.DSH_HOME.length > 0 ? env.DSH_HOME : undefined;
	return home === undefined ? undefined : join(home, "session-trash");
}

/**
 * Build the host adapter the trash logic runs against.
 *
 * @param {object} ctx - host plugin context.
 * @param {object} config - resolved plugin configuration (`trashRoot`).
 * @returns the adapter.
 */
export function createHostAdapter(ctx, config) {
	const log = (message) => {
		try {
			ctx.logger?.warn?.(`session-delete: ${message}`);
		} catch {
			/* a diagnostics failure never fails a deletion */
		}
	};
	const sessions = () => ctx.get("sessions");
	const persistence = () => ctx.get("sessionPersistence");
	const registry = () => ctx.get("workspaceRegistry");
	const sessionsRoot = () => {
		const backend = persistence();
		if (typeof backend?.root === "string" && backend.root.length > 0) return backend.root;
		const configured = backend?.config?.root;
		return typeof configured === "string" && configured.length > 0 ? configured : undefined;
	};
	/**
	 * One Session's display title, best-effort: the live `title` projection first
	 * (a plain string), then the stored fold through `sessionQuery`. Both the
	 * projection value and the query result are normalized to a string, because
	 * a tool result must be lossless JSON.
	 */
	const titleOf = async (sessionId, signal) => {
		const asText = (value) => {
			if (typeof value === "string") return value.length > 0 ? value : undefined;
			if (value !== null && typeof value === "object" && typeof value.title === "string") return value.title.length > 0 ? value.title : undefined;
			return undefined;
		};
		try {
			const live = sessions()?.get(sessionId);
			const projections = ctx.get("sessionProjections");
			if (live !== undefined && projections !== undefined) {
				const snapshot = projections.snapshot(live, ["title"]);
				const projected = asText(snapshot?.values?.title);
				if (projected !== undefined) return projected;
			}
			const query = ctx.get("sessionQuery");
			if (query !== undefined && typeof query.readTitle === "function") {
				const stored = asText(await query.readTitle(sessionId, signal));
				if (stored !== undefined) return stored;
			}
		} catch {
			/* a missing title is not a reason to fail a deletion */
		}
		return undefined;
	};
	return {
		liveHeader: (sessionId) => sessions()?.get(sessionId)?.header,
		storedHeaders: async () => {
			const backend = persistence();
			if (backend === undefined) return [];
			return (await backend.list()).map((snapshot) => snapshot.header);
		},
		artifactPath: (header) => {
			const backend = persistence();
			if (typeof backend?.locate !== "function") return undefined;
			const located = backend.locate(header);
			return typeof located?.path === "string" ? located.path : undefined;
		},
		sessionsRoot,
		running: (sessionId) => ctx.get("agents")?.get(sessionId)?.status === "running",
		activity: (sessionId) => ctx.waterfall("workspace/session-activity", { sessionId }, () => Promise.resolve([])),
		stopActivity: async (sessionId) => {
			await ctx.parallel("workspace/session-stop", { sessionId });
		},
		detachAccounting: async (sessionId) => {
			const workspaces = registry();
			for (const workspace of workspaces?.list?.() ?? []) {
				try {
					await workspace.detachSession?.(sessionId);
				} catch (error) {
					log(`workspace '${String(workspace.id)}' keeps session '${sessionId}' in its account: ${String(error)}`);
				}
			}
			try {
				await workspaces?.unarchiveSession?.(sessionId);
			} catch (error) {
				log(`archive entry for '${sessionId}' was not dropped: ${String(error)}`);
			}
			try {
				await workspaces?.unpinSession?.(sessionId);
			} catch (error) {
				log(`pin entry for '${sessionId}' was not dropped: ${String(error)}`);
			}
		},
		dropCaches: async (sessionId) => {
			const cache = ctx.get("sessionProjectionCache");
			const table = cache?.table;
			if (table === undefined || typeof table.delete !== "function") return;
			try {
				await table.delete(sessionId);
			} catch (error) {
				log(`projection-cache record for '${sessionId}' was not dropped: ${String(error)}`);
			}
		},
		announceRemoved: (sessionId) => {
			try {
				ctx.emit("api-session/removed", sessionId);
			} catch (error) {
				log(`api-session/removed for '${sessionId}' was not announced: ${String(error)}`);
			}
		},
		title: titleOf,
		config
	};
}

/**
 * Mount the service, its Remote binding, and the agent tools.
 *
 * @param {object} ctx - host plugin context.
 * @param {object} [config] - loader configuration.
 */
export function apply(ctx, config) {
	const settings = config ?? {};
	const directoryRoot = () => {
		const configured = typeof settings.trashRoot === "string" && settings.trashRoot.length > 0 ? settings.trashRoot : undefined;
		if (configured !== undefined) return configured;
		const root = ctx.get("sessionPersistence")?.root;
		if (typeof root === "string" && root.length > 0) return join(dirname(root), "session-trash");
		return defaultDirectoryTrashRoot(process.env);
	};
	/**
	 * The destination, resolved once per mount:
	 *  - absent or `"system"` → the platform's own trash (the default);
	 *  - `"directory"` → a trash directory this plugin owns, at `trashRoot` or
	 *    beside the session root;
	 *  - any other string → that directory, taken as an absolute path.
	 * @returns the backend the deletion hands the directory to.
	 */
	const selectBackend = () => {
		const configured = settings.trash;
		if (typeof configured === "string" && configured !== "" && configured !== "system") {
			return createDirectoryTrashBackend({ fs: trashFs, path: trashPath, root: configured === "directory" ? directoryRoot() : configured });
		}
		const system = createSystemTrashBackend({
			fs: trashFs,
			path: trashPath,
			env: process.env,
			home: homedir(),
			platform: process.platform,
			run: (file, args) => runFile(file, args, { timeout: 20_000, windowsHide: true })
		});
		if (system !== undefined) return system;
		const root = directoryRoot();
		ctx.logger?.warn?.(`session-delete: ${process.platform} has no system trash this plugin can reach; using ${String(root)} instead (set config.trash to choose)`);
		return createDirectoryTrashBackend({ fs: trashFs, path: trashPath, root });
	};
	const trashFs = { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile };
	const trashPath = { basename, dirname, join };
	const backend = selectBackend();
	const adapter = createHostAdapter(ctx, settings);
	/**
	 * Where the restore index lives. A trash the platform will not let a process
	 * enumerate (macOS `~/.Trash`) can only be restored through this record, so it
	 * defaults next to the session root and can be pointed elsewhere with
	 * `config.restoreIndexRoot`. It stores entry paths and the original directory,
	 * never Session content.
	 */
	const indexRoot = () => {
		if (typeof settings.restoreIndexRoot === "string" && settings.restoreIndexRoot.length > 0) return settings.restoreIndexRoot;
		const home = typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : undefined;
		if (home !== undefined) return join(home, "session-delete");
		const root = ctx.get("sessionPersistence")?.root;
		return typeof root === "string" && root.length > 0 ? join(dirname(root), "session-delete") : undefined;
	};
	const trash = createSessionTrash({
		fs: trashFs,
		path: trashPath,
		backend,
		index: createRestoreIndex({ fs: trashFs, path: trashPath, root: indexRoot }),
		host: adapter
	});
	/**
	 * Delete one Session, handing its directory to the configured destination.
	 * @param {object} request - Session identity and deletion policy.
	 * @param {AbortSignal} [signal] - caller lifetime, honoured while waiting for work to stop.
	 * @returns the deletion summary.
	 */
	const deleteSession = async (request = {}, signal) => {
		return trash.remove({
			sessionId: String(request.sessionId ?? ""),
			stopActivity: request.stopActivity === true,
			force: request.force === true,
			purge: request.purge === true,
			signal
		});
	};
	/**
	 * Put one trashed Session directory back where the store expects it.
	 * @param {object} request - Session identity.
	 * @returns the restore summary.
	 */
	const restoreSession = async (request = {}) => {
		return trash.restore({ sessionId: String(request.sessionId ?? "") });
	};
	const service = createSessionDeleteService({ deleteSession, restoreSession });
	// Own the registration through the fiber, and tolerate a second mount of this
	// package (two rows, or a hot-installed copy beside an installed one): Cordis
	// refuses a duplicate service, and skipping it keeps the first, working service
	// instead of failing the whole row.
	if (ctx.get("sessionDelete") === undefined) ctx.provide("sessionDelete", service);
	else ctx.logger?.warn?.("session-delete: sessionDelete is already provided; keeping the mounted service");

	ctx.inject(["tools"], (toolCtx) => {
		toolCtx.tools.register({
			name: "session_delete",
			description:
				"Delete one Session by moving its durable log to the platform's own trash (the Finder's Trash, the XDG trash, or the Windows Recycle Bin) and dropping it from the workspace list, archive set, and pin set. Use it when the user asks to delete or clean up a Session (archiving only hides a Session; this removes it). A running Session is stopped first; a Session still resident in the host requires force: true. Set purge: true to delete the bytes outright instead of trashing them.",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: {
					session_id: {
						type: "string",
						description: "Exact Session id to delete, for example session-a8927024-a411-4d69-8e84-c6bc6592ab38."
					},
					stop_activity: {
						type: "boolean",
						description: "Cancel the Session's live work before deleting instead of failing while it runs. Defaults to true."
					},
					force: {
						type: "boolean",
						description: "Delete although the Session is still resident in the host process. Defaults to false, which reports the conflict instead."
					},
					purge: {
						type: "boolean",
						description: "Delete the bytes permanently instead of keeping them in the trash directory. Defaults to false."
					}
				},
				required: ["session_id"]
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						sessionId: { type: "string" },
						title: { type: "string" },
						moved: { type: "boolean" },
						purged: { type: "boolean" },
						stopped: { type: "boolean" },
						backend: { type: "string", enum: ["system", "directory"] },
						detail: { type: "string" },
						trashedTo: { type: "string" },
						trashRoot: { type: "string" },
						bytes: { type: "integer" },
						files: { type: "integer" },
						notes: { type: "array", items: { type: "string" } }
					},
					required: ["sessionId", "moved", "purged", "stopped", "backend", "detail", "bytes", "files", "notes"]
				},
				render: (_args, value) => [{
					type: "text",
					text: value.purged
						? `Session ${value.sessionId} deleted permanently (${value.files} file(s), ${value.bytes} byte(s)).`
						: value.moved
							? `Session ${value.sessionId} moved to ${value.trashedTo ?? value.detail} (${value.files} file(s), ${value.bytes} byte(s)).`
							: `Session ${value.sessionId} had no directory left on disk; its workspace accounting and caches were cleaned.`
				}]
			},
			execute: async (args) => {
				const result = await deleteSession({
					sessionId: args.session_id,
					stopActivity: args.stop_activity !== false,
					force: args.force === true,
					purge: args.purge === true
				});
				return {
					sessionId: result.sessionId,
					...result.title === undefined ? {} : { title: result.title },
					moved: result.moved,
					purged: result.purged,
					stopped: result.stopped,
					backend: result.backend,
					detail: result.detail,
					...result.trashedTo === null ? {} : { trashedTo: result.trashedTo },
					...result.trashRoot === null ? {} : { trashRoot: result.trashRoot },
					bytes: result.bytes,
					files: result.files,
					notes: result.notes
				};
			}
		});

		toolCtx.tools.register({
			name: "session_restore",
			description:
				"Restore one Session that `session_delete` moved to the platform's trash, putting its durable log back where the session store expects it. Only entries this plugin can read are restorable: a Windows Recycle Bin entry has to be restored from the Recycle Bin itself. The Session becomes readable again after the workspace registry next indexes stored headers (a reload of the app, or the next launch).",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: {
					session_id: { type: "string", description: "Exact Session id to restore from the trash." }
				},
				required: ["session_id"]
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						sessionId: { type: "string" },
						restoredTo: { type: "string" },
						from: { type: "string" },
						note: { type: "string" }
					},
					required: ["sessionId", "restoredTo", "from", "note"]
				},
				render: (_args, value) => [{
					type: "text",
					text: `Session ${value.sessionId} restored to ${value.restoredTo}. ${value.note}`
				}]
			},
			execute: async (args) => {
				const result = await restoreSession({ sessionId: args.session_id });
				return {
					sessionId: result.sessionId,
					restoredTo: result.restoredTo,
					from: result.from,
					note: result.note
				};
			}
		});
	});
}
