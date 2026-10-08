#!/bin/bash
# render.sh: replay both recordings in xterm.js, crop every screen, and draw it in three
# terminal color sets (warm and light from the light-theme session, dark from the dark one).
set -u
DIR=$(cd "$(dirname "$0")" && pwd)
WORK=${WORK:-/tmp/pi-wf-shots}
OUTROOT=$DIR/../../docs/screenshots
for mode in light dark; do node "$DIR/dump.mjs" "$WORK/stream-$mode.log" "$WORK/manifest-$mode.txt" "$WORK/screens/$mode" | tail -1; done
snap() { # theme source screen mode args...
	local theme=$1 src=$2 name=$3; shift 3
	TERMTHEME=$theme FROM=$WORK/screens/$src/$name.txt OUT=$OUTROOT/$theme node "$DIR/snap.mjs" "$@" | tail -1
}
for pair in "warm light" "light light" "dark dark"; do
	set -- $pair; theme=$1; src=$2
	for n in approval runs run-mid timeline-mid phase-mid agent-mid run-end timeline-end agent-report phase-verify-end hang-agent hang-list hang-interrupt hang-done; do
		snap "$theme" "$src" "$n" box "$n" "╭"
	done
	snap "$theme" "$src" keyword span keyword "runs as a workflow" "runs as a workflow" 2
	snap "$theme" "$src" taskline span taskline "workflow audit-routes ·" '$'
	TERMTHEME=$theme FROM=$WORK/screens/$src/transcript-tall.txt OUT=$OUTROOT/$theme node "$DIR/snap.mjs" span result-card "Workflow audit-routes completed ·" "full result" 1 | tail -1
done
# Lossless WebP: the same pixels, a third of the size.
for f in "$OUTROOT"/*/*.png; do cwebp -quiet -lossless -z 9 "$f" -o "${f%.png}.webp" && rm "$f"; done
rm -f "$OUTROOT"/*/*.ansi
echo "done: $OUTROOT"
