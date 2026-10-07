/**
 * Main editor with keyword highlighting.
 *
 * When the prompt contains the trigger keyword (default "ultracode"), the editor
 * highlights it and shows a hint in its top border. alt+w dismisses the keyword
 * for this prompt (it is then drawn struck through and does not trigger).
 */

import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, stripTerminalSequences, type TUI, visibleWidth } from "@earendil-works/pi-tui";

export interface KeywordState {
	keyword: () => string;
	enabled: () => boolean;
	dismissed: () => boolean;
	theme: () => Theme;
	dismissKey: string;
}

export function keywordRegex(keyword: string, flags = "i"): RegExp {
	const k = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?<![A-Za-z0-9_-])${k}(?![A-Za-z0-9_-])`, flags);
}

const QUOTES: Record<string, string> = { '"': '"', "'": "'", "`": "`", "“": "”", "‘": "’", "「": "」", "『": "』", "«": "»" };

/** True when the keyword at [start, end) is only a mention: in quotes, or part of a /command. */
function isMention(text: string, start: number, end: number): boolean {
	const before = text[start - 1] ?? "";
	if (before === "/") return true;
	const close = QUOTES[before];
	return close !== undefined && text[end] === close;
}

/** The text with code (``` fences and `spans`) replaced by spaces; offsets stay the same. */
function maskCode(text: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, " ");
	return text.replace(/```[\s\S]*?(?:```|$)/g, blank).replace(/`[^`\n]*`/g, blank);
}

/**
 * Places where the keyword counts as an opt-in. It does not count in code
 * (``` fences, `spans`), in quotes ("ultracode", “ultracode”), or as part of
 * a /command (/ultracode). So a pasted text or a note that only mentions the
 * keyword does not start a workflow.
 */
export function keywordHits(text: string, keyword: string): Array<{ index: number; length: number }> {
	const masked = maskCode(text);
	const out: Array<{ index: number; length: number }> = [];
	for (const m of masked.matchAll(keywordRegex(keyword, "gi"))) {
		const start = m.index ?? 0;
		if (!isMention(masked, start, start + m[0].length)) out.push({ index: start, length: m[0].length });
	}
	return out;
}

/** Apply `style` to the keyword hits of a text. */
export function styleKeywordHits(text: string, keyword: string, style: (m: string) => string): string {
	const hits = keywordHits(text, keyword);
	let out = "";
	let at = 0;
	for (const h of hits) {
		out += text.slice(at, h.index) + style(text.slice(h.index, h.index + h.length));
		at = h.index + h.length;
	}
	return out + text.slice(at);
}

/** Same match, but it also accepts a preceding SGR escape sequence as a boundary. */
function renderedKeywordRegex(keyword: string): RegExp {
	const k = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?<=^|[^A-Za-z0-9_\\-]|\\x1b\\[[0-9;]*m)(${k})(?=$|[^A-Za-z0-9_\\-]|\\x1b)`, "gi");
}

export class KeywordEditor extends CustomEditor {
	private readonly kw: KeywordState;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, kw: KeywordState) {
		super(tui, theme, keybindings);
		this.kw = kw;
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (!this.kw.enabled()) return lines;
		const keyword = this.kw.keyword();
		if (keywordHits(this.getText(), keyword).length === 0) return lines;
		const th = this.kw.theme();
		const dismissed = this.kw.dismissed();
		const re = renderedKeywordRegex(keyword);
		const style = (m: string) => (dismissed ? th.fg("dim", th.strikethrough(m)) : th.fg("accent", th.bold(m)));
		const isBorder = (l: string) => /^[─━\s]*$/.test(stripTerminalSequences(l));
		// Mentions (quoted, /command) stay plain, as they do not trigger.
		const mark = (l: string) =>
			l.replace(re, (m: string, _g: string, offset: number, whole: string) => {
				const plainBefore = stripTerminalSequences(whole.slice(0, offset));
				const plainAfter = stripTerminalSequences(whole.slice(offset + m.length));
				const probe = `${plainBefore.slice(-1)}${m}${plainAfter.slice(0, 1)}`;
				return isMention(probe, plainBefore.slice(-1).length, plainBefore.slice(-1).length + m.length) ? m : style(m);
			});
		const out = lines.map((l, i) => (i === 0 || isBorder(l) ? l : mark(l)));
		if (out.length > 0 && isBorder(out[0]) && width > 30) {
			const hint = dismissed
				? ` ${th.fg("dim", `${keyword} dismissed · ${this.kw.dismissKey} restores`)} `
				: ` ${th.fg("accent", `⚡ ${keyword}`)} ${th.fg("dim", `runs as a workflow · ${this.kw.dismissKey} dismisses`)} `;
			const hw = visibleWidth(hint);
			if (hw + 4 < width) out[0] = this.borderColor("─".repeat(width - hw - 2)) + hint + this.borderColor("──");
		}
		return out;
	}
}
