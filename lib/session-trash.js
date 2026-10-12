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
 *  2. move the Session's own directory out of the persistence corpus into a
 *     trash directory beside `$DSH_HOME/sessions`, so the session disappears
 *     from every listing while its bytes stay recoverable;
 *  3. drop the Session from Workspace accounting and from the registry-global
 *     archive/pin sets, and drop its projection-cache record;
 *  4. announce `api-session/removed` so every connected browser drops the row.
 *
 * This module owns steps 1-4 with no imports beyond `node:fs`/`node:path`:
 * every host capability arrives through the adapter the plugin builds, which
 * keeps the logic unit-testable without a DSH runtime.
 *
 * @module dsh-session-delete/session-trash
 */

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

/** One trash entry's durable record, written next to the moved Session directory. */
export const TRASH_RECORD = "trash.json";

/** Deterministic, filesystem-safe trash entry name for one deletion. */
export function trashEntryName(sessionId, at) {
	const stamp = new Date(at).toISOString().replace(/[:.]/g, "-");
	return `${encodeSegment(sessionId)}-${stamp}`;
}

/**
 * Create the trash operations over one host adapter.
 *
 * @param {object} options - wiring.
 * @param {object} options.fs - `node:fs/promises` (or an equivalent test double).
 * @param {object} options.path - `node:path`.
 * @param {string | (() => string)} options.trashRoot - absolute trash directory, or a
 *   resolver for a composition whose persistence backend mounts later.
 * @param {object} options.host - live host adapter (see {@link createHostAdapter}).
 * @param {() => number} [options.now] - clock, injectable for tests.
 * @returns the trash operations.
 */
export function createSessionTrash({ fs, path, trashRoot, host, now = () => Date.now() }) {
	/** The trash directory named right now (the resolver may depend on a late service). */
	const rootOf = () => (typeof trashRoot === "function" ? trashRoot() : trashRoot);
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

	/** Move a directory, falling back to copy+remove across filesystem boundaries. */
	async function moveDirectory(from, to) {
		try {
			await fs.rename(from, to);
			return "renamed";
		} catch (error) {
			if (error?.code !== "EXDEV") throw error;
			await fs.cp(from, to, { recursive: true });
			await fs.rm(from, { recursive: true, force: true });
			return "copied";
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
	 * Delete one Session by moving its directory into the trash.
	 *
	 * @param {object} request - deletion request.
	 * @param {string} request.sessionId - Session identity.
	 * @param {boolean} [request.stopActivity] - cancel live work instead of refusing.
	 * @param {boolean} [request.force] - proceed although the Session is still resident.
	 * @param {boolean} [request.purge] - remove the trashed bytes immediately.
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
		let trashedTo;
		let moved = false;
		let measured = { bytes: 0, files: 0 };
		if (directory === undefined) {
			notes.push("no session directory could be resolved; only accounting and caches were cleaned");
		} else if (!await exists(directory)) {
			notes.push(`session directory '${directory}' was already absent; only accounting and caches were cleaned`);
		} else {
			measured = await measure(directory);
			const root = rootOf();
			const entry = path.join(root, trashEntryName(String(header.id), now()));
			await fs.mkdir(root, { recursive: true });
			const how = await moveDirectory(directory, entry);
			moved = true;
			trashedTo = entry;
			await fs.writeFile(path.join(entry, TRASH_RECORD), `${JSON.stringify({
				sessionId: String(header.id),
				title: title ?? null,
				cwd: header.cwd ?? null,
				createdAt: header.createdAt ?? null,
				deletedAt: new Date(now()).toISOString(),
				originalDirectory: directory,
				bytes: measured.bytes,
				files: measured.files,
				move: how
			}, null, 2)}\n`, "utf8");
			if (purge) {
				await fs.rm(entry, { recursive: true, force: true });
				notes.push("purge requested: the trashed bytes were removed immediately");
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
			purged: purge && moved,
			trashedTo: trashedTo ?? null,
			trashRoot: rootOf(),
			originalDirectory: directory ?? null,
			bytes: measured.bytes,
			files: measured.files,
			notes
		};
	}

	/** Every trash entry for one Session, newest first. */
	async function entries(sessionId) {
		let names;
		try {
			names = await fs.readdir(rootOf());
		} catch {
			return [];
		}
		const prefix = `${encodeSegment(sessionId)}-`;
		const found = [];
		for (const name of names) {
			if (!name.startsWith(prefix)) continue;
			const entry = path.join(rootOf(), name);
			let record;
			try {
				record = JSON.parse(await fs.readFile(path.join(entry, TRASH_RECORD), "utf8"));
			} catch {
				record = undefined;
			}
			found.push({ entry, name, record });
		}
		return found.sort((left, right) => right.name.localeCompare(left.name));
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
			throw sessionDeleteError(SESSION_DELETE_CODES.restoreMissing, `session "${sessionId}" has no trash entry under '${rootOf()}'`, { sessionId, trashRoot: rootOf() });
		}
		const [newest] = found;
		const target = newest.record?.originalDirectory;
		if (typeof target !== "string" || target.length === 0) {
			throw sessionDeleteError(SESSION_DELETE_CODES.restoreMissing, `trash entry '${newest.entry}' carries no original directory to restore into`, { sessionId, entry: newest.entry });
		}
		if (await exists(target)) {
			throw sessionDeleteError(SESSION_DELETE_CODES.restoreConflict, `cannot restore session "${sessionId}": '${target}' already exists`, { sessionId, target });
		}
		await fs.mkdir(path.dirname(target), { recursive: true });
		const how = await moveDirectory(newest.entry, target);
		return {
			sessionId,
			restoredTo: target,
			from: newest.entry,
			move: how,
			note: "the Session is readable again after the Workspace registry next indexes stored headers (a reload, or the next launch)"
		};
	}

	return { remove, restore, entries, sessionDirectory, resolveHeader, trashRoot: rootOf };
}

/** Human-readable activity summary for failure details. */
export function describeActivity(activity) {
	return activity
		.map((item) => (item !== null && typeof item === "object" && typeof item.kind === "string" ? item.kind : String(item)))
		.join(", ");
}
