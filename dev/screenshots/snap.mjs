// snap.mjs: crop one screen and draw it with xterm.js in a terminal color set.
//
//   FROM=<screen.txt> TERMTHEME=warm|light|dark OUT=<dir> node snap.mjs <mode> <name> ...
//
//   box  <name> [text]                  the overlay box (╭ … ╯) that contains the text
//   span <name> <start> <end|$> [extra] the last row with <start> to the first row after it
//                                       with <end> ($: the last row), plus [extra] rows
//   rows <name> <r0> <r1>               rows r0..r1 (negative: from the bottom)
//   find <text>                         print the rows that contain the text
//
// <screen.txt> is ANSI text, one line per terminal row (dump.mjs writes it).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { visibleWidth } from "../../node_modules/@earendil-works/pi-tui/dist/index.js";

const DIR = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT ?? join(DIR, "out");
const PAD = Number(process.env.PAD ?? 12);
const CHROME =
	process.env.CHROME ??
	[
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
	].find((p) => existsSync(p));

// Terminal color sets. Font: Menlo (the macOS default), 12 pt.
const THEMES = {
	// The author's kitty.
	warm: {
		background: "#f1efe7", foreground: "#37342e", cursor: "#f1efe7", cursorAccent: "#f1efe7", selectionBackground: "#e0dbcd",
		black: "#37342e", red: "#be4a3a", green: "#5c7a3f", yellow: "#a87a23", blue: "#3b6ea5", magenta: "#8a5d9e", cyan: "#2e8a86", white: "#5c584f",
		brightBlack: "#857f74", brightRed: "#d97757", brightGreen: "#6f9152", brightYellow: "#c2952f", brightBlue: "#4a82c0", brightMagenta: "#a06fb8", brightCyan: "#3da39d", brightWhite: "#262420",
	},
	// White, with the macOS Terminal palette.
	light: {
		background: "#ffffff", foreground: "#000000", cursor: "#ffffff", cursorAccent: "#ffffff", selectionBackground: "#b4d5fe",
		black: "#000000", red: "#990000", green: "#00a600", yellow: "#999900", blue: "#0000b2", magenta: "#b200b2", cyan: "#00a6b2", white: "#bfbfbf",
		brightBlack: "#666666", brightRed: "#e50000", brightGreen: "#00d900", brightYellow: "#e5e500", brightBlue: "#0000ff", brightMagenta: "#e500e5", brightCyan: "#00e5e5", brightWhite: "#e5e5e5",
	},
	// Black, with kitty's default palette.
	dark: {
		background: "#000000", foreground: "#dddddd", cursor: "#000000", cursorAccent: "#000000", selectionBackground: "#333333",
		black: "#000000", red: "#cc0403", green: "#19cb00", yellow: "#cecb00", blue: "#0d73cc", magenta: "#cb1ed1", cyan: "#0dcdcd", white: "#dddddd",
		brightBlack: "#767676", brightRed: "#f2201f", brightGreen: "#23fd00", brightYellow: "#fffd00", brightBlue: "#1a8fff", brightMagenta: "#fd28ff", brightCyan: "#14ffff", brightWhite: "#ffffff",
	},
};
const THEME = THEMES[process.env.TERMTHEME ?? "warm"];
// Like kitty: emoji with emoji presentation (⚡) come from the color emoji font; symbols with
// text presentation (⚠ ✓ ✗ ↺) stay text glyphs (font-variant-emoji: unicode, in the page CSS).
const FONT = { fontFamily: "Menlo, 'Apple Color Emoji'", fontSize: 12 };

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function newStyle() {
	return { fg: "", bg: "", bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false };
}

function applySgr(st, params) {
	const codes = params === "" ? [0] : params.split(";").map(Number);
	for (let i = 0; i < codes.length; i++) {
		const c = codes[i];
		if (c === 0) Object.assign(st, newStyle());
		else if (c === 1) st.bold = true;
		else if (c === 2) st.dim = true;
		else if (c === 3) st.italic = true;
		else if (c === 4) st.underline = true;
		else if (c === 7) st.inverse = true;
		else if (c === 9) st.strike = true;
		else if (c === 22) st.bold = st.dim = false;
		else if (c === 23) st.italic = false;
		else if (c === 24) st.underline = false;
		else if (c === 27) st.inverse = false;
		else if (c === 29) st.strike = false;
		else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) st.fg = String(c);
		else if (c === 39) st.fg = "";
		else if ((c >= 40 && c <= 47) || (c >= 100 && c <= 107)) st.bg = String(c);
		else if (c === 49) st.bg = "";
		else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
			const v = `${c};2;${codes[i + 2]};${codes[i + 3]};${codes[i + 4]}`;
			if (c === 38) st.fg = v;
			else st.bg = v;
			i += 4;
		} else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
			const v = `${c};5;${codes[i + 2]}`;
			if (c === 38) st.fg = v;
			else st.bg = v;
			i += 2;
		}
	}
}

function styleKey(st) {
	return [st.bold && "1", st.dim && "2", st.italic && "3", st.underline && "4", st.inverse && "7", st.strike && "9", st.fg, st.bg].filter(Boolean).join(";");
}

/** One line -> cells; a wide character fills two cells (the second is empty). */
function cellsOf(line) {
	const cells = [];
	const st = newStyle();
	const re = /\x1b\[([0-9;:]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|([^\x1b]+)/g;
	for (const m of line.matchAll(re)) {
		if (m[1] !== undefined) {
			applySgr(st, m[1].replace(/:/g, ";"));
			continue;
		}
		if (m[2] === undefined) continue;
		for (const { segment } of segmenter.segment(m[2])) {
			const w = Math.max(1, visibleWidth(segment));
			const key = styleKey(st);
			cells.push({ ch: segment, key });
			for (let k = 1; k < w; k++) cells.push({ ch: "", key });
		}
	}
	return cells;
}

function emit(cells, c0, c1) {
	let out = "";
	let cur = null;
	for (let c = c0; c <= c1; c++) {
		const cell = cells[c] ?? { ch: " ", key: "" };
		if (cell.ch === "") continue;
		if (cell.key !== cur) {
			out += `\x1b[0m${cell.key ? `\x1b[${cell.key}m` : ""}`;
			cur = cell.key;
		}
		out += cell.ch;
	}
	return `${out}\x1b[0m`;
}

const plain = (cells) => cells.map((c) => c.ch).join("");

/** The overlay box that contains `needle`. */
function findBox(rows, needle) {
	const texts = rows.map((cells) => cells.map((c) => c.ch || "\u0000"));
	for (let r = 0; r < texts.length; r++) {
		const t = texts[r];
		for (let c = 0; c < t.length; c++) {
			if (t[c] !== "╭") continue;
			let c1 = -1;
			for (let k = t.length - 1; k > c; k--)
				if (t[k] === "╮") {
					c1 = k;
					break;
				}
			if (c1 < 0) continue;
			let r1 = -1;
			for (let k = r + 1; k < texts.length; k++)
				if (texts[k][c] === "╰") {
					r1 = k;
					break;
				}
			if (r1 < 0) continue;
			const inside = texts.slice(r, r1 + 1).map((x) => x.slice(c, c1 + 1).join("")).join("\n");
			if (!needle || inside.includes(needle)) return [r, r1, c, c1];
		}
	}
	throw new Error(`no box with "${needle}"`);
}

// ---------------------------------------------------------------------------
// Draw
// ---------------------------------------------------------------------------

async function draw(lines, cols, outPath) {
	if (!CHROME) throw new Error("No Chrome or Chromium found. Set CHROME to its executable.");
	const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--hide-scrollbars"] });
	try {
		const page = await browser.newPage();
		await page.setViewport({ width: 2400, height: 1800, deviceScaleFactor: 2 });
		await page.setContent(
			`<!doctype html><html><head><meta charset="utf-8"><style>
				html,body{margin:0;background:${THEME.background}}
				#wrap{display:inline-block;padding:${PAD}px;background:${THEME.background}}
				.xterm-rows,.xterm-rows span{font-variant-emoji:unicode}
			</style></head><body><div id="wrap"><div id="term"></div></div></body></html>`,
		);
		await page.addStyleTag({ path: join(DIR, "node_modules/@xterm/xterm/css/xterm.css") });
		await page.addScriptTag({ path: join(DIR, "node_modules/@xterm/xterm/lib/xterm.js") });
		await page.addScriptTag({ path: join(DIR, "node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js") });
		await page.evaluate(
			async ({ lines, cols, theme, font }) => {
				const term = new window.Terminal({ cols, rows: lines.length, ...font, theme, customGlyphs: true, cursorBlink: false, scrollback: 0, drawBoldTextInBrightColors: false, minimumContrastRatio: 1, allowProposedApi: true });
				// Unicode 11 widths: emoji such as ⚡ take two columns, as in kitty and in pi's layout.
				term.loadAddon(new window.Unicode11Addon.Unicode11Addon());
				term.unicode.activeVersion = "11";
				term.open(document.getElementById("term"));
				await new Promise((r) => term.write(`\x1b[?25l${lines.join("\r\n")}`, r));
				await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
			},
			{ lines, cols, theme: THEME, font: FONT },
		);
		await (await page.$("#wrap")).screenshot({ path: outPath });
	} finally {
		await browser.close();
	}
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [mode, name, ...rest] = process.argv.slice(2);
if (!process.env.FROM) throw new Error("Set FROM to a screen file (dump.mjs writes them).");
const rows = readFileSync(process.env.FROM, "utf8").replace(/\n$/, "").split("\n").map(cellsOf);
if (mode === "find") {
	rows.forEach((cells, r) => {
		const t = plain(cells);
		if (t.includes(name)) console.log(String(r).padStart(3), t.trimEnd());
	});
	process.exit(0);
}
let r0;
let r1;
let c0 = 0;
let c1 = Math.max(...rows.map((c) => c.length)) - 1;
if (mode === "box") [r0, r1, c0, c1] = findBox(rows, rest.join(" "));
else if (mode === "span") {
	const texts = rows.map(plain);
	const [startText, endText, extra] = rest;
	r0 = texts.findLastIndex((t) => t.includes(startText));
	if (r0 < 0) throw new Error(`no row with "${startText}"`);
	r1 = endText === "$" ? texts.length - 1 : texts.findIndex((t, i) => i >= r0 && t.includes(endText));
	if (r1 < 0) throw new Error(`no row with "${endText}" after row ${r0}`);
	r1 = Math.min(texts.length - 1, r1 + Number(extra ?? 0));
} else if (mode === "rows") {
	const idx = (v) => (Number(v) < 0 ? rows.length + Number(v) : Number(v));
	r0 = idx(rest[0]);
	r1 = idx(rest[1]);
} else throw new Error("usage: snap.mjs box|span|rows|find ...");
const lines = [];
for (let r = r0; r <= r1; r++) lines.push(emit(rows[r], c0, c1));
mkdirSync(OUT, { recursive: true });
await draw(lines, c1 - c0 + 1, join(OUT, `${name}.png`));
console.log(`${name}.png: rows ${r0}-${r1}, cols ${c0}-${c1}`);
