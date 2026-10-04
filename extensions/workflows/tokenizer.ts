/**
 * A small JavaScript tokenizer.
 *
 * It is not a full parser. It knows enough to find the `meta` literal, to read
 * it as data without eval, and to find forbidden constructs (import(), require(),
 * Date.now(), ...) outside of strings, comments, and regex literals.
 */

export type TokenType = "ws" | "comment" | "string" | "template" | "regex" | "number" | "ident" | "punct";

export interface Token {
	type: TokenType;
	value: string;
	start: number;
	end: number;
	/** For template tokens: true when the template has `${...}` substitutions. */
	hasSubstitutions?: boolean;
}

const KEYWORDS_BEFORE_EXPRESSION = new Set([
	"return",
	"typeof",
	"instanceof",
	"in",
	"of",
	"new",
	"delete",
	"void",
	"throw",
	"case",
	"do",
	"else",
	"yield",
	"await",
]);

const PUNCTUATORS = [
	">>>=",
	"...",
	"===",
	"!==",
	"**=",
	"<<=",
	">>=",
	">>>",
	"&&=",
	"||=",
	"??=",
	"=>",
	"==",
	"!=",
	"<=",
	">=",
	"&&",
	"||",
	"??",
	"?.",
	"++",
	"--",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"&=",
	"|=",
	"^=",
	"**",
	"<<",
	">>",
];

function isIdentStart(ch: string): boolean {
	return /[A-Za-z_$\u00a0-\uffff]/.test(ch);
}

function isIdentPart(ch: string): boolean {
	return /[A-Za-z0-9_$\u00a0-\uffff\u200c\u200d]/.test(ch);
}

export class TokenizeError extends Error {
	readonly offset: number;
	constructor(message: string, offset: number) {
		super(message);
		this.name = "TokenizeError";
		this.offset = offset;
	}
}

export function tokenize(src: string): Token[] {
	const tokens: Token[] = [];
	let pos = 0;

	const lastSignificant = (): Token | undefined => {
		for (let i = tokens.length - 1; i >= 0; i--) {
			const t = tokens[i];
			if (t.type !== "ws" && t.type !== "comment") return t;
		}
		return undefined;
	};

	const regexAllowed = (): boolean => {
		const prev = lastSignificant();
		if (!prev) return true;
		if (prev.type === "punct") return prev.value !== ")" && prev.value !== "]";
		if (prev.type === "ident") return KEYWORDS_BEFORE_EXPRESSION.has(prev.value);
		return false;
	};

	const readString = (quote: string): void => {
		const start = pos;
		pos++;
		while (pos < src.length) {
			const ch = src[pos];
			if (ch === "\\") {
				pos += 2;
				continue;
			}
			if (ch === quote) {
				pos++;
				tokens.push({ type: "string", value: src.slice(start, pos), start, end: pos });
				return;
			}
			if (ch === "\n") break;
			pos++;
		}
		throw new TokenizeError("Unterminated string literal", start);
	};

	// Reads tokens until a closing brace at depth 0 (used for template substitutions).
	const readUntilClosingBrace = (): void => {
		let depth = 0;
		while (pos < src.length) {
			const ch = src[pos];
			if (ch === "}" && depth === 0) return;
			if (ch === "{") depth++;
			if (ch === "}") depth--;
			readToken();
		}
		throw new TokenizeError("Unterminated template substitution", pos);
	};

	const readTemplate = (): void => {
		let chunkStart = pos;
		pos++; // opening backtick
		let hasSubstitutions = false;
		const templateTokenIndex = tokens.length;
		tokens.push({ type: "template", value: "", start: chunkStart, end: chunkStart });
		while (pos < src.length) {
			const ch = src[pos];
			if (ch === "\\") {
				pos += 2;
				continue;
			}
			if (ch === "`") {
				pos++;
				const tok = tokens[templateTokenIndex];
				tok.end = pos;
				tok.value = src.slice(tok.start, pos);
				tok.hasSubstitutions = hasSubstitutions;
				return;
			}
			if (ch === "$" && src[pos + 1] === "{") {
				hasSubstitutions = true;
				pos += 2;
				readUntilClosingBrace();
				pos++; // closing brace of the substitution
				chunkStart = pos;
				continue;
			}
			pos++;
		}
		throw new TokenizeError("Unterminated template literal", chunkStart);
	};

	const readRegex = (): void => {
		const start = pos;
		pos++;
		let inClass = false;
		while (pos < src.length) {
			const ch = src[pos];
			if (ch === "\\") {
				pos += 2;
				continue;
			}
			if (ch === "\n") throw new TokenizeError("Unterminated regular expression", start);
			if (inClass) {
				if (ch === "]") inClass = false;
			} else if (ch === "[") {
				inClass = true;
			} else if (ch === "/") {
				pos++;
				while (pos < src.length && isIdentPart(src[pos])) pos++;
				tokens.push({ type: "regex", value: src.slice(start, pos), start, end: pos });
				return;
			}
			pos++;
		}
		throw new TokenizeError("Unterminated regular expression", start);
	};

	const readToken = (): void => {
		const ch = src[pos];
		const start = pos;
		if (/\s/.test(ch)) {
			while (pos < src.length && /\s/.test(src[pos])) pos++;
			tokens.push({ type: "ws", value: src.slice(start, pos), start, end: pos });
			return;
		}
		if (ch === "/" && src[pos + 1] === "/") {
			while (pos < src.length && src[pos] !== "\n") pos++;
			tokens.push({ type: "comment", value: src.slice(start, pos), start, end: pos });
			return;
		}
		if (ch === "/" && src[pos + 1] === "*") {
			const close = src.indexOf("*/", pos + 2);
			if (close < 0) throw new TokenizeError("Unterminated comment", start);
			pos = close + 2;
			tokens.push({ type: "comment", value: src.slice(start, pos), start, end: pos });
			return;
		}
		if (ch === '"' || ch === "'") {
			readString(ch);
			return;
		}
		if (ch === "`") {
			readTemplate();
			return;
		}
		if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[pos + 1] ?? ""))) {
			while (pos < src.length && /[0-9a-zA-Z_.]/.test(src[pos])) {
				// Exponent sign: 1e-5
				if ((src[pos] === "e" || src[pos] === "E") && (src[pos + 1] === "-" || src[pos + 1] === "+")) pos++;
				pos++;
			}
			tokens.push({ type: "number", value: src.slice(start, pos), start, end: pos });
			return;
		}
		if (isIdentStart(ch) || ch === "#") {
			pos++;
			while (pos < src.length && isIdentPart(src[pos])) pos++;
			tokens.push({ type: "ident", value: src.slice(start, pos), start, end: pos });
			return;
		}
		if (ch === "/" && regexAllowed()) {
			readRegex();
			return;
		}
		for (const p of PUNCTUATORS) {
			if (src.startsWith(p, pos)) {
				pos += p.length;
				tokens.push({ type: "punct", value: p, start, end: pos });
				return;
			}
		}
		pos++;
		tokens.push({ type: "punct", value: ch, start, end: pos });
	};

	while (pos < src.length) readToken();
	return tokens;
}

/** Tokens without whitespace and comments. */
export function significant(tokens: Token[]): Token[] {
	return tokens.filter((t) => t.type !== "ws" && t.type !== "comment");
}

/** 1-based line and column of an offset. */
export function lineColumn(src: string, offset: number): { line: number; column: number } {
	let line = 1;
	let lineStart = 0;
	for (let i = 0; i < offset && i < src.length; i++) {
		if (src[i] === "\n") {
			line++;
			lineStart = i + 1;
		}
	}
	return { line, column: offset - lineStart + 1 };
}
