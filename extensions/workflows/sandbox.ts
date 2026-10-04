/**
 * Main-thread side of the script sandbox. One ScriptHost runs one script in a
 * worker thread and turns its messages into callbacks.
 */

import { Worker } from "node:worker_threads";
import { SCRIPT_WRAPPER_PREFIX, SCRIPT_WRAPPER_SUFFIX } from "./script.ts";
import { PRELUDE_SOURCE, WORKER_SOURCE } from "./worker-source.ts";

export interface CallScope {
	phase: string | null;
	groups: number[];
}

export interface SerializedError {
	name: string;
	message: string;
	stack?: string;
	line?: number;
	column?: number;
	agentId?: number;
	reason?: string;
}

export interface ScriptHostCallbacks {
	/** The script called agent() or ask(). Answer with resolve() or reject(). */
	onCall(id: number, op: string, payload: unknown, scope: CallScope): void;
	/** phase(), log(), and race() cancellations. */
	onPost(kind: string, payload: unknown, scope: CallScope): void;
	onDone(value: unknown): void;
	onError(error: SerializedError): void;
	onHeartbeat?(): void;
}

export interface ScriptHostInit {
	body: string;
	filename: string;
	args: unknown;
	env: unknown;
	seed: number;
	maxItems: number;
	budget: unknown;
	memoryLimitMb?: number;
}

export class ScriptHost {
	private worker: Worker | undefined;
	private ended = false;
	lastHeartbeat = Date.now();

	private readonly init: ScriptHostInit;
	private readonly cb: ScriptHostCallbacks;

	constructor(init: ScriptHostInit, cb: ScriptHostCallbacks) {
		this.init = init;
		this.cb = cb;
	}

	start(): void {
		const workerData = {
			code: SCRIPT_WRAPPER_PREFIX + this.init.body + SCRIPT_WRAPPER_SUFFIX,
			prelude: PRELUDE_SOURCE,
			filename: this.init.filename,
			argsJson: this.init.args === undefined ? undefined : JSON.stringify(this.init.args),
			envJson: JSON.stringify(this.init.env ?? {}),
			seed: this.init.seed,
			maxItems: this.init.maxItems,
			budgetJson: JSON.stringify(this.init.budget ?? {}),
		};
		const worker = new Worker(WORKER_SOURCE, {
			eval: true,
			workerData,
			stdout: true,
			stderr: true,
			resourceLimits: { maxOldGenerationSizeMb: this.init.memoryLimitMb ?? 512 },
		});
		this.worker = worker;
		// Keep worker output away from the terminal UI.
		worker.stdout?.resume();
		worker.stderr?.resume();
		worker.on("message", (msg: Record<string, unknown>) => this.onMessage(msg));
		worker.on("error", (err: Error) => {
			this.finish();
			this.cb.onError({ name: err.name || "Error", message: `The script worker failed: ${err.message}` });
		});
		worker.on("exit", (code) => {
			if (!this.ended) {
				this.ended = true;
				this.cb.onError({ name: "Error", message: `The script worker exited early (code ${code}).` });
			}
		});
	}

	private onMessage(msg: Record<string, unknown>): void {
		if (this.ended) return;
		const scope: CallScope = {
			phase: (msg.phase as string | null | undefined) ?? null,
			groups: Array.isArray(msg.groups) ? (msg.groups as number[]) : [],
		};
		const payload = typeof msg.payload === "string" ? safeParse(msg.payload) : undefined;
		switch (msg.type) {
			case "call":
				this.cb.onCall(msg.id as number, msg.op as string, payload, scope);
				break;
			case "done": {
				this.finish();
				const json = msg.json as string | undefined;
				this.cb.onDone(json === undefined ? undefined : safeParse(json));
				break;
			}
			case "error":
				this.finish();
				this.cb.onError(msg.error as SerializedError);
				break;
			case "heartbeat":
				this.lastHeartbeat = Date.now();
				this.cb.onHeartbeat?.();
				break;
			default:
				this.cb.onPost(msg.type as string, payload, scope);
		}
	}

	resolve(id: number, value: unknown): void {
		this.post({ type: "resolve", id, json: value === undefined ? undefined : JSON.stringify(value) });
	}

	reject(id: number, error: SerializedError): void {
		this.post({ type: "reject", id, error });
	}

	pushBudget(budget: unknown): void {
		this.post({ type: "budget", json: JSON.stringify(budget) });
	}

	cancelled(groups: number[]): void {
		this.post({ type: "cancelled", groups });
	}

	get running(): boolean {
		return !!this.worker && !this.ended;
	}

	private post(msg: unknown): void {
		if (this.ended || !this.worker) return;
		try {
			this.worker.postMessage(msg);
		} catch {
			// The worker is gone.
		}
	}

	private finish(): void {
		if (this.ended) return;
		this.ended = true;
		const w = this.worker;
		// Let the last message flush, then stop the thread.
		setTimeout(() => void w?.terminate().catch(() => {}), 0);
	}

	/** Stop the script at once. */
	async terminate(): Promise<void> {
		this.ended = true;
		await this.worker?.terminate().catch(() => {});
	}
}

function safeParse(json: string): unknown {
	try {
		return JSON.parse(json);
	} catch {
		return undefined;
	}
}
