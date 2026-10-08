/**
 * Process-wide registry of workflow runs.
 *
 * It lives on globalThis, so a /reload (which loads a new copy of this
 * extension) keeps running workflows: the new copy binds itself as the host and
 * receives their results.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { DialogQueue, upgradeDialogQueue } from "./child-ui.ts";
import type { WorkflowRun } from "./run.ts";
import type { QuestionRecord } from "./types.ts";

export interface RegistryHost {
	onRunEnd(run: WorkflowRun): void;
	onQuestion(run: WorkflowRun, q: QuestionRecord): void;
	onQuestionClosed?(run: WorkflowRun, q: QuestionRecord): void;
	onWarning(run: WorkflowRun, text: string): void;
	canAsk(): boolean;
	/** The UI of the session that owns the runs now (undefined without UI). */
	ui(): ExtensionUIContext | undefined;
}

export interface Registry {
	runs: Map<string, WorkflowRun>;
	dialogs: DialogQueue;
	host?: RegistryHost;
	/** Sessions in which the user chose "auto-approve workflows for this session". */
	autoApprove: Set<string>;
	/** Serializes approval dialogs of parallel workflow calls. */
	approvalTail: Promise<unknown>;
	monitorOpen: boolean;
	listeners: Set<() => void>;
	changeTimer?: ReturnType<typeof setTimeout>;
}

const KEY = Symbol.for("pi-dynamic-workflows.registry.v1");

export function getRegistry(): Registry {
	const g = globalThis as unknown as Record<symbol, Registry | undefined>;
	let reg = g[KEY];
	if (!reg) {
		reg = {
			runs: new Map(),
			dialogs: new DialogQueue(),
			autoApprove: new Set(),
			approvalTail: Promise.resolve(),
			monitorOpen: false,
			listeners: new Set(),
		};
		reg.dialogs.onChange = () => changed(reg as Registry);
		g[KEY] = reg;
	} else if (!(reg.dialogs instanceof DialogQueue)) {
		upgradeDialogQueue(reg.dialogs);
	}
	return reg;
}

/** Notify UI listeners. Coalesced to about 12 updates per second. */
export function changed(reg: Registry = getRegistry()): void {
	if (reg.changeTimer) return;
	reg.changeTimer = setTimeout(() => {
		reg.changeTimer = undefined;
		for (const l of reg.listeners) {
			try {
				l();
			} catch {
				// A broken listener must not stop the others.
			}
		}
	}, 80);
}

export function onRegistryChange(fn: () => void): () => void {
	const reg = getRegistry();
	reg.listeners.add(fn);
	return () => reg.listeners.delete(fn);
}

export function addRun(run: WorkflowRun): void {
	const reg = getRegistry();
	reg.runs.set(run.id, run);
	run.subscribe({
		onChange: () => changed(reg),
		onEnd: (r) => {
			changed(reg);
			reg.host?.onRunEnd(r);
		},
		onQuestion: (r, q) => reg.host?.onQuestion(r, q),
		onQuestionClosed: (r, q) => {
			reg.host?.onQuestionClosed?.(r, q);
			changed(reg);
		},
		onWarning: (r, t) => reg.host?.onWarning(r, t),
		canAsk: () => reg.host?.canAsk() ?? false,
	});
	changed(reg);
}

export function runsOfSession(sessionId: string): WorkflowRun[] {
	return [...getRegistry().runs.values()].filter((r) => r.sessionId === sessionId).sort((a, b) => a.createdAt - b.createdAt);
}

export function activeRuns(sessionId?: string): WorkflowRun[] {
	return [...getRegistry().runs.values()].filter((r) => !r.isFinal && (!sessionId || r.sessionId === sessionId));
}

/** Run a function after all earlier approval dialogs closed. */
export function serializeApproval<T>(fn: () => Promise<T>): Promise<T> {
	const reg = getRegistry();
	const next = reg.approvalTail.then(fn, fn);
	reg.approvalTail = next.catch(() => undefined);
	return next;
}
