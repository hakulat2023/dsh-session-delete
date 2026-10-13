/**
 * Session trash: the durable, recoverable half of Session deletion.
 *
 * The DSH session store has no delete verb — `sessionPersistence` is an
 * append-only seam (`create`/`open`/`stat`/`list`) and a live Session owns its
 * log through an open write handle. Deletion therefore has to be composed from
 * what the host already exposes:
 *
 *  1. refuse while the Session still has live work, unless the caller asked for
 *     a stop (the same `workspace/session-activity` / `workspace/session-stop`
 *     admission the Workspace archive uses);
 *  2. hand the Session's own directory to the platform's trash — see
 *     `./trash.js` — so the session disappears from every listing while the
 *     user's own trash keeps it recoverable;
 *  3. drop the Session from Workspace accounting and from the registry-global
 *     archive/pin sets, and drop its projection-cache record;
 *  4. announce `api-session/removed` so every connected browser drops the row.
 *
 * This module owns steps 1-4 with no imports beyond `node:fs`/`node:path`:
 * every host capability arrives through the adapter the plugin builds, and the
 * destination arrives as a trash backend, which keeps the logic unit-testable
 * without a DSH runtime.
 *
 * @module dsh-session-delete/session-trash
 */

import { TRASH_RECORD } from "./trash.js";

/** Structural Remote failure: cross-module identification never uses `instanceof`. */
export function sessionDeleteError(code, message, details = {}) {
	const error = new Error(message);
	error.name = "SessionDeleteError";
	error.isDSHRemoteError = true;
	error.code = code;
	error.details = details;
	return error;
}

/** Stable failure codes shared by the Remote verbs and the agent tools. */
export const SESSION_DELETE_CODES = Object.freeze({
	notFound: "session/not-found",
	live: "session/delete-live",
	active: "session/delete-active",
	failed: "session/delete-failed",
	restoreMissing: "session/restore-missing",
	restoreConflict: "session/restore-conflict",
	badRequest: "gateway/bad-request"
});

/** Safe code units stay literal; every other unit (including `~`) becomes `~XXXX`. */
export function encodeSegment(raw) {
	if (typeof raw !== "string" || raw.length === 0) throw new Error("cannot encode an empty path segment");
	if (raw === ".") return "~002E";
	if (raw === "..") return "~002E~002E";
	let out = "";
	for (let index = 0; index < raw.length; index++) {
		const code = raw.charCodeAt(index);
		const char = String.fromCharCode(code);
		if (char !== "~" && /^[A-Za-z0-9._-]$/.test(char)) out += char;
		else out += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
	}
	return out;
}

/** The persistence backend's human-navigable project directory name for one cwd. */
export function projectKey(cwd) {
	if (typeof cwd !== "string" || cwd.length === 0) throw new Error("cannot encode an empty project path");
	let readable = "";
	let separatorRun = false;
	for (let index = 0; index < cwd.length; index++) {
		const code = cwd.charCodeAt(index);
		const char = String.fromCharCode(code);
		if (char === "/" || char === "\\" || char === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (char !== "~" && /^[A-Za-z0-9._-]$/.test(char)) {
			readable += char;
			separatorRun = false;
		} else {
			readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/**
 * Deterministic trash entry name for one deletion. The name is also the restore
 * key: a backend lists entries by this prefix.
 */
export function trashEntryName(sessionId, at) {
	const stamp = new Date(at).toISOString().replace(/[:.]/g, "-");
	return `${encodeSegment(sessionId)}-${stamp}`;
}

/**
 * Create the trash operations over one host adapter and one trash backend.
 *
 * @param {object} options - wiring.
 * @param {object} options.fs - `node:fs/promises` (or an equivalent test double).
 * @param {object} options.path - `node:path`.
 * @param {object} options.backend - destination backend: `place`, `list`, `takeBack`, `discard`.
 * @param {object} [options.index] - restore index: `remember`, `list`, `forget` (see `./restore-index.js`).
 * @param {object} options.host - live host adapter (see `createHostAdapter` in the plugin body).
 * @param {() => number} [options.now] - clock, injectable for tests.
 * @returns the trash operations.
 */
export function createSessionTrash({ fs, path, backend, index, host, now = () => Date.now() }) {
	/** Resolve one Session's immutable header from the live store or persistence. */
	async function resolveHeader(sessionId) {
		const live = host.liveHeader(sessionId);
		if (live !== undefined) return { header: live, live: true };
		const stored = await host.storedHeaders();
		const header = stored.find((candidate) => candidate.id === sessionId);
		if (header === undefined) return undefined;
		return { header, live: false };
	}

	/** One Session's display title; a missing or failing lookup is never a reason to fail a deletion. */
	async function safeTitle(sessionId, signal) {
		try {
			const value = await host.title(sessionId, signal);
			return typeof value === "string" && value.length > 0 ? value : undefined;
		} catch {
			return undefined;
		}
	}

	/** The Session-owned directory: preference order is the backend's own locator, then the documented layout. */
	function sessionDirectory(header) {
		const located = host.artifactPath(header);
		if (typeof located === "string" && located.length > 0) return path.dirname(located);
		const root = host.sessionsRoot();
		if (typeof root !== "string" || root.length === 0) return undefined;
		const project = header.cwd === undefined ? "_no-cwd" : projectKey(header.cwd);
		return path.join(root, project, encodeSegment(String(header.id)));
	}

	/** Recursive byte/file total of a directory tree; a missing tree reads as empty. */
	async function measure(directory) {
		let bytes = 0;
		let files = 0;
		const walk = async (current) => {
			let entries;
			try {
				entries = await fs.readdir(current, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const child = path.join(current, entry.name);
				if (entry.isDirectory()) {
					await walk(child);
					continue;
				}
				files += 1;
				try {
					bytes += (await fs.stat(child)).size;
				} catch {
					/* a file that vanished mid-walk contributes no bytes */
				}
			}
		};
		await walk(directory);
		return { bytes, files };
	}

	async function exists(target) {
		try {
			await fs.stat(target);
			return true;
		} catch {
			return false;
		}
	}

	/** Wait until the Session reports no activity, bounded by `budgetMs`. */
	async function waitForIdle(sessionId, signal, budgetMs = 15_000) {
		const deadline = now() + budgetMs;
		let activity = await host.activity(sessionId);
		while (activity.length > 0 && now() < deadline) {
			signal?.throwIfAborted();
			await new Promise((resolve) => setTimeout(resolve, 200));
			activity = await host.activity(sessionId);
		}
		return activity;
	}

	/**
	 * Delete one Session by handing its directory to the trash backend.
	 *
	 * @param {object} request - deletion request.
	 * @param {string} request.sessionId - Session identity.
	 * @param {boolean} [request.stopActivity] - cancel live work instead of refusing.
	 * @param {boolean} [request.force] - proceed although the Session is still resident.
	 * @param {boolean} [request.purge] - delete the directory outright, without the trash.
	 * @param {AbortSignal} [request.signal] - caller lifetime for the stop wait.
	 * @returns the deletion summary.
	 */
	async function remove({ sessionId, stopActivity = false, force = false, purge = false, signal }) {
		if (typeof sessionId !== "string" || sessionId.length === 0) {
			throw sessionDeleteError(SESSION_DELETE_CODES.badRequest, "session delete requires a non-empty sessionId", { field: "sessionId" });
		}
		const resolved = await resolveHeader(sessionId);
		if (resolved === undefined) {
			throw sessionDeleteError(SESSION_DELETE_CODES.notFound, `session "${sessionId}" not found: neither the live store nor session persistence holds it`, { sessionId });
		}
		const { header } = resolved;
		// The title is read BEFORE the directory moves, because a cold Session's
		// title comes from its log.
		const title = await safeTitle(sessionId, signal);
		const live = host.liveHeader(sessionId) !== undefined;
		const running = host.running(sessionId);
		let activity = await host.activity(sessionId);
		let stopped = false;
		// The residency guard runs BEFORE any stop: a refused confirmation must
		// leave the Session exactly as it was. The forced call that follows stops
		// the work and deletes in one go.
		if (live && !force) {
			throw sessionDeleteError(
				SESSION_DELETE_CODES.live,
				`session "${sessionId}" is still ${running ? "running" : "resident"} in this host process; confirm again to stop it and delete it`,
				{ sessionId, live: true, running, activity }
			);
		}
		if (activity.length > 0) {
			if (!stopActivity) {
				throw sessionDeleteError(SESSION_DELETE_CODES.active, `cannot delete session "${sessionId}": it still has live work (${describeActivity(activity)})`, {
					sessionId,
					activity
				});
			}
			await host.stopActivity(sessionId);
			stopped = true;
			activity = await waitForIdle(sessionId, signal);
			if (activity.length > 0) {
				throw sessionDeleteError(SESSION_DELETE_CODES.active, `cannot delete session "${sessionId}": its work did not stop within the budget (${describeActivity(activity)})`, {
					sessionId,
					activity
				});
			}
		}
		const directory = sessionDirectory(header);
		const notes = [];
		const at = now();
		let trashedTo = null;
		let moved = false;
		let purged = false;
		let measured = { bytes: 0, files: 0 };
		if (directory === undefined) {
			notes.push("no session directory could be resolved; only accounting and caches were cleaned");
		} else if (!await exists(directory)) {
			notes.push(`session directory '${directory}' was already absent; only accounting and caches were cleaned`);
		} else {
			measured = await measure(directory);
			if (purge) {
				await fs.rm(directory, { recursive: true, force: true });
				purged = true;
				notes.push("purge requested: the directory was deleted outright instead of being trashed");
			} else {
				// The record travels inside the directory, so provenance survives the
				// move — including a Windows recycle, whose bin this plugin cannot read.
				const recordPath = path.join(directory, TRASH_RECORD);
				await fs.writeFile(recordPath, `${JSON.stringify({
					sessionId: String(header.id),
					title: title ?? null,
					cwd: header.cwd ?? null,
					createdAt: header.createdAt ?? null,
					deletedAt: new Date(at).toISOString(),
					originalDirectory: directory,
					bytes: measured.bytes,
					files: measured.files,
					backend: backend.detail
				}, null, 2)}\n`, "utf8");
				const entryName = trashEntryName(String(header.id), at);
				try {
					const placement = await backend.place(directory, entryName, at);
					trashedTo = placement?.entry ?? null;
					moved = true;
					// A trash most platforms will not let a process enumerate (macOS)
					// is still restorable through this record; a Windows recycle has no
					// path to record, so it is skipped and restored by hand.
					if (typeof trashedTo === "string" && trashedTo.length > 0) {
						try {
							await index?.remember({
								name: entryName,
								sessionId: String(header.id),
								entry: trashedTo,
								backend: backend.detail,
								originalDirectory: directory,
								deletedAt: new Date(at).toISOString(),
								title: title ?? null,
								cwd: header.cwd ?? null,
								bytes: measured.bytes,
								files: measured.files
							});
						} catch (error) {
							notes.push(`the restore index could not be written (${errorMessage(error)}); restoring falls back to the trash's own listing`);
						}
					}
				} catch (error) {
					// Leave the Session exactly as it was: an unusable trash must not
					// half-delete a log.
					await fs.rm(recordPath, { force: true }).catch(() => undefined);
					throw sessionDeleteError(
						SESSION_DELETE_CODES.failed,
						`cannot delete session "${sessionId}": ${backend.describe()} refused it (${errorMessage(error)})`,
						{ sessionId, backend: backend.detail, destination: backend.describe() }
					);
				}
			}
		}
		await host.detachAccounting(sessionId);
		await host.dropCaches(sessionId);
		host.announceRemoved(sessionId);
		return {
			sessionId: String(header.id),
			title,
			cwd: header.cwd ?? null,
			live,
			running,
			stopped,
			moved,
			purged,
			backend: backend.kind,
			detail: backend.detail,
			trashedTo,
			trashRoot: backend.kind === "directory" ? backend.describe() : null,
			originalDirectory: directory ?? null,
			bytes: measured.bytes,
			files: measured.files,
			notes
		};
	}

	/**
	 * Every known trash entry for one Session, newest first.
	 *
	 * Two sources are merged: the restore index (a direct path, the only source
	 * on a trash the process cannot list) and the backend's own listing (the only
	 * source when the index was lost or never written). The index wins for a path
	 * they share, because it also carries the original directory.
	 */
	async function entries(sessionId) {
		const prefix = `${encodeSegment(sessionId)}-`;
		const known = new Map();
		for (const item of await (index?.list(prefix) ?? [])) {
			const entry = item.record?.entry;
			if (typeof entry !== "string" || entry.length === 0) continue;
			known.set(entry, { entry, name: item.name, record: item.record });
		}
		for (const entry of await backend.list(prefix)) {
			if (known.has(entry)) continue;
			let record;
			try {
				record = JSON.parse(await fs.readFile(path.join(entry, TRASH_RECORD), "utf8"));
			} catch {
				record = undefined;
			}
			known.set(entry, { entry, name: path.basename(entry), record });
		}
		return [...known.values()].sort((left, right) => right.name.localeCompare(left.name));
	}

	/**
	 * Restore one trashed Session directory to its original location.
	 *
	 * @param {object} request - restore request.
	 * @param {string} request.sessionId - Session identity.
	 * @returns the restore summary.
	 */
	async function restore({ sessionId }) {
		if (typeof sessionId !== "string" || sessionId.length === 0) {
			throw sessionDeleteError(SESSION_DELETE_CODES.badRequest, "session restore requires a non-empty sessionId", { field: "sessionId" });
		}
		const found = await entries(sessionId);
		if (found.length === 0) {
			const hint = backend.detail === "recycle-bin"
				? "the Recycle Bin keeps no readable entry: open it and restore the folder by hand"
				: "it may have been emptied, or put back already";
			throw sessionDeleteError(SESSION_DELETE_CODES.restoreMissing, `session "${sessionId}" has no entry in ${backend.describe()} — ${hint}`, { sessionId, backend: backend.detail });
		}
		let empty = 0;
		for (const candidate of found) {
			if (!await exists(candidate.entry)) {
				// The user emptied the trash, or moved the entry elsewhere.
				await index?.forget(candidate.name).catch(() => undefined);
				empty += 1;
				continue;
			}
			const target = candidate.record?.originalDirectory;
			if (typeof target !== "string" || target.length === 0) {
				empty += 1;
				continue;
			}
			if (await exists(target)) {
				throw sessionDeleteError(SESSION_DELETE_CODES.restoreConflict, `cannot restore session "${sessionId}": '${target}' already exists`, { sessionId, target });
			}
			await fs.mkdir(path.dirname(target), { recursive: true });
			const move = await backend.takeBack(candidate.entry, target);
			await index?.forget(candidate.name).catch(() => undefined);
			// The provenance record has done its job; a restored Session directory
			// holds only what the session store expects.
			await fs.rm(path.join(target, TRASH_RECORD), { force: true }).catch(() => undefined);
			return {
				sessionId,
				restoredTo: target,
				from: candidate.entry,
				move,
				note: "the Session is readable again after the Workspace registry next indexes stored headers (a reload, or the next launch)"
			};
		}
		const hint = backend.detail === "recycle-bin"
			? "the Recycle Bin keeps no readable entry: open it and restore the folder by hand"
			: `its ${empty} recorded entr${empty === 1 ? "y" : "ies"} no longer exist in ${backend.describe()} — it was emptied, or the folder was moved away`;
		throw sessionDeleteError(SESSION_DELETE_CODES.restoreMissing, `session "${sessionId}" cannot be restored: ${hint}`, { sessionId, backend: backend.detail });
	}

	return { remove, restore, entries, sessionDirectory, resolveHeader, backend };
}

/** Human-readable activity summary for failure details. */
export function describeActivity(activity) {
	return activity
		.map((item) => (item !== null && typeof item === "object" && typeof item.kind === "string" ? item.kind : String(item)))
		.join(", ");
}

/** One error message, whatever was thrown. */
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
