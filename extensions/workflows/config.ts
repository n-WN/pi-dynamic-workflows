/**
 * Configuration. Sources, later ones win:
 *   1. defaults
 *   2. pi settings: the "workflows" key in ~/.pi/agent/settings.json and .pi/settings.json
 *   3. <agentDir>/workflows/config.json (written by /workflows settings)
 *   4. environment variables
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";

export type ApprovalPolicy = "ask" | "first" | "never";
export type SizeGuideline = "small" | "medium" | "large" | "unrestricted";

export interface WorkflowConfig {
	enabled: boolean;
	approval: ApprovalPolicy;
	sizeGuideline: SizeGuideline;
	maxConcurrency: number;
	maxAgents: number;
	maxItems: number;
	prefixStaggerMs: number;
	structuredOutputRetries: number;
	keywordTrigger: boolean;
	keyword: string;
	/** Key that opens /workflows (and dismisses the keyword in the prompt). Needs a /reload or restart. */
	shortcut: string;
	ultracode: boolean;
	/** Default tools of workflow agents. Undefined: the built-in tools active in the session. */
	agentTools?: string[];
	/** Load your pi extensions in workflow agents (provider hooks, permission gates, extra tools). */
	agentExtensions: boolean;
	/** Extension paths (substring match) that workflow agents never load. */
	agentExtensionsExclude: string[];
	/** List your skills in agent system prompts. Off: smaller prompts for large fan-outs. */
	agentSkills: boolean;
	/** Load AGENTS.md / CLAUDE.md context files in agents. */
	agentContextFiles: boolean;
	agentModel?: string;
	agentThinking?: string;
	largeWorkflowAgents: number;
	largeWorkflowTokens: number;
	resultMaxChars: number;
	/** Show a compact progress line on stderr in print mode. */
	printProgress: boolean;
}

export const SIZE_TARGETS: Record<SizeGuideline, number | undefined> = {
	small: 5,
	medium: 10,
	large: 50,
	unrestricted: undefined,
};

export function defaultConcurrency(): number {
	let cpus = 4;
	try {
		cpus = availableParallelism();
	} catch {
		// keep the fallback
	}
	return Math.max(2, Math.min(16, cpus));
}

export function defaults(): WorkflowConfig {
	return {
		enabled: true,
		approval: "ask",
		sizeGuideline: "medium",
		maxConcurrency: defaultConcurrency(),
		maxAgents: 1000,
		maxItems: 4096,
		prefixStaggerMs: 5000,
		structuredOutputRetries: 5,
		keywordTrigger: true,
		keyword: "ultracode",
		shortcut: "alt+w",
		ultracode: false,
		agentTools: undefined,
		agentExtensions: true,
		agentExtensionsExclude: [],
		agentSkills: true,
		agentContextFiles: true,
		agentModel: undefined,
		agentThinking: undefined,
		largeWorkflowAgents: 25,
		largeWorkflowTokens: 1_500_000,
		resultMaxChars: 30_000,
		printProgress: true,
	};
}

export function configFilePath(agentDir: string): string {
	return join(agentDir, "workflows", "config.json");
}

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

const num = (v: unknown, min: number, max: number): number | undefined => {
	const n = typeof v === "string" ? Number(v) : v;
	return typeof n === "number" && Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : undefined;
};

function apply(cfg: WorkflowConfig, src: Record<string, unknown> | undefined): void {
	if (!src) return;
	if (typeof src.enabled === "boolean") cfg.enabled = src.enabled;
	if (src.disableWorkflows === true) cfg.enabled = false;
	if (src.approval === "ask" || src.approval === "first" || src.approval === "never") cfg.approval = src.approval;
	if (typeof src.sizeGuideline === "string" && src.sizeGuideline in SIZE_TARGETS) {
		cfg.sizeGuideline = src.sizeGuideline as SizeGuideline;
	}
	cfg.maxConcurrency = num(src.maxConcurrency, 1, 256) ?? cfg.maxConcurrency;
	cfg.maxAgents = num(src.maxAgents, 1, 100_000) ?? cfg.maxAgents;
	cfg.maxItems = num(src.maxItems, 1, 100_000) ?? cfg.maxItems;
	cfg.prefixStaggerMs = num(src.prefixStaggerMs, 0, 60_000) ?? cfg.prefixStaggerMs;
	cfg.structuredOutputRetries = num(src.structuredOutputRetries, 1, 20) ?? cfg.structuredOutputRetries;
	if (typeof src.keywordTrigger === "boolean") cfg.keywordTrigger = src.keywordTrigger;
	if (typeof src.keyword === "string" && /^[A-Za-z][\w-]{2,30}$/.test(src.keyword)) cfg.keyword = src.keyword;
	if (typeof src.shortcut === "string" && /^[a-z+0-9]+$/i.test(src.shortcut)) cfg.shortcut = src.shortcut.toLowerCase();
	if (typeof src.ultracode === "boolean") cfg.ultracode = src.ultracode;
	if (Array.isArray(src.agentTools) && src.agentTools.every((t) => typeof t === "string")) {
		cfg.agentTools = src.agentTools as string[];
	}
	if (typeof src.agentExtensions === "boolean") cfg.agentExtensions = src.agentExtensions;
	if (Array.isArray(src.agentExtensionsExclude)) {
		cfg.agentExtensionsExclude = src.agentExtensionsExclude.filter((x): x is string => typeof x === "string");
	}
	if (typeof src.agentSkills === "boolean") cfg.agentSkills = src.agentSkills;
	if (typeof src.agentContextFiles === "boolean") cfg.agentContextFiles = src.agentContextFiles;
	if (typeof src.agentModel === "string" && src.agentModel) cfg.agentModel = src.agentModel;
	if (typeof src.agentThinking === "string" && src.agentThinking) cfg.agentThinking = src.agentThinking;
	cfg.largeWorkflowAgents = num(src.largeWorkflowAgents, 1, 100_000) ?? cfg.largeWorkflowAgents;
	cfg.largeWorkflowTokens = num(src.largeWorkflowTokens, 1, 1e12) ?? cfg.largeWorkflowTokens;
	cfg.resultMaxChars = num(src.resultMaxChars, 1000, 1_000_000) ?? cfg.resultMaxChars;
	if (typeof src.printProgress === "boolean") cfg.printProgress = src.printProgress;
}

export function loadConfig(piSettings: Record<string, unknown> | undefined, agentDir: string): WorkflowConfig {
	const cfg = defaults();
	const fromSettings = piSettings?.workflows;
	apply(cfg, fromSettings && typeof fromSettings === "object" ? (fromSettings as Record<string, unknown>) : undefined);
	if (piSettings?.disableWorkflows === true) cfg.enabled = false;
	apply(cfg, readJson(configFilePath(agentDir)));
	const env = process.env;
	if (env.PI_DISABLE_WORKFLOWS === "1" || env.PI_DISABLE_WORKFLOWS === "true") cfg.enabled = false;
	cfg.maxConcurrency = num(env.PI_WORKFLOW_MAX_CONCURRENT_AGENTS, 1, 256) ?? cfg.maxConcurrency;
	cfg.prefixStaggerMs = num(env.PI_WORKFLOW_PREFIX_STAGGER_MS, 0, 60_000) ?? cfg.prefixStaggerMs;
	cfg.structuredOutputRetries = num(env.PI_WORKFLOW_MAX_STRUCTURED_OUTPUT_RETRIES, 1, 20) ?? cfg.structuredOutputRetries;
	cfg.maxAgents = num(env.PI_WORKFLOW_MAX_AGENTS, 1, 100_000) ?? cfg.maxAgents;
	return cfg;
}

/**
 * Settings read directly from the global settings file. Used while the extension
 * loads, before pi can answer pi.getSettings(); session_start reloads the full set.
 */
export function readGlobalPiSettings(agentDir: string): Record<string, unknown> | undefined {
	return readJson(join(agentDir, "settings.json"));
}

/** Write one key of <agentDir>/workflows/config.json. */
export function saveConfigValue(agentDir: string, key: keyof WorkflowConfig, value: unknown): void {
	const path = configFilePath(agentDir);
	const current = readJson(path) ?? {};
	if (value === undefined) delete current[key];
	else current[key] = value;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
}
