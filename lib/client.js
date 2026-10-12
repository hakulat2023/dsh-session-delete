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
 *  - a `sidebar.workspaces.session.menu.item` row that opens a confirmation;
 *  - a `shell.overlay` dialog that performs the deletion over the
 *    `remote.sessionDelete` namespace and reports the outcome;
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
				"dialog.title": "Delete session",
				"dialog.close": "Close",
				"dialog.desc": "“{title}” will be moved into this machine's session trash. The session disappears from every list, and its workspace entry, archive flag, pin, and cached projections are dropped. The log itself stays recoverable inside the trash directory.",
				"dialog.descRunning": "“{title}” is running. Deleting stops its current turn first.",
				"dialog.descLive": "“{title}” is still resident in the harness process. Deleting abandons that in-memory copy; the log moves to the trash directory.",
				"dialog.descLiveRunning": "“{title}” is still running. Continuing stops its current turn and moves the log to the trash directory.",
				"dialog.cancel": "Cancel",
				"dialog.confirm": "Move to trash",
				"dialog.confirmLive": "Delete anyway",
				"dialog.busy": "Deleting…",
				"dialog.stopping": "Stopping the running session…",
				"dialog.failed": "Delete failed: {message}",
				"dialog.unknown": "Delete failed for an unknown reason.",
				"toast.deleted": "Session “{title}” moved to the trash",
				"toast.deletedUntitled": "Session moved to the trash"
			},
			zh: {
				"menu.delete": "删除会话",
				"dialog.title": "删除会话",
				"dialog.close": "关闭",
				"dialog.desc": "将把「{title}」移入本机的会话回收站。该会话会从所有列表消失,它的工作区登记、存档与置顶标记、投影缓存也会一并清除;日志文件仍保留在回收站目录中,可以手动找回。",
				"dialog.descRunning": "「{title}」正在运行,删除会先停止它当前正在执行的回合。",
				"dialog.descLive": "「{title}」仍驻留在宿主进程内存中(通常是已打开)。继续删除会让那份内存副本失效,日志则会被移入回收站。",
				"dialog.descLiveRunning": "「{title}」仍在运行。继续会先停止它当前正在执行的回合,再把日志移入回收站。",
				"dialog.cancel": "取消",
				"dialog.confirm": "移入回收站",
				"dialog.confirmLive": "仍然删除",
				"dialog.busy": "正在删除…",
				"dialog.stopping": "正在停止运行中的会话…",
				"dialog.failed": "删除失败:{message}",
				"dialog.unknown": "删除失败,原因未知。",
				"toast.deleted": "会话「{title}」已移入回收站",
				"toast.deletedUntitled": "会话已移入回收站"
			}
		};

		/** Danger styling for the destructive action, spelled with the theme token the shipped dialog uses. */
		const CSS = ".dsd-danger:not(:disabled){color:var(--dsw-alias-state-error-primary)}.dsd-status{margin-top:12px;font-size:13px;color:var(--dsw-alias-label-secondary,inherit)}.dsd-error{margin-top:12px;font-size:13px;color:var(--dsw-alias-state-error-primary)}";
		const styleId = "dsh-session-delete/client.css";
		if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css=${JSON.stringify(styleId)}]`) === null) {
			const style = document.createElement("style");
			style.dataset.pluginCss = styleId;
			style.textContent = CSS;
			document.head.appendChild(style);
		}

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

		/** One pending confirmation: the Session it targets plus its display title. */
		let pending = null;
		const pendingListeners = new Set();
		const subscribePending = (listener) => {
			pendingListeners.add(listener);
			return () => {
				pendingListeners.delete(listener);
			};
		};
		const readPending = () => pending;
		const setPending = (next) => {
			pending = next;
			for (const listener of [...pendingListeners]) listener();
		};
		const usePending = () => React.useSyncExternalStore(subscribePending, readPending, readPending);

		/** The title shown for one Session, falling back to its id. */
		const titleOf = (request) => {
			const title = request?.displayTitle;
			return typeof title === "string" && title.length > 0 ? title : request?.sessionId ?? "";
		};

		/**
		 * One menu row in a Session's "…" menu: the entry point of the deletion.
		 * @param props - owner share (`sessionId`, `displayTitle`), the menu open state, and the locale seat.
		 * @returns the row.
		 */
		function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, t }) {
			const [, setMenuOpen] = useMenuOpenState();
			return h(primitives.MenuItemButton, {
				icon: h(primitives.IconTrashOutlineRegular, { size: 14 }),
				onSelect: () => {
					setMenuOpen(false);
					setPending({ sessionId, displayTitle });
				},
				children: t("menu.delete")
			});
		}

		/**
		 * The `shell.overlay` entry: nothing while no deletion is pending, otherwise
		 * one dialog plus the success toast it may raise.
		 * @param props - the Remote hop and the locale seat.
		 * @returns the overlay tree, or null.
		 */
		function DeleteSessionDialog({ t, deleteSession }) {
			const request = usePending();
			const [phase, setPhase] = React.useState("confirm");
			const [message, setMessage] = React.useState(null);
			const [running, setRunning] = React.useState(false);
			const [toast, setToast] = React.useState(null);
			const sessionId = request?.sessionId ?? null;
			React.useEffect(() => {
				setPhase("confirm");
				setMessage(null);
				setRunning(false);
			}, [sessionId]);
			const run = async (force) => {
				if (request === null) return;
				setPhase(force ? "stopping" : "busy");
				setMessage(null);
				let result;
				try {
					result = await deleteSession({ sessionId: request.sessionId, stopActivity: true, force });
				} catch (error) {
					setPhase("error");
					setMessage(String(error?.message ?? error));
					return;
				}
				if (result?.ok === true) {
					const title = titleOf(request);
					setToast(t("toast.deleted", { title }));
					setPending(null);
					return;
				}
				const code = result?.error?.code;
				const failure = String(result?.error?.message ?? "");
				if (code === "session/delete-live") {
					setPhase("live");
					setMessage(failure);
					setRunning(result?.error?.details?.running === true);
					return;
				}
				if (code === "session/delete-active") {
					setPhase("running");
					setMessage(failure);
					return;
				}
				setPhase("error");
				setMessage(failure.length > 0 ? failure : null);
			};
			const busy = phase === "busy" || phase === "stopping";
			const close = () => {
				if (!busy) setPending(null);
			};
			const title = request === null ? "" : titleOf(request);
			const description = phase === "live"
				? t(running ? "dialog.descLiveRunning" : "dialog.descLive", { title })
				: phase === "running" || phase === "stopping"
					? t("dialog.descRunning", { title })
					: t("dialog.desc", { title });
			const confirmLabel = phase === "live" ? t("dialog.confirmLive") : t("dialog.confirm");
			return h(React.Fragment, null,
				request === null ? null : h(primitives.Modal, {
					open: true,
					onClose: close,
					title: t("dialog.title"),
					closeLabel: t("dialog.close"),
					description,
					children: h(React.Fragment, null,
						busy ? h("div", { className: "dsd-status", role: "status", children: phase === "stopping" ? t("dialog.stopping") : t("dialog.busy") }) : null,
						phase === "error" ? h("div", { className: "dsd-error", role: "alert", children: message === null ? t("dialog.unknown") : t("dialog.failed", { message }) }) : null,
						phase === "running" && message !== null ? h("div", { className: "dsd-error", role: "alert", children: message }) : null
					),
					footer: h(React.Fragment, null,
						h(primitives.Button, { variant: "outline", disabled: busy, onClick: close, children: t("dialog.cancel") }),
						h(primitives.Button, {
							variant: "outline",
							className: "dsd-danger",
							disabled: busy,
							onClick: () => {
								run(phase === "live");
							},
							children: confirmLabel
						})
					)
				}),
				toast === null ? null : h(primitives.Toast, { text: toast, onDone: () => setToast(null) })
			);
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
					locale: NS
				}, DeleteSessionMenuItem);
			}), "dsh-session-delete: session menu row");
			ctx.effect(() => slots.inject("shell.overlay", function* () {
				yield slots.register({
					name: "shell.overlay",
					id: "session-delete-confirm",
					locale: NS,
					inject: () => ({ deleteSession })
				}, DeleteSessionDialog);
			}), "dsh-session-delete: confirmation dialog");
		}

		exports.apply = apply;
		exports.inject = ["remote", "slots", "locale"];
		return module.exports;
	}
});
