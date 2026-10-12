/**
 * Typert manifest for the `sessionDelete` host face.
 *
 * Written by hand in the shape `@deepseek-ai/dsh-typert-generator` emits, so
 * `typert-loader` registers it when this package's loader entry mounts: strict
 * codecs describe the wire boundary the Gateway validates, and `model` is the
 * documentation the service catalog reads. The codecs are deliberately plain
 * objects exposing `parse()` — this package imports no schema library, because
 * a third-party plugin cannot resolve `zod`/`schemastery` from the DSH tree.
 *
 * @module dsh-session-delete/typert
 */

const PACKAGE = "dsh-session-delete";

/** Reject anything that is not a plain JSON object. */
function requireObject(value, subject) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${subject} must be an object`);
	return value;
}

/** Reject unknown request fields: the boundary accepts exactly the declared wire fields. */
function rejectUnknown(value, allowed, subject) {
	for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`${subject} has an unexpected field ${JSON.stringify(key)}`);
}

/** Require an optional boolean field. */
function optionalBoolean(value, key, subject) {
	if (value[key] === undefined) return undefined;
	if (typeof value[key] !== "boolean") throw new TypeError(`${subject}.${key} must be a boolean`);
	return value[key];
}

/** Require a non-empty session id. */
function requireSessionId(holder, subject) {
	if (typeof holder.sessionId !== "string" || holder.sessionId.length === 0) throw new TypeError(`${subject}.sessionId must be a non-empty string`);
	return holder.sessionId;
}

/** Strict codec for the `delete` request. */
const deleteRequestCodec = {
	mode: "strict",
	typeSymbol: `${PACKAGE}/types#SessionDeleteRequest`,
	create: () => ({
		parse(value) {
			const request = requireObject(value, "sessionDelete.delete request");
			rejectUnknown(request, ["sessionId", "stopActivity", "force", "purge"], "sessionDelete.delete request");
			const parsed = { sessionId: requireSessionId(request, "sessionDelete.delete request") };
			for (const key of ["stopActivity", "force", "purge"]) {
				const flag = optionalBoolean(request, key, "sessionDelete.delete request");
				if (flag !== undefined) parsed[key] = flag;
			}
			return parsed;
		}
	})
};

/** Strict codec for the `restore` request. */
const restoreRequestCodec = {
	mode: "strict",
	typeSymbol: `${PACKAGE}/types#SessionRestoreRequest`,
	create: () => ({
		parse(value) {
			const request = requireObject(value, "sessionDelete.restore request");
			rejectUnknown(request, ["sessionId"], "sessionDelete.restore request");
			return { sessionId: requireSessionId(request, "sessionDelete.restore request") };
		}
	})
};

/** Result codec that passes the handler's own value through unchanged. */
function passthroughResultCodec(typeSymbol) {
	return {
		mode: "strict",
		typeSymbol,
		create: () => ({ parse: (value) => value })
	};
}

export const TYPERT = {
	package: PACKAGE,
	face: "host",
	schemas: [],
	invocations: [
		{
			id: `${PACKAGE}#sessionDelete/delete`,
			service: "sessionDelete",
			namespace: "sessionDelete",
			method: "delete",
			invocation: { kind: "direct" },
			parameters: [{
				name: "request",
				wire: "request",
				source: "json",
				codec: deleteRequestCodec
			}],
			cancellation: { parameter: "signal" },
			result: passthroughResultCodec(`${PACKAGE}#sessionDelete/delete:result`)
		},
		{
			id: `${PACKAGE}#sessionDelete/restore`,
			service: "sessionDelete",
			namespace: "sessionDelete",
			method: "restore",
			invocation: { kind: "direct" },
			parameters: [{
				name: "request",
				wire: "request",
				source: "json",
				codec: restoreRequestCodec
			}],
			result: passthroughResultCodec(`${PACKAGE}#sessionDelete/restore:result`)
		}
	],
	model: {
		services: [{
			key: "sessionDelete",
			exportName: "SessionDelete",
			description: "Host service backing the generated `ctx.remote.sessionDelete` namespace: it moves one Session's durable log into a local trash directory and drops the registrations that named it.",
			summary: "Host service backing the generated `ctx.remote.sessionDelete` namespace.",
			jsDoc: "/** Host service backing the generated `ctx.remote.sessionDelete` namespace. */",
			tags: [],
			members: [
				{
					kind: "method",
					name: "delete",
					signature: "delete(request: SessionDeleteRequest, signal: AbortSignal): Promise<SessionDeleteResult>",
					summary: "Delete one Session into the trash, stopping its work first when asked.",
					jsDoc: "/**\n * Delete one Session: stop its live work when `stopActivity` is set, then move\n * the Session's own directory out of the persistence corpus into the trash\n * directory, drop its Workspace accounting, archive entry, pin entry, and\n * projection-cache record, and announce `api-session/removed`.\n * @param request - Session identity and deletion policy.\n * @param signal - caller lifetime; aborts the wait for running work to stop.\n * @returns the deletion summary.\n */"
				},
				{
					kind: "method",
					name: "restore",
					signature: "restore(request: SessionRestoreRequest): Promise<SessionRestoreResult>",
					summary: "Move one trashed Session directory back to where the store expects it.",
					jsDoc: "/**\n * Restore one trashed Session directory to its recorded original location.\n * @param request - Session identity to restore.\n * @returns the restore summary, including where the log was put back.\n */"
				}
			],
			types: [
				{
					name: "SessionDeleteRequest",
					declaration: "export interface SessionDeleteRequest {\n    readonly sessionId: string;\n    readonly stopActivity?: boolean;\n    readonly force?: boolean;\n    readonly purge?: boolean;\n}"
				},
				{
					name: "SessionDeleteResult",
					declaration: "export interface SessionDeleteResult {\n    readonly sessionId: string;\n    readonly title?: string;\n    readonly live: boolean;\n    readonly running: boolean;\n    readonly stopped: boolean;\n    readonly moved: boolean;\n    readonly purged: boolean;\n    readonly trashedTo: string | null;\n    readonly trashRoot: string;\n    readonly originalDirectory: string | null;\n    readonly bytes: number;\n    readonly files: number;\n    readonly notes: readonly string[];\n}"
				},
				{
					name: "SessionRestoreRequest",
					declaration: "export interface SessionRestoreRequest {\n    readonly sessionId: string;\n}"
				},
				{
					name: "SessionRestoreResult",
					declaration: "export interface SessionRestoreResult {\n    readonly sessionId: string;\n    readonly restoredTo: string;\n    readonly from: string;\n    readonly note: string;\n}"
				}
			]
		}],
		events: [],
		objects: []
	}
};

export default TYPERT;
