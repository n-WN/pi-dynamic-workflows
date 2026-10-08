/**
 * UI context for workflow agents.
 *
 * Extensions loaded in an agent session (permission gates, for example) can ask
 * questions with select/confirm/input/editor. The proxy forwards those dialogs
 * to the human, one at a time, with the run and agent in the title, and marks the
 * agent as waiting. Everything else (widgets, footer, editor) is a no-op: an agent
 * has no screen of its own.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export interface DialogRequest {
	kind: "select" | "confirm" | "input" | "editor";
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	/** Who asks: "audit-routes #17 src/routes/admin.ts". */
	source: string;
	runId?: string;
	agentId?: number;
	/** Set for ask() questions of a script (the run answers them, not a tool). */
	questionId?: number;
	/** Aborts when the asking agent ends; the dialog then closes without an answer. */
	signal?: AbortSignal;
	/** Called when a remembered answer of this run answered the dialog without showing it. */
	onRemembered?: (answer: DialogAnswer) => void;
}

export type DialogAnswer = string | boolean | undefined;

/** Serializes dialogs from many agents. Set `sink` to route them somewhere else (the monitor). */
export class DialogQueue {
	private tail: Promise<unknown> = Promise.resolve();
	pending: DialogRequest[] = [];
	/**
	 * When set, dialogs go here instead of the pi UI (the open monitor answers them).
	 * `fallback` shows the dialog in the pi UI, for a sink that closes before it answers.
	 */
	sink?: (req: DialogRequest, fallback: () => Promise<DialogAnswer>) => Promise<DialogAnswer>;
	onChange?: () => void;
	/** Answers that the human gave for all agents of a run that ask the same question. */
	private readonly remembered = new Map<string, DialogAnswer>();
	/** How often each question came up per run. */
	private readonly seen = new Map<string, number>();

	/**
	 * Key of a question that may get one answer for a whole run: a select or confirm
	 * dialog of an agent (not an ask() of the script, not free text). Same run, same
	 * kind, title, message, and options.
	 */
	static keyOf(req: DialogRequest): string | undefined {
		if (req.questionId !== undefined || !req.runId || (req.kind !== "select" && req.kind !== "confirm")) return undefined;
		return JSON.stringify([req.runId, req.kind, req.title, req.message ?? "", req.options ?? []]);
	}

	/** Give `answer` to this question and to the same question of every other agent of the run. */
	remember(req: DialogRequest, answer: DialogAnswer): void {
		const key = DialogQueue.keyOf(req);
		if (key !== undefined && answer !== undefined) this.remembered.set(key, answer);
	}

	timesSeen(req: DialogRequest): number {
		const key = DialogQueue.keyOf(req);
		return key === undefined ? 0 : (this.seen.get(key) ?? 0);
	}

	private recall(req: DialogRequest): { answer: DialogAnswer } | undefined {
		const key = DialogQueue.keyOf(req);
		if (key === undefined || !this.remembered.has(key)) return undefined;
		const answer = this.remembered.get(key);
		req.onRemembered?.(answer);
		return { answer };
	}

	run(req: DialogRequest, viaUi: (ui: ExtensionUIContext) => Promise<DialogAnswer>, ui: () => ExtensionUIContext | undefined): Promise<DialogAnswer> {
		const key = DialogQueue.keyOf(req);
		if (key !== undefined) this.seen.set(key, (this.seen.get(key) ?? 0) + 1);
		const known = this.recall(req);
		if (known) return Promise.resolve(known.answer);
		this.pending.push(req);
		this.onChange?.();
		const next = this.tail.then(async () => {
			try {
				if (req.signal?.aborted) return undefined;
				// The human may have answered the same question for the whole run meanwhile.
				const meanwhile = this.recall(req);
				if (meanwhile) return meanwhile.answer;
				const direct = async () => {
					const target = ui();
					return target ? await viaUi(target) : undefined;
				};
				if (this.sink) return await this.sink(req, direct);
				return await direct();
			} finally {
				this.pending = this.pending.filter((p) => p !== req);
				this.onChange?.();
			}
		});
		this.tail = next.catch(() => undefined);
		return next;
	}
}

export interface ChildUiOptions {
	parentUi: () => ExtensionUIContext | undefined;
	dialogs: DialogQueue;
	source: string;
	runId: string;
	agentId: number;
	onWaiting: (what: string | undefined) => void;
	notify?: (message: string, type?: "info" | "warning" | "error") => void;
	/** Aborts when the agent attempt ends. */
	signal?: AbortSignal;
	/** An extension used a UI feature that agents do not have (shown in the run log). */
	onUnsupported?: (what: string) => void;
	/** A remembered answer of the run answered a dialog of this agent (shown in the run log). */
	onRemembered?: (title: string, answer: DialogAnswer) => void;
}

function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
	const list = signals.filter((s): s is AbortSignal => !!s);
	if (list.length === 0) return undefined;
	if (list.length === 1) return list[0];
	return AbortSignal.any(list);
}

export function createChildUi(opts: ChildUiOptions): ExtensionUIContext {
	const prefix = `[${opts.source}] `;
	const dialog = async <T extends DialogAnswer>(
		base: Omit<DialogRequest, "source" | "runId" | "agentId">,
		viaUi: (ui: ExtensionUIContext, req: DialogRequest) => Promise<T>,
	): Promise<T> => {
		const req: DialogRequest = {
			...base,
			source: opts.source,
			runId: opts.runId,
			agentId: opts.agentId,
			signal: opts.signal,
			onRemembered: (answer) => opts.onRemembered?.(base.title, answer),
		};
		opts.onWaiting(`${base.kind}: ${base.title}`);
		try {
			return (await opts.dialogs.run(req, (ui) => viaUi(ui, req) as Promise<DialogAnswer>, opts.parentUi)) as T;
		} finally {
			opts.onWaiting(undefined);
		}
	};
	const SAME = "Same answer for all agents of this run…";
	const allOf = "for all agents of this run";
	let lastNotify = 0;
	const ui: ExtensionUIContext = {
		select: (title, options, dialogOpts) =>
			dialog({ kind: "select", title, options }, async (p, req) => {
				const o = { ...dialogOpts, signal: anySignal([dialogOpts?.signal, opts.signal]) };
				// From the second time the same question comes up in this run: offer one answer for all agents.
				const times = opts.dialogs.timesSeen(req);
				if (times < 2) return p.select(prefix + title, options, o);
				const pick = await p.select(`${prefix}${title} (asked ${times} times in this run)`, [...options, SAME], o);
				if (pick !== SAME) return pick;
				const again = await p.select(`${prefix}${title} (the answer goes to all agents of this run)`, options, o);
				if (again !== undefined) opts.dialogs.remember(req, again);
				return again;
			}) as Promise<string | undefined>,
		confirm: (title, message, dialogOpts) =>
			dialog({ kind: "confirm", title, message }, async (p, req) => {
				const o = { ...dialogOpts, signal: anySignal([dialogOpts?.signal, opts.signal]) };
				const times = opts.dialogs.timesSeen(req);
				if (times < 2) return p.confirm(prefix + title, message, o);
				const choices = ["Yes", "No", `Yes, ${allOf}`, `No, ${allOf}`];
				const pick = await p.select(`${prefix}${title}${message ? ` — ${message}` : ""} (asked ${times} times in this run)`, choices, o);
				if (pick === undefined) return false;
				const yes = pick.startsWith("Yes");
				if (pick.endsWith(allOf)) opts.dialogs.remember(req, yes);
				return yes;
			}).then((v) => v === true),
		input: (title, placeholder, dialogOpts) =>
			dialog({ kind: "input", title, placeholder }, (p) =>
				p.input(prefix + title, placeholder, { ...dialogOpts, signal: anySignal([dialogOpts?.signal, opts.signal]) }),
			) as Promise<string | undefined>,
		editor: (title, prefill) =>
			dialog({ kind: "editor", title, prefill }, (p) => p.editor(prefix + title, prefill)) as Promise<string | undefined>,
		notify: (message, type) => {
			const now = Date.now();
			if (now - lastNotify < 1000) return;
			lastNotify = now;
			(opts.notify ?? opts.parentUi()?.notify)?.(prefix + message, type);
		},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => {
			// A custom component needs a screen; the agent has none. Say so instead of failing quietly.
			opts.onUnsupported?.("an extension tried to open a custom dialog. Workflow agents cannot show custom dialogs, so it got no answer (most extensions treat that as cancel).");
			return undefined as never;
		},
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			const p = opts.parentUi();
			if (!p) throw new Error("No theme: the workflow agent has no UI.");
			return p.theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "Workflow agents cannot change the theme." }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
	return ui;
}
