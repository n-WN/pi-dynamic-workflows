// dump.mjs <stream> <manifest> <outdir>
// Replays the bytes that pi wrote into xterm.js (a real terminal emulator) and writes the
// screen at each recorded moment as ANSI text, rebuilt from the emulator's cells.
// Manifest lines: "size <cols> <rows>", "grab <name> <offset>", "resize <offset> <cols> <rows>",
// "tall <name> <offset> <rows>": the screen at <offset> in a taller window (lines come back from
// the scrollback, as in a real terminal that grows), replayed in a separate terminal.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import unicode11 from "@xterm/addon-unicode11";
import headless from "@xterm/headless";

const { Terminal } = headless;
const SCROLLBACK = 10_000;
/** A terminal with Unicode 11 widths (emoji such as ⚡ take two columns), as kitty and pi count them. */
function newTerminal(cols, rows) {
	const t = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
	t.loadAddon(new unicode11.Unicode11Addon());
	t.unicode.activeVersion = "11";
	return t;
}
const [streamPath, manifestPath, outDir] = process.argv.slice(2);
const bytes = readFileSync(streamPath);
const lines = readFileSync(manifestPath, "utf8").trim().split("\n").map((l) => l.split(" "));
const size = lines.find((l) => l[0] === "size") ?? ["size", "110", "34"];
const events = lines
	.filter((l) => l[0] !== "size")
	.filter((l) => l[0] !== "tall")
	.map((l) => (l[0] === "grab" ? { kind: "grab", name: l[1], at: Number(l[2]) } : { kind: "resize", at: Number(l[1]), cols: Number(l[2]), rows: Number(l[3]) }))
	.sort((a, b) => a.at - b.at);
const talls = lines.filter((l) => l[0] === "tall").map((l) => ({ name: l[1], at: Number(l[2]), rows: Number(l[3]) }));

let term = newTerminal(Number(size[1]), Number(size[2]));
const write = (chunk) => new Promise((resolve) => term.write(chunk, resolve));

function sgr(cell) {
	const p = [];
	if (cell.isBold()) p.push(1);
	if (cell.isDim()) p.push(2);
	if (cell.isItalic()) p.push(3);
	if (cell.isUnderline()) p.push(4);
	if (cell.isInverse()) p.push(7);
	if (cell.isInvisible()) p.push(8);
	if (cell.isStrikethrough()) p.push(9);
	const color = (rgb, palette, value, base, bright, ext) => {
		if (rgb) p.push(`${ext};2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`);
		else if (palette) p.push(value < 8 ? base + value : value < 16 ? bright + value - 8 : `${ext};5;${value}`);
	};
	color(cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor(), 30, 90, 38);
	color(cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor(), 40, 100, 48);
	return p.join(";");
}

function screen() {
	const buf = term.buffer.active;
	const out = [];
	const cell = buf.getNullCell();
	for (let y = 0; y < term.rows; y++) {
		const line = buf.getLine(buf.viewportY + y);
		let text = "";
		let cur = null;
		for (let x = 0; x < term.cols; x++) {
			line.getCell(x, cell);
			if (cell.getWidth() === 0) continue; // second half of a wide character
			const key = sgr(cell);
			if (key !== cur) {
				text += `\x1b[0m${key ? `\x1b[${key}m` : ""}`;
				cur = key;
			}
			text += cell.getChars() || " ";
		}
		out.push(`${text}\x1b[0m`);
	}
	return `${out.join("\n")}\n`;
}

mkdirSync(outDir, { recursive: true });
let pos = 0;
for (const ev of events) {
	if (ev.at > pos) {
		await write(bytes.subarray(pos, ev.at));
		pos = ev.at;
	}
	if (ev.kind === "resize") term.resize(ev.cols, ev.rows);
	else {
		writeFileSync(join(outDir, `${ev.name}.txt`), screen());
		console.log(`dumped ${ev.name} at ${ev.at} (${term.cols}x${term.rows})`);
	}
}
for (const t of talls) {
	term = newTerminal(Number(size[1]), Number(size[2]));
	await write(bytes.subarray(0, t.at));
	term.resize(Number(size[1]), t.rows);
	writeFileSync(join(outDir, `${t.name}.txt`), screen());
	console.log(`dumped ${t.name} at ${t.at} (${term.cols}x${term.rows}, tall)`);
}
