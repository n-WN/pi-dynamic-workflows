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
		if (!keywordRegex(keyword).test(this.getText())) return lines;
		const th = this.kw.theme();
		const dismissed = this.kw.dismissed();
		const re = renderedKeywordRegex(keyword);
		const style = (m: string) => (dismissed ? th.fg("dim", th.strikethrough(m)) : th.fg("accent", th.bold(m)));
		const isBorder = (l: string) => /^[─━\s]*$/.test(stripTerminalSequences(l));
		const out = lines.map((l, i) => (i === 0 || isBorder(l) ? l : l.replace(re, (m) => style(m))));
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
