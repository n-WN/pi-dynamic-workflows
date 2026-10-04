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

	run(req: DialogRequest, viaUi: (ui: ExtensionUIContext) => Promise<DialogAnswer>, ui: () => ExtensionUIContext | undefined): Promise<DialogAnswer> {
		this.pending.push(req);
		this.onChange?.();
		const next = this.tail.then(async () => {
			try {
				if (req.signal?.aborted) return undefined;
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
		req: Omit<DialogRequest, "source" | "runId" | "agentId">,
		viaUi: (ui: ExtensionUIContext) => Promise<T>,
	): Promise<T> => {
		opts.onWaiting(`${req.kind}: ${req.title}`);
		try {
			return (await opts.dialogs.run(
				{ ...req, source: opts.source, runId: opts.runId, agentId: opts.agentId, signal: opts.signal },
				viaUi as (ui: ExtensionUIContext) => Promise<DialogAnswer>,
				opts.parentUi,
			)) as T;
		} finally {
			opts.onWaiting(undefined);
		}
	};
	let lastNotify = 0;
	const ui: ExtensionUIContext = {
		select: (title, options, dialogOpts) =>
			dialog({ kind: "select", title, options }, (p) =>
				p.select(prefix + title, options, { ...dialogOpts, signal: anySignal([dialogOpts?.signal, opts.signal]) }),
			) as Promise<string | undefined>,
		confirm: (title, message, dialogOpts) =>
			dialog({ kind: "confirm", title, message }, (p) =>
				p.confirm(prefix + title, message, { ...dialogOpts, signal: anySignal([dialogOpts?.signal, opts.signal]) }),
			).then((v) => v === true),
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
		custom: async () => undefined as never,
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
