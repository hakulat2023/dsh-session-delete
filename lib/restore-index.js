/**
 * The restore index: how a trashed Session is found again.
 *
 * Deleting to a trash the user owns creates one problem the plugin's own trash
 * directory never had — **some platforms do not let a process enumerate it**.
 * macOS is the concrete case: a rename into `~/.Trash` succeeds, a known child
 * path can be read, a rename back out succeeds, but `readdir('~/.Trash')` is
 * refused by TCC ("Operation not permitted"). A restore that starts by listing
 * the trash therefore cannot work there.
 *
 * So every deletion also writes one small record — the entry name, where the
 * entry went, and the directory it came from — under the plugin's own data
 * directory. It holds **no Session content**: the log stays in the user's trash,
 * where emptying it stays the user's decision. The index is what makes
 * `session_restore` a direct path operation instead of a search.
 *
 * A missing, unreadable, or stale index never blocks anything: deletion ignores
 * a failed write (and says so in its notes), and restore falls back to whatever
 * the backend itself can list.
 *
 * @module dsh-session-delete/restore-index
 */

/**
 * Create the restore index over one root directory.
 *
 * @param {object} options - wiring.
 * @param {object} options.fs - `node:fs/promises`.
 * @param {object} options.path - `node:path`.
 * @param {string | (() => string)} options.root - absolute data directory, or its resolver.
 * @returns the index operations.
 */
export function createRestoreIndex({ fs, path, root }) {
	const rootOf = () => (typeof root === "function" ? root() : root);
	const entriesDir = () => {
		const at = rootOf();
		return typeof at === "string" && at.length > 0 ? path.join(at, "entries") : undefined;
	};

	return {
		/**
		 * Record one trashed entry.
		 * @param {object} record - `{ name, sessionId, entry, ... }`; `name` is the entry name.
		 * @returns whether the record was written.
		 */
		async remember(record) {
			const dir = entriesDir();
			if (dir === undefined || typeof record?.name !== "string" || record.name.length === 0) return false;
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(path.join(dir, `${record.name}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
			return true;
		},
		/**
		 * Every recorded entry whose name starts with `prefix`, newest first.
		 * @param {string} prefix - entry-name prefix (one Session's encoded id plus a dash).
		 * @returns `{ name, record }` pairs; a corrupt record is skipped.
		 */
		async list(prefix) {
			const dir = entriesDir();
			if (dir === undefined) return [];
			let names;
			try {
				names = await fs.readdir(dir);
			} catch {
				return [];
			}
			const found = [];
			for (const name of names) {
				if (!name.endsWith(".json") || !name.startsWith(prefix)) continue;
				try {
					found.push({ name: name.slice(0, -".json".length), record: JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) });
				} catch {
					/* an unreadable record is one candidate the backend listing can still cover */
				}
			}
			return found.sort((left, right) => right.name.localeCompare(left.name));
		},
		/**
		 * Drop one record once its entry has been restored or has vanished.
		 * @param {string} name - entry name.
		 */
		async forget(name) {
			const dir = entriesDir();
			if (dir === undefined || typeof name !== "string" || name.length === 0) return;
			await fs.rm(path.join(dir, `${name}.json`), { force: true });
		}
	};
}
