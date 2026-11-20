/**
 * dsh-session-delete client half.
 *
 * Hand-written browser module in the `window.__ModuleLoader__.load({ id,
 * factory })` shape every DSH client half uses; the id is this package's name,
 * which is also the id `client-modules` serves the bundle under. It requires
 * only `react` and the shared UI primitives — both are vendored into the Web
 * module table — and reaches every other capability through the Cordis context
 * it is handed by the composition.
 *
 * What it contributes:
 *  - a `sidebar.workspaces.session.menu.item` row that deletes on click;
 *  - a `shell.overlay` toast that reports the outcome;
 *  - the `session-delete` locale namespace for the two built-in languages.
 */
window.__ModuleLoader__.load({
	id: "dsh-session-delete",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const h = React.createElement;

		/** Locale namespace this plugin's slot entries translate through. */
		const NS = "session-delete";

		const DICTS = {
			en: {
				"menu.delete": "Delete session",
				"toast.deleting": "Deleting “{title}”…",
				"toast.deletedSystem": "Session “{title}” moved to the system trash",
				"toast.deleted": "Session “{title}” moved to {trash}",
				"toast.deletedNoPath": "Session “{title}” moved to the trash",
				"toast.logAlreadyGone": "Session “{title}” had no log left on disk; only its workspace and cache entries were removed",
				"toast.failed": "Could not delete “{title}”: {message}",
				"toast.failedUnknown": "Could not delete “{title}”: unknown error.",
				"toast.active": "Could not delete “{title}”: its running turn did not stop in time.",
				"toast.live": "Could not delete “{title}”: it is still in use.",
				"toast.notFound": "Session “{title}” was already gone."
			},
			zh: {
				"menu.delete": "删除会话",
				"toast.deleting": "正在删除「{title}」…",
				"toast.deletedSystem": "会话「{title}」已移入系统回收站",
				"toast.deleted": "会话「{title}」已移入 {trash}",
				"toast.deletedNoPath": "会话「{title}」已移入回收站",
				"toast.logAlreadyGone": "会话「{title}」已无日志,只清理了登记与缓存",
				"toast.failed": "会话「{title}」删除失败:{message}",
				"toast.failedUnknown": "会话「{title}」删除失败,原因未知。",
				"toast.active": "会话「{title}」删除失败:运行中的回合未能在限定时间内停止。",
				"toast.live": "会话「{title}」删除失败:它仍在使用中。",
				"toast.notFound": "会话「{title}」已不存在,可能已被删除。"
			}
		};

		/**
		 * Install this plugin's locale dictionaries exactly once per live mount.
		 *
		 * `locale.register()` hands back a disposer and owns nothing itself, so a
		 * registration that is not attached to a fiber survives the mount that made it.
		 * The client module system replaces a row by disposing the old fiber and
		 * re-evaluating this module, which would then fail with
		 * `locale namespace "session-delete" already has locale "en"` and take the
		 * whole plugin down with it. Two guards prevent that:
		 *
		 *  - the dictionaries are registered through `ctx.effect`, so teardown withdraws them;
		 *  - a live probe keeps a re-apply safe even if an earlier generation has not been
		 *    torn down yet (its dictionaries describe the same keys, so they are reused).
		 *
		 * @param ctx - client Cordis context carrying the locale face.
		 */
		function installLocale(ctx) {
			const locale = ctx.locale;
			if (locale === undefined || typeof locale.register !== "function") return;
			try {
				if (typeof locale.bind === "function" && locale.bind(NS)("menu.delete") !== "menu.delete") return;
			} catch {
				/* an unreadable locale face is not a reason to skip the registration */
			}
			try {
				ctx.effect(() => locale.register(NS, DICTS), "dsh-session-delete: locale namespace");
			} catch (error) {
				console.warn("dsh-session-delete: locale namespace is already registered by an earlier mount; reusing it", error);
			}
		}

		/**
		 * The toast queue. Deletion is fire-and-forget from the menu row, so the
		 * overlay is where every outcome is announced; a queue keeps two quick
		 * deletions from overwriting each other's message.
		 */
		let toasts = [];
		let toastSequence = 0;
		const toastListeners = new Set();
		const notifyToasts = () => {
			for (const listener of [...toastListeners]) listener();
		};
		const subscribeToasts = (listener) => {
			toastListeners.add(listener);
			return () => {
				toastListeners.delete(listener);
			};
		};
		const readToasts = () => toasts;
		const useToasts = () => React.useSyncExternalStore(subscribeToasts, readToasts, readToasts);
		/** Append one toast and return its id. */
		const pushToast = (entry) => {
			const toast = { id: ++toastSequence, ...entry };
			toasts = [...toasts, toast];
			notifyToasts();
			return toast.id;
		};
		/**
		 * Swap one queued toast for its outcome (a new id remounts the Toast, so its
		 * dismissal timer restarts). A toast the user already dismissed is re-queued
		 * instead, because losing the outcome is worse than seeing it a little later.
		 */
		const settleToast = (id, entry) => {
			const shown = toasts.some((toast) => toast.id === id);
			const replacement = { id: ++toastSequence, ...entry };
			toasts = shown ? toasts.map((toast) => (toast.id === id ? replacement : toast)) : [...toasts, replacement];
			notifyToasts();
		};
		const shiftToast = () => {
			if (toasts.length === 0) return;
			toasts = toasts.slice(1);
			notifyToasts();
		};

		/** Sessions whose deletion is already in flight, so a double click cannot race it. */
		const deleting = new Set();

		/** The title shown for one Session, falling back to its id. */
		const titleOf = (request) => {
			const title = request?.displayTitle;
			return typeof title === "string" && title.length > 0 ? title : request?.sessionId ?? "";
		};

		/**
		 * The text one successful deletion raises.
		 *
		 * The Host reports whether the log actually moved (`moved`) and which trash took
		 * it (`backend`: the platform's own, or a directory this profile configured).
		 * Claiming a move that did not happen is how a user ends up staring at an empty
		 * directory, so an already-absent log says exactly that, and a real move names
		 * where to look — the system trash needs no path, a configured directory does.
		 *
		 * @param t - locale seat of this plugin's namespace.
		 * @param request - the deletion request the call settled.
		 * @param value - the Host's deletion summary.
		 * @returns the toast text.
		 */
		function successMessage(t, request, value) {
			const title = titleOf(request);
			if (value?.moved !== true) return t("toast.logAlreadyGone", { title });
			if (value?.backend === "system") return t("toast.deletedSystem", { title });
			const trash = typeof value?.trashRoot === "string" ? value.trashRoot : "";
			return trash.length > 0 ? t("toast.deleted", { title, trash }) : t("toast.deletedNoPath", { title });
		}

		/** The text of one queue entry, localized at render time. */
		function toastText(t, entry) {
			const title = titleOf(entry.request);
			if (entry.kind === "pending") return t("toast.deleting", { title });
			if (entry.kind === "error") {
				// The common refusals get a short localized sentence; anything else
				// keeps the Host's own detail, which is the only useful part there.
				if (entry.code === "session/delete-active") return t("toast.active", { title });
				if (entry.code === "session/delete-live") return t("toast.live", { title });
				if (entry.code === "session/not-found") return t("toast.notFound", { title });
				const detail = typeof entry.message === "string" && entry.message.length > 0 ? entry.message : null;
				return detail === null ? t("toast.failedUnknown", { title }) : t("toast.failed", { title, message: detail });
			}
			return successMessage(t, entry.request, entry.value);
		}

		/**
		 * Delete one Session right away and queue the outcome as a toast.
		 *
		 * The click is the decision: `stopActivity` stops a running turn and `force`
		 * covers the Session the host still has in memory (typically the one open),
		 * so the row never falls back to a second "are you sure" step. Everything the
		 * Host did — moved, stopped, or refused — is reported afterwards.
		 *
		 * @param request - the Session identity and display title.
		 * @param deleteSession - the mounted `remote.sessionDelete.delete` call.
		 */
		async function deleteNow(request, deleteSession) {
			if (request === null || deleting.has(request.sessionId)) return;
			deleting.add(request.sessionId);
			// The pending toast is not a confirmation: the deletion is already under
			// way. It exists so a Session whose turn has to stop first does not look
			// like a no-op for the seconds that takes.
			const toastId = pushToast({ kind: "pending", request });
			try {
				const result = await deleteSession({ sessionId: request.sessionId, stopActivity: true, force: true });
				if (result?.ok === true) {
					settleToast(toastId, { kind: "success", request, value: result.value });
					return;
				}
				settleToast(toastId, {
					kind: "error",
					request,
					code: typeof result?.error?.code === "string" ? result.error.code : undefined,
					message: typeof result?.error?.message === "string" ? result.error.message : ""
				});
			} catch (error) {
				settleToast(toastId, { kind: "error", request, message: String(error?.message ?? error) });
			} finally {
				deleting.delete(request.sessionId);
			}
		}

		/**
		 * One menu row in a Session's "…" menu: the whole deletion flow.
		 * @param props - owner share (`sessionId`, `displayTitle`), the menu open state,
		 * the injected Remote call, and the locale seat.
		 * @returns the row.
		 */
		function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, t, deleteSession }) {
			const [, setMenuOpen] = useMenuOpenState();
			return h(primitives.MenuItemButton, {
				icon: h(primitives.IconTrashOutlineRegular, { size: 14 }),
				onSelect: () => {
					setMenuOpen(false);
					void deleteNow({ sessionId, displayTitle }, deleteSession);
				},
				children: t("menu.delete")
			});
		}

		/**
		 * The `shell.overlay` entry: the head of the toast queue, or nothing.
		 * @param props - the locale seat.
		 * @returns the toast, or null.
		 */
		function DeleteSessionToast({ t }) {
			const queue = useToasts();
			const entry = queue[0] ?? null;
			if (entry === null) return null;
			const appearance = entry.kind === "pending"
				? { holdMs: 20000 }
				: entry.kind === "error"
					? { icon: h(primitives.IconWarningOutlineRegular), holdMs: 6000 }
					: { tone: "success" };
			return h(primitives.Toast, {
				key: entry.id,
				text: toastText(t, entry),
				...appearance,
				onDone: shiftToast
			});
		}

		/**
		 * Mount the Remote contribution, the locale namespace, and the two slot entries.
		 * @param ctx - client Cordis context.
		 */
		async function apply(ctx) {
			installLocale(ctx);
			const mount = async () => {
				const remote = ctx.remote;
				if (remote === undefined || typeof remote.$mount !== "function") return undefined;
				// A surviving earlier mount already owns the namespace: mounting the same
				// contribution twice is refused by the Gateway, and the existing methods
				// are the same ones this generation would install.
				if (ctx.get("remote.sessionDelete") !== undefined) return undefined;
				return await remote.$mount({
					package: "dsh-session-delete",
					descriptors: [
						{
							id: "dsh-session-delete#sessionDelete/delete",
							service: "sessionDelete",
							namespace: "sessionDelete",
							method: "delete",
							invocation: { kind: "direct" },
							parameters: [{
								name: "request",
								wire: "request",
								source: "json",
								codec: { mode: "strict", typeSymbol: "dsh-session-delete/types#SessionDeleteRequest", create: () => ({ parse: (value) => value }) }
							}],
							cancellation: { parameter: "signal" },
							result: { mode: "strict", typeSymbol: "dsh-session-delete/types#SessionDeleteResult", create: () => ({ parse: (value) => value }) }
						},
						{
							id: "dsh-session-delete#sessionDelete/restore",
							service: "sessionDelete",
							namespace: "sessionDelete",
							method: "restore",
							invocation: { kind: "direct" },
							parameters: [{
								name: "request",
								wire: "request",
								source: "json",
								codec: { mode: "strict", typeSymbol: "dsh-session-delete/types#SessionRestoreRequest", create: () => ({ parse: (value) => value }) }
							}],
							result: { mode: "strict", typeSymbol: "dsh-session-delete/types#SessionRestoreResult", create: () => ({ parse: (value) => value }) }
						}
					]
				});
			};
			const unmount = await mount();
			// Hand the async disposer over verbatim: a fiber teardown awaits it, which is
			// what keeps the next mount from racing the previous unmount.
			if (unmount !== undefined) ctx.effect(() => unmount, "dsh-session-delete: remote contribution");
			const deleteSession = async (request) => {
				const service = ctx.get("remote.sessionDelete");
				if (service === undefined) throw new Error("remote.sessionDelete is not mounted");
				return await service.delete(request);
			};
			const slots = ctx.slots;
			if (slots === undefined) return;
			ctx.effect(() => slots.inject("sidebar.workspaces.session.menu.item", function* () {
				yield slots.register({
					name: "sidebar.workspaces.session.menu.item",
					id: "session-delete",
					order: 500,
					locale: NS,
					inject: () => ({ deleteSession })
				}, DeleteSessionMenuItem);
			}), "dsh-session-delete: session menu row");
			ctx.effect(() => slots.inject("shell.overlay", function* () {
				yield slots.register({
					name: "shell.overlay",
					id: "session-delete-toast",
					locale: NS
				}, DeleteSessionToast);
			}), "dsh-session-delete: result toasts");
		}

		exports.apply = apply;
		exports.inject = ["remote", "slots", "locale"];
		return module.exports;
	}
});
