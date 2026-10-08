#!/bin/bash
# shoot.sh light|dark: one real pi session in tmux on the demo project. tmux records every
# byte that pi writes; the manifest notes the byte position of each screen (and resizes).
# pi uses its light or dark theme, as in a light or dark terminal.
set -u
MODE=$1
DIR=$(cd "$(dirname "$0")" && pwd)
WORK=${WORK:-/tmp/pi-wf-shots}
DEMO=$WORK/demo-shop
SOCK=pi-wf-shots-$MODE
STREAM=$WORK/stream-$MODE.log
MANIFEST=$WORK/manifest-$MODE.txt
if [ "$MODE" = light ]; then FGBG="0;15"; STYLE='bg=#f1efe7,fg=#37342e'; else FGBG="15;0"; STYLE='bg=#000000,fg=#dddddd'; fi

# A fresh copy of the demo project (a git repository, as a real project).
mkdir -p "$WORK"; rm -rf "$DEMO"; cp -R "$DIR/demo-shop" "$DEMO"
(cd "$DEMO" && git init -q && git add -A && git -c user.name=demo -c user.email=demo@example.com commit -qm "demo shop")
rm -f "$STREAM"; echo "size 110 34" > "$MANIFEST"

T() { tmux -L "$SOCK" "$@"; }
keys() { T send-keys -t main "$@"; }
cap() { T capture-pane -p -t main; }
grab() { sleep 0.3; echo "grab $1 $(stat -f %z "$STREAM" 2>/dev/null || stat -c %s "$STREAM")" >> "$MANIFEST"; echo "grabbed $1"; }
resize() { echo "resize $(stat -f %z "$STREAM" 2>/dev/null || stat -c %s "$STREAM") $1 $2" >> "$MANIFEST"; T resize-window -t main -x "$1" -y "$2"; }
waitfor() { for _ in $(seq 1 "${2:-60}"); do if cap | grep -q -- "$1"; then return 0; fi; sleep 1; done; echo "TIMEOUT: $1"; return 1; }
waitgone() { for _ in $(seq 1 "${2:-60}"); do if ! cap | grep -q -- "$1"; then return 0; fi; sleep 1; done; echo "TIMEOUT (still there): $1"; return 1; }

T kill-server 2>/dev/null
T -f /dev/null new-session -d -s main -x 110 -y 34 -c "$DEMO" \
	-e COLORFGBG="$FGBG" -e COLORTERM=truecolor -e PI_WORKFLOW_MAX_CONCURRENT_AGENTS=4 "sleep 0.4; exec pi"
# pi runs directly in the pane (so it gets window resizes); tmux pipes its output to the file.
T pipe-pane -o -t main "cat >> $STREAM"
T set -g window-style "$STYLE"
T set -as terminal-features ',*:RGB'
T set -g window-size manual
waitfor "session 0m" 30 || exit 1
sleep 1

# 1. The keyword in the editor (not sent).
keys "ultracode audit every route handler under src/routes for missing auth checks"; sleep 1; grab keyword; keys C-u; sleep 0.5

# 2. Approval, then the live run.
keys "/audit-routes"; sleep 1; keys Enter
waitfor "Run workflow?" 90 && sleep 0.5 && grab approval
keys Enter
waitfor "Audit [0-9]" 120 && sleep 2 && grab taskline
keys M-w; sleep 1.2; grab runs
keys Enter; sleep 1.5; grab run-mid
keys t; sleep 1; grab timeline-mid
keys Escape; sleep 0.4; keys j; sleep 0.3; keys Enter; sleep 1; grab phase-mid
keys Enter; sleep 1; grab agent-mid
keys Escape; sleep 0.3; keys Escape; sleep 0.3

# 3. The end of the run.
waitfor "completed" 240; sleep 1.5; grab run-end
keys t; sleep 1; grab timeline-end
keys Escape; sleep 0.4; keys j; sleep 0.2; keys j; sleep 0.2; keys j; sleep 0.2; keys Enter; sleep 0.8; keys Enter; sleep 1; grab agent-report
keys Escape; sleep 0.3; keys Escape; sleep 0.3; keys k; sleep 0.2; keys Enter; sleep 0.8; grab phase-verify-end
keys q; sleep 1

# 4. The conversation with the result card: wait for the agent's answer, then a tall window.
waitgone "Working" 120; sleep 3
resize 110 100; sleep 2; grab transcript-tall
resize 110 34; sleep 2

# 5. A hung agent: the quiet warning, then an interrupt with a message.
keys "/hang-demo"; sleep 1; keys Enter
waitfor "Run workflow?" 90 && sleep 0.5 && keys Enter
waitfor "Wait 0/1" 120; sleep 2
keys M-w; sleep 1; keys Enter; sleep 0.8; keys Enter; sleep 0.8; keys Enter; sleep 1
waitfor "No activity for 1m" 150; sleep 1; grab hang-agent
keys Escape; sleep 0.6; grab hang-list
keys i; sleep 0.6; keys "The command hangs. Do not run it again. Reply with the word stopped."; sleep 0.6; grab hang-interrupt
keys Enter; sleep 1
waitfor "1/1 finished" 120; sleep 1.5; grab hang-done
keys q; sleep 0.5
T kill-server
echo "shoot $MODE done: $STREAM"
