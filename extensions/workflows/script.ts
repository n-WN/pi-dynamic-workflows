/**
 * Script preparation: read the `meta` literal, check forbidden constructs, and
 * check the syntax before a run starts. All errors carry a line and a snippet
 * so the agent can fix the script in one step.
 */

import vm from "node:vm";
import { lineColumn, significant, type Token, TokenizeError, tokenize } from "./tokenizer.ts";
import type { WorkflowMeta } from "./types.ts";

export const SCRIPT_WRAPPER_PREFIX = "(async function __workflow__() {\n";
export const SCRIPT_WRAPPER_SUFFIX = "\n})";

export type ScriptErrorKind = "syntax" | "meta" | "forbidden";

export class ScriptError extends Error {
	readonly kind: ScriptErrorKind;
	readonly line?: number;
	readonly column?: number;
	readonly snippet?: string;
	constructor(kind: ScriptErrorKind, message: string, line?: number, column?: number, snippet?: string) {
		super(message);
		this.name = "ScriptError";
		this.kind = kind;
		this.line = line;
		this.column = column;
		this.snippet = snippet;
	}

	/** Text for the agent: location, message, and a snippet with a caret. */
	format(filename: string): string {
		const where = this.line ? `${filename}:${this.line}${this.column ? `:${this.column}` : ""} ` : "";
		return `${where}${this.message}${this.snippet ? `\n${this.snippet}` : ""}`;
	}
}

export interface PreparedScript {
	/** Original source. */
	source: string;
	/** Parsed `meta` literal. */
	meta: WorkflowMeta;
	/** Source with `export` replaced by spaces, so lines and columns stay the same. */
	body: string;
	/** Offsets of the meta object literal in the source (`{` to `}` inclusive). */
	metaRange: { start: number; end: number };
	lineCount: number;
}

export function snippetAt(src: string, line: number, column?: number, context = 1): string {
	const lines = src.split("\n");
	const from = Math.max(1, line - context);
	const to = Math.min(lines.length, line + context);
	const width = String(to).length;
	const out: string[] = [];
	for (let n = from; n <= to; n++) {
		out.push(`${n === line ? ">" : " "} ${String(n).padStart(width)} | ${lines[n - 1]}`);
		if (n === line && column && column > 0) {
			out.push(`  ${" ".repeat(width)} | ${" ".repeat(Math.max(0, column - 1))}^`);
		}
	}
	return out.join("\n");
}

function errorAt(kind: ScriptErrorKind, src: string, offset: number, message: string): ScriptError {
	const { line, column } = lineColumn(src, offset);
	return new ScriptError(kind, message, line, column, snippetAt(src, line, column));
}

// ---------------------------------------------------------------------------
// meta literal parser (data only, no eval)
// ---------------------------------------------------------------------------

class LiteralParser {
	private i = 0;
	private readonly tokens: Token[];
	private readonly src: string;
	constructor(tokens: Token[], src: string) {
		this.tokens = tokens;
		this.src = src;
	}

	private peek(): Token | undefined {
		return this.tokens[this.i];
	}

	private next(): Token {
		const t = this.tokens[this.i++];
		if (!t) throw new ScriptError("meta", "The meta literal ends too early.");
		return t;
	}

	private fail(t: Token | undefined, what: string): never {
		const offset = t?.start ?? this.src.length;
		throw errorAt(
			"meta",
			this.src,
			offset,
			`meta must be a plain object literal with literal values only (strings, numbers, booleans, null, arrays, objects). ${what}`,
		);
	}

	parseValue(path: string): unknown {
		const t = this.next();
		if (t.type === "punct" && t.value === "{") return this.parseObject(path);
		if (t.type === "punct" && t.value === "[") return this.parseArray(path);
		if (t.type === "string") return parseStringLiteral(t.value);
		if (t.type === "template") {
			if (t.hasSubstitutions) this.fail(t, `Found a template literal with \${...} at ${path}.`);
			return parseTemplateLiteral(t.value);
		}
		if (t.type === "number") return parseNumberLiteral(t, path, (m) => this.fail(t, m));
		if (t.type === "punct" && (t.value === "-" || t.value === "+")) {
			const n = this.next();
			if (n.type !== "number") this.fail(n, `Found "${t.value}" without a number at ${path}.`);
			const v = parseNumberLiteral(n, path, (m) => this.fail(n, m));
			return t.value === "-" ? -v : v;
		}
		if (t.type === "ident") {
			if (t.value === "true") return true;
			if (t.value === "false") return false;
			if (t.value === "null") return null;
			const after = this.peek();
			const kind = after?.type === "punct" && (after.value === "(" || after.value === "`") ? "a function call" : "a variable";
			this.fail(t, `Found ${kind} (${t.value}) at ${path}.`);
		}
		if (t.type === "punct" && t.value === "...") this.fail(t, `Found a spread (...) at ${path}.`);
		this.fail(t, `Found "${t.value}" at ${path}.`);
	}

	private parseObject(path: string): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		for (;;) {
			let t = this.next();
			if (t.type === "punct" && t.value === "}") return out;
			let key: string;
			if (t.type === "ident") key = t.value;
			else if (t.type === "string") key = parseStringLiteral(t.value);
			else if (t.type === "number") key = String(Number(t.value));
			else if (t.type === "punct" && t.value === "[") this.fail(t, `Found a computed key at ${path}.`);
			else if (t.type === "punct" && t.value === "...") this.fail(t, `Found a spread (...) at ${path}.`);
			else this.fail(t, `Found "${t.value}" where a key was expected at ${path}.`);
			const colon = this.next();
			if (colon.type !== "punct" || colon.value !== ":") {
				if (colon.type === "punct" && (colon.value === "," || colon.value === "}")) {
					this.fail(t, `Found a shorthand property (${key}) at ${path}. Write ${key}: <literal>.`);
				}
				if (colon.type === "punct" && colon.value === "(") this.fail(t, `Found a method (${key}) at ${path}.`);
				this.fail(colon, `Expected ":" after key "${key}" at ${path}.`);
			}
			out[key] = this.parseValue(`${path}.${key}`);
			t = this.next();
			if (t.type === "punct" && t.value === "}") return out;
			if (t.type !== "punct" || t.value !== ",") this.fail(t, `Expected "," or "}" at ${path}.`);
		}
	}

	private parseArray(path: string): unknown[] {
		const out: unknown[] = [];
		for (;;) {
			const t = this.peek();
			if (t?.type === "punct" && t.value === "]") {
				this.i++;
				return out;
			}
			out.push(this.parseValue(`${path}[${out.length}]`));
			const sep = this.next();
			if (sep.type === "punct" && sep.value === "]") return out;
			if (sep.type !== "punct" || sep.value !== ",") this.fail(sep, `Expected "," or "]" at ${path}.`);
		}
	}

	get index(): number {
		return this.i;
	}
}

function parseStringLiteral(raw: string): string {
	const quote = raw[0];
	const inner = raw.slice(1, -1);
	if (quote === '"') return JSON.parse(raw) as string;
	// Single-quoted: convert to a JSON string.
	const converted = `"${inner.replace(/\\'/g, "'").replace(/"/g, '\\"')}"`;
	try {
		return JSON.parse(converted) as string;
	} catch {
		return inner;
	}
}

function parseTemplateLiteral(raw: string): string {
	const inner = raw.slice(1, -1);
	try {
		return JSON.parse(`"${inner.replace(/\\`/g, "`").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`) as string;
	} catch {
		return inner;
	}
}

function parseNumberLiteral(t: Token, path: string, fail: (msg: string) => never): number {
	const v = Number(t.value.replace(/_/g, ""));
	if (!Number.isFinite(v)) fail(`Found an invalid number (${t.value}) at ${path}.`);
	return v;
}

// ---------------------------------------------------------------------------
// prepareScript
// ---------------------------------------------------------------------------

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function validateMeta(meta: Record<string, unknown>, src: string, metaOffset: number): WorkflowMeta {
	const fail = (msg: string): never => {
		throw errorAt("meta", src, metaOffset, msg);
	};
	if (typeof meta.name !== "string" || !meta.name) fail('meta.name is required: a kebab-case string such as "audit-routes".');
	const name = meta.name as string;
	if (!NAME_RE.test(name)) {
		fail(`meta.name "${name}" is not valid. Use lowercase letters, digits, and "-" (at most 64 characters).`);
	}
	if (typeof meta.description !== "string" || !meta.description.trim()) {
		fail("meta.description is required: one line that says what the workflow does.");
	}
	if (meta.phases !== undefined) {
		if (!Array.isArray(meta.phases) || meta.phases.some((p) => typeof p !== "string" || !p.trim())) {
			fail('meta.phases must be an array of non-empty strings, such as ["Find", "Fix", "Verify"].');
		}
	}
	if (meta.args !== undefined && (typeof meta.args !== "object" || meta.args === null || Array.isArray(meta.args))) {
		fail("meta.args must be a JSON Schema object that describes the args value.");
	}
	if (meta.argsHint !== undefined && typeof meta.argsHint !== "string") fail("meta.argsHint must be a string.");
	return meta as unknown as WorkflowMeta;
}

interface ForbiddenRule {
	test: (tokens: Token[], i: number) => boolean;
	message: string;
}

const isPunct = (t: Token | undefined, v: string) => t?.type === "punct" && t.value === v;
const isIdent = (t: Token | undefined, v: string) => t?.type === "ident" && t.value === v;
const isMemberAccess = (tokens: Token[], i: number) => isPunct(tokens[i - 1], ".") || isPunct(tokens[i - 1], "?.");

const FORBIDDEN: ForbiddenRule[] = [
	{
		test: (s, i) => isIdent(s[i], "import") && isPunct(s[i + 1], "(") && !isMemberAccess(s, i),
		message: "import() is not allowed in workflow scripts. Put work that needs a library inside an agent's task.",
	},
	{
		test: (s, i) =>
			isIdent(s[i], "import") &&
			!isMemberAccess(s, i) &&
			!isPunct(s[i + 1], ".") &&
			(s[i + 1]?.type === "ident" || s[i + 1]?.type === "string" || isPunct(s[i + 1], "{") || isPunct(s[i + 1], "*")),
		message: "import declarations are not allowed in workflow scripts. The script body is plain JavaScript with globals such as agent() and parallel().",
	},
	{
		test: (s, i) => isIdent(s[i], "require") && isPunct(s[i + 1], "(") && !isMemberAccess(s, i),
		message: "require() is not allowed in workflow scripts. The script has no module, file system, or shell access; agents do that work.",
	},
	{
		test: (s, i) => isIdent(s[i], "Date") && isPunct(s[i + 1], ".") && isIdent(s[i + 2], "now") && !isMemberAccess(s, i),
		message:
			"Date.now() is disabled in workflow scripts, so a relaunched run repeats the same agent() calls. Pass a timestamp in args instead.",
	},
	{
		test: (s, i) =>
			isIdent(s[i], "new") && isIdent(s[i + 1], "Date") && isPunct(s[i + 2], "(") && isPunct(s[i + 3], ")"),
		message:
			"new Date() without arguments is disabled in workflow scripts, so a relaunched run repeats the same agent() calls. Pass a timestamp in args instead.",
	},
	{
		test: (s, i) => isIdent(s[i], "Math") && isPunct(s[i + 1], ".") && isIdent(s[i + 2], "random") && !isMemberAccess(s, i),
		message: "Math.random() is disabled in workflow scripts. Use the seeded random() global, which a relaunched run repeats exactly.",
	},
];

export function prepareScript(source: string, filename = "workflow.js"): PreparedScript {
	if (typeof source !== "string" || !source.trim()) {
		throw new ScriptError("meta", "The script is empty. It must begin with: export const meta = { name, description }");
	}
	let tokens: Token[];
	try {
		tokens = tokenize(source);
	} catch (err) {
		if (err instanceof TokenizeError) throw errorAt("syntax", source, err.offset, `SyntaxError: ${err.message}`);
		throw err;
	}
	const sig = significant(tokens);
	const head = sig.slice(0, 5);
	const headOk =
		isIdent(head[0], "export") &&
		isIdent(head[1], "const") &&
		isIdent(head[2], "meta") &&
		isPunct(head[3], "=") &&
		isPunct(head[4], "{");
	if (!headOk) {
		const offset = sig[0]?.start ?? 0;
		throw errorAt(
			"meta",
			source,
			offset,
			'The script must begin with `export const meta = { name: "kebab-name", description: "..." }` as its first statement.',
		);
	}

	// Parse the literal starting at the "{".
	const literalTokens = sig.slice(4);
	const parser = new LiteralParser(literalTokens, source);
	const metaValue = parser.parseValue("meta") as Record<string, unknown>;
	const closeToken = literalTokens[parser.index - 1];
	const metaRange = { start: head[4].start, end: closeToken.end };
	const meta = validateMeta(metaValue, source, head[4].start);

	// Forbidden constructs in the rest of the script.
	const restStart = 4 + parser.index;
	for (let i = restStart; i < sig.length; i++) {
		if (isIdent(sig[i], "export") && !isMemberAccess(sig, i)) {
			throw errorAt(
				"forbidden",
				source,
				sig[i].start,
				"Only `export const meta` may use export. Remove other export statements; use `return` to produce the result.",
			);
		}
		for (const rule of FORBIDDEN) {
			if (rule.test(sig, i)) throw errorAt("forbidden", source, sig[i].start, rule.message);
		}
	}

	// Keep offsets: replace the `export` keyword with spaces.
	const exportTok = head[0];
	const body = source.slice(0, exportTok.start) + " ".repeat(exportTok.value.length) + source.slice(exportTok.end);

	checkSyntax(body, source, filename);

	return { source, meta, body, metaRange, lineCount: source.split("\n").length };
}

/** Compile the wrapped body without running it. Throws ScriptError with the original line. */
export function checkSyntax(body: string, original: string, filename: string): void {
	try {
		new vm.Script(SCRIPT_WRAPPER_PREFIX + body + SCRIPT_WRAPPER_SUFFIX, { filename, lineOffset: -1 });
	} catch (err) {
		const e = err as Error;
		const stack = String(e.stack ?? "");
		const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const match = stack.match(new RegExp(`${escaped}:(\\d+)`));
		const line = match ? Number(match[1]) : undefined;
		// V8 prints the source line and a caret line under the location line.
		let column: number | undefined;
		const stackLines = stack.split("\n");
		const caretLine = stackLines.find((l) => /^\s*\^+\s*$/.test(l));
		if (caretLine) column = caretLine.indexOf("^") + 1;
		const message = `${e.name}: ${e.message}`;
		if (line && line >= 1 && line <= original.split("\n").length) {
			throw new ScriptError("syntax", message, line, column, snippetAt(original, line, column));
		}
		throw new ScriptError("syntax", message);
	}
}

/** Replace meta.name in a script source, keeping the rest of the file. */
export function renameScript(prepared: PreparedScript, newName: string): string {
	const literal = prepared.source.slice(prepared.metaRange.start, prepared.metaRange.end);
	const replaced = literal.replace(/(\bname\s*:\s*)(["'`])([^"'`]*)\2/, (_m, a: string, q: string) => `${a}${q}${newName}${q}`);
	return prepared.source.slice(0, prepared.metaRange.start) + replaced + prepared.source.slice(prepared.metaRange.end);
}

/** Cheap name lookup for renderers (no validation). */
export function peekMetaName(source: string | undefined): string | undefined {
	if (!source) return undefined;
	const m = source.match(/export\s+const\s+meta\s*=\s*\{[\s\S]*?\bname\s*:\s*["'`]([^"'`]+)["'`]/);
	return m?.[1];
}

export function peekMetaPhases(source: string | undefined): string[] | undefined {
	if (!source) return undefined;
	const m = source.match(/export\s+const\s+meta\s*=\s*\{[\s\S]*?\bphases\s*:\s*\[([^\]]*)\]/);
	if (!m) return undefined;
	return [...m[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1]);
}

/** What a script does, as far as its text shows. The approval dialog shows it. */
export interface ScriptPlan {
	/** agent() call sites. One call site in a loop or in parallel() starts many agents. */
	agentCalls: number;
	/** Helpers that start many agents: parallel, pipeline, race. */
	fanOut: string[];
	/** Call sites with readOnly: true. */
	readOnly: number;
	/** Call sites with isolation: "worktree". */
	worktree: number;
	/** Model names in the text (model: "..."). */
	models: string[];
	/** Tool names in tools: [...] lists. */
	tools: string[];
	/** ask() call sites. */
	asks: number;
}

function literalText(t: Token | undefined): string | undefined {
	if (!t) return undefined;
	if (t.type === "string" || (t.type === "template" && !t.hasSubstitutions)) return t.value.slice(1, -1);
	return undefined;
}

/** Scan the script body (after meta) for the facts of `ScriptPlan`. */
export function scanPlan(prepared: PreparedScript): ScriptPlan {
	const plan: ScriptPlan = { agentCalls: 0, fanOut: [], readOnly: 0, worktree: 0, models: [], tools: [], asks: 0 };
	let sig: Token[];
	try {
		sig = significant(tokenize(prepared.body));
	} catch {
		return plan;
	}
	const add = (list: string[], v: string | undefined) => {
		if (v && !list.includes(v)) list.push(v);
	};
	for (let i = 0; i < sig.length; i++) {
		const t = sig[i];
		if (t.start <= prepared.metaRange.end || t.type !== "ident") continue;
		if (isPunct(sig[i + 1], "(") && !isMemberAccess(sig, i)) {
			if (t.value === "agent") plan.agentCalls++;
			else if (t.value === "ask") plan.asks++;
			else if (t.value === "parallel" || t.value === "pipeline" || t.value === "race") add(plan.fanOut, t.value);
			continue;
		}
		if (!isPunct(sig[i + 1], ":")) continue;
		const v = sig[i + 2];
		if (t.value === "readOnly" && isIdent(v, "true")) plan.readOnly++;
		else if (t.value === "isolation" && literalText(v) === "worktree") plan.worktree++;
		else if (t.value === "model") add(plan.models, literalText(v));
		else if (t.value === "tools" && isPunct(v, "[")) {
			for (let j = i + 3; j < sig.length && !isPunct(sig[j], "]"); j++) add(plan.tools, literalText(sig[j]));
		}
	}
	return plan;
}
