/**
 * Saved and bundled workflows, run directories, and approval consent.
 *
 * Saved workflow locations (the first one with a name wins):
 *   1. .pi/workflows/*.js from the working directory up to the repository root (closest first)
 *   2. <agentDir>/workflows/*.js (personal)
 *   3. workflows/*.js of this package (bundled)
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type PreparedScript, prepareScript, ScriptError } from "./script.ts";
import type { WorkflowMeta } from "./types.ts";

export type WorkflowScope = "project" | "personal" | "bundled";

export interface SavedWorkflow {
	name: string;
	description: string;
	argsHint?: string;
	/** meta.whenToUse. */
	whenToUse?: string;
	argsSchema?: Record<string, unknown>;
	phases?: string[];
	path: string;
	scope: WorkflowScope;
	/** Set when the file does not load; the workflow then has no command. */
	error?: string;
}

export function repoRoot(cwd: string): string | undefined {
	try {
		return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
	} catch {
		return undefined;
	}
}

/** .pi/workflows directories from cwd up to the repository root, closest first (existing only). */
export function projectWorkflowDirs(cwd: string): string[] {
	const root = repoRoot(cwd);
	const out: string[] = [];
	let dir = resolve(cwd);
	for (;;) {
		const candidate = join(dir, ".pi", "workflows");
		if (existsSync(candidate)) out.push(candidate);
		if (root ? dir === root : false) break;
		const parent = dirname(dir);
		if (parent === dir || !root) break;
		dir = parent;
	}
	return out;
}

export function personalWorkflowDir(agentDir: string): string {
	return join(agentDir, "workflows");
}

export function runsRoot(agentDir: string): string {
	return join(agentDir, "workflows", "runs");
}

function readWorkflowFile(path: string, scope: WorkflowScope): SavedWorkflow {
	try {
		const prepared = prepareScript(readFileSync(path, "utf8"), path);
		return fromMeta(prepared.meta, path, scope);
	} catch (err) {
		const name = path.split("/").pop()?.replace(/\.js$/, "") ?? path;
		const msg = err instanceof ScriptError ? err.format(path) : (err as Error).message;
		return { name, description: "", path, scope, error: msg };
	}
}

function fromMeta(meta: WorkflowMeta, path: string, scope: WorkflowScope): SavedWorkflow {
	return {
		name: meta.name,
		description: meta.description,
		argsHint: meta.argsHint,
		whenToUse: meta.whenToUse,
		argsSchema: meta.args,
		phases: meta.phases,
		path,
		scope,
	};
}

function listJs(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((f) => f.endsWith(".js"))
			.sort()
			.map((f) => join(dir, f));
	} catch {
		return [];
	}
}

export function discoverWorkflows(opts: { cwd: string; agentDir: string; projectTrusted: boolean; bundledDir?: string }): SavedWorkflow[] {
	const out: SavedWorkflow[] = [];
	const seen = new Set<string>();
	const add = (w: SavedWorkflow) => {
		if (w.error) {
			out.push(w);
			return;
		}
		if (seen.has(w.name)) return;
		seen.add(w.name);
		out.push(w);
	};
	if (opts.projectTrusted) {
		for (const dir of projectWorkflowDirs(opts.cwd)) for (const f of listJs(dir)) add(readWorkflowFile(f, "project"));
	}
	for (const f of listJs(personalWorkflowDir(opts.agentDir))) add(readWorkflowFile(f, "personal"));
	if (opts.bundledDir) for (const f of listJs(opts.bundledDir)) add(readWorkflowFile(f, "bundled"));
	return out;
}

export function findWorkflow(list: SavedWorkflow[], name: string): SavedWorkflow | undefined {
	return list.find((w) => w.name === name && !w.error);
}

export function loadWorkflowScript(w: SavedWorkflow): { source: string; prepared: PreparedScript } {
	const source = readFileSync(w.path, "utf8");
	return { source, prepared: prepareScript(source, w.path) };
}

function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

/** Where a project save goes: the closest existing .pi/workflows, else <repo root>/.pi/workflows. */
export function projectSaveDir(cwd: string): string {
	const existing = projectWorkflowDirs(cwd)[0];
	if (existing) return existing;
	return join(repoRoot(cwd) ?? resolve(cwd), ".pi", "workflows");
}

export function saveWorkflowFile(opts: { source: string; name: string; scope: "project" | "personal"; cwd: string; agentDir: string }): string {
	const dir = opts.scope === "project" ? projectSaveDir(opts.cwd) : personalWorkflowDir(opts.agentDir);
	const target = join(dir, `${opts.name}.js`);
	if (opts.scope === "project") {
		const piDir = dirname(dir);
		for (const p of [piDir, dir, target]) {
			if (isSymlink(p)) throw new Error(`Refusing to save: ${p} is a symbolic link.`);
		}
	} else if (isSymlink(target)) {
		throw new Error(`Refusing to save: ${target} is a symbolic link.`);
	}
	mkdirSync(dir, { recursive: true });
	writeFileSync(target, opts.source.endsWith("\n") ? opts.source : `${opts.source}\n`);
	return target;
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

export interface Consent {
	/** The user approved a first workflow launch (approval policy "first"). */
	firstLaunchApproved?: boolean;
	/** "Don't ask again" choices: "<project root>::<workflow name>". */
	skip: Record<string, boolean>;
}

function consentPath(agentDir: string): string {
	return join(agentDir, "workflows", "consent.json");
}

export function loadConsent(agentDir: string): Consent {
	try {
		const v = JSON.parse(readFileSync(consentPath(agentDir), "utf8")) as Partial<Consent>;
		return { firstLaunchApproved: v.firstLaunchApproved, skip: v.skip && typeof v.skip === "object" ? v.skip : {} };
	} catch {
		return { skip: {} };
	}
}

export function saveConsent(agentDir: string, consent: Consent): void {
	const path = consentPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(consent, null, 2)}\n`);
}

export function consentKey(cwd: string, name: string): string {
	return `${repoRoot(cwd) ?? resolve(cwd)}::${name}`;
}
