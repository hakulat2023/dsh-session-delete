/**
 * Trash destinations.
 *
 * A deletion plugin should hand the Session directory to the **platform's own
 * trash**, not to a directory of its own invention: the user already knows where
 * the Finder's 废纸篓 / the XDG trash / the Recycle Bin is, and an emptied trash
 * stays the user's decision. Each backend here answers the same four questions,
 * so the deletion logic never branches on the platform:
 *
 *  - `place(directory, name, at)` — move the Session directory in, return where;
 *  - `list(prefix)` — the entry paths whose name starts with `prefix`;
 *  - `takeBack(entry, target)` — move one entry back out;
 *  - `discard(entry)` — delete one entry for good.
 *
 * Backends are filesystem-only and dependency-free, which is what lets this
 * package run its own tests without a build step:
 *
 * | Platform | Destination | Notes |
 * |---|---|---|
 * | macOS | `~/.Trash/<name>` | a rename on one volume, a copy otherwise (Finder shows it) |
 * | Linux | `$XDG_DATA_HOME/Trash/{files,info}` | the XDG trash spec, `.trashinfo` written for the desktop's own restore |
 * | Windows | the Recycle Bin | through PowerShell's `Microsoft.VisualBasic.FileIO`; the entry's location is not discoverable, so restore is manual |
 * | anything else | — | no system trash: the caller falls back to a plain directory |
 *
 * A `trash.json` record is written **inside** the directory before it moves, so
 * provenance travels with the entry (and survives a Windows recycle, where the
 * plugin cannot read the bin back).
 *
 * @module dsh-session-delete/trash
 */

/** Name of the provenance record written into each trashed directory. */
export const TRASH_RECORD = "trash.json";

/** Whether one path exists. */
async function exists(fs, target) {
	try {
		await fs.stat(target);
		return true;
	} catch {
		return false;
	}
}

/**
 * Move a directory, falling back to copy-and-remove across filesystems.
 * @returns `"renamed"` or `"copied"`.
 */
export async function moveEntry(fs, path, from, to) {
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

/** `YYYY-MM-DDTHH:mm:ss` in local time, the XDG `DeletionDate` spelling. */
export function localStamp(at) {
	const date = new Date(at);
	const pad = (value) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** The first free `<base>`, `<base><separator>2`, … name inside `dir`. */
async function freeName(fs, path, dir, base, separator) {
	for (let index = 1; index < 1000; index += 1) {
		const name = index === 1 ? base : `${base}${separator}${index}`;
		if (!await exists(fs, path.join(dir, name))) return name;
	}
	throw new Error(`no free trash entry name for ${JSON.stringify(base)} under ${JSON.stringify(dir)}`);
}

/** Entries of one trash directory whose name starts with `prefix`. */
async function listIn(fs, path, dir, prefix) {
	let names;
	try {
		names = await fs.readdir(dir);
	} catch {
		return [];
	}
	return names.filter((name) => name.startsWith(prefix)).map((name) => path.join(dir, name));
}

/**
 * A trash directory this plugin owns, used when no system trash applies and when
 * a profile asks for one explicitly.
 *
 * @param {object} options - wiring.
 * @param {object} options.fs - `node:fs/promises`.
 * @param {object} options.path - `node:path`.
 * @param {string | (() => string)} options.root - absolute directory (or its resolver).
 * @returns the backend.
 */
export function createDirectoryTrashBackend({ fs, path, root }) {
	const rootOf = () => (typeof root === "function" ? root() : root);
	return {
		kind: "directory",
		detail: "directory",
		describe: () => rootOf(),
		async place(directory, base) {
			const at = rootOf();
			if (typeof at !== "string" || at.length === 0) throw new Error("no directory trash root is configured");
			await fs.mkdir(at, { recursive: true });
			const name = await freeName(fs, path, at, base, " ");
			const entry = path.join(at, name);
			const move = await moveEntry(fs, path, directory, entry);
			return { entry, move };
		},
		list: (prefix) => listIn(fs, path, rootOf(), prefix),
		takeBack: (entry, target) => moveEntry(fs, path, entry, target),
		discard: async (entry) => {
			await fs.rm(entry, { recursive: true, force: true });
		}
	};
}

/** macOS: the per-user Trash directory Finder shows. */
function createMacosTrashBackend({ fs, path, home }) {
	const root = path.join(home, ".Trash");
	return {
		kind: "system",
		detail: "macos-trash",
		describe: () => "the system Trash",
		async place(directory, base) {
			await fs.mkdir(root, { recursive: true });
			const name = await freeName(fs, path, root, base, " ");
			const entry = path.join(root, name);
			const move = await moveEntry(fs, path, directory, entry);
			return { entry, move };
		},
		list: (prefix) => listIn(fs, path, root, prefix),
		takeBack: (entry, target) => moveEntry(fs, path, entry, target),
		discard: async (entry) => {
			await fs.rm(entry, { recursive: true, force: true });
		}
	};
}

/** Linux: the XDG trash directory, including the `.trashinfo` the desktop restores from. */
function createXdgTrashBackend({ fs, path, env, home }) {
	const dataHome = typeof env.XDG_DATA_HOME === "string" && env.XDG_DATA_HOME.length > 0
		? env.XDG_DATA_HOME
		: path.join(home, ".local", "share");
	const filesDir = path.join(dataHome, "Trash", "files");
	const infoDir = path.join(dataHome, "Trash", "info");
	return {
		kind: "system",
		detail: "xdg-trash",
		describe: () => "the system trash",
		async place(directory, base, at) {
			await fs.mkdir(filesDir, { recursive: true });
			await fs.mkdir(infoDir, { recursive: true });
			let name = base;
			for (let index = 2; await exists(fs, path.join(filesDir, name)) || await exists(fs, path.join(infoDir, `${name}.trashinfo`)); index += 1) {
				name = `${base}.${index}`;
			}
			const entry = path.join(filesDir, name);
			const move = await moveEntry(fs, path, directory, entry);
			// The desktop's own "restore" reads Path; a failure here only costs that
			// convenience, so it must not undo a completed move.
			await fs.writeFile(
				path.join(infoDir, `${name}.trashinfo`),
				`[Trash Info]\nPath=${encodeURIComponent(directory)}\nDeletionDate=${localStamp(at)}\n`,
				"utf8"
			);
			return { entry, move };
		},
		list: (prefix) => listIn(fs, path, filesDir, prefix),
		takeBack: async (entry, target) => {
			const move = await moveEntry(fs, path, entry, target);
			await fs.rm(path.join(infoDir, `${path.basename(entry)}.trashinfo`), { force: true });
			return move;
		},
		discard: async (entry) => {
			await fs.rm(entry, { recursive: true, force: true });
			await fs.rm(path.join(infoDir, `${path.basename(entry)}.trashinfo`), { force: true });
		}
	};
}

/** Windows: the Recycle Bin, through the one API a dependency-free plugin can reach. */
function createRecycleBinBackend({ run }) {
	return {
		kind: "system",
		detail: "recycle-bin",
		describe: () => "the system Recycle Bin",
		async place(directory) {
			const literal = String(directory).replaceAll("'", "''");
			await run("powershell.exe", [
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${literal}', 'OnlyErrorDialogs', 'SendToRecycleBin')`
			]);
			// The bin's own layout is not documented for consumers; the entry cannot be
			// read back, so `list` stays empty and restore is a manual action.
			return { entry: null, move: "recycled" };
		},
		list: async () => [],
		takeBack: async () => {
			throw new Error("the Recycle Bin cannot be restored programmatically; open it and restore by hand");
		},
		discard: async () => {
			throw new Error("the Recycle Bin cannot be emptied programmatically");
		}
	};
}

/**
 * The platform's own trash, when it has one.
 *
 * @param {object} options - wiring.
 * @param {object} options.fs - `node:fs/promises`.
 * @param {object} options.path - `node:path`.
 * @param {Record<string, string | undefined>} options.env - environment (HOME, XDG_DATA_HOME).
 * @param {string} options.home - the user's home directory.
 * @param {string} [options.platform] - `process.platform`.
 * @param {Function} [options.run] - `(file, args) => Promise<unknown>`, for the Windows path.
 * @returns the backend, or `undefined` on a platform without a system trash.
 */
export function createSystemTrashBackend({ fs, path, env = {}, home, platform = process.platform, run }) {
	if (typeof home !== "string" || home.length === 0) return undefined;
	if (platform === "darwin") return createMacosTrashBackend({ fs, path, home });
	if (platform === "linux") return createXdgTrashBackend({ fs, path, env, home });
	if (platform === "win32" && typeof run === "function") return createRecycleBinBackend({ run });
	return undefined;
}
