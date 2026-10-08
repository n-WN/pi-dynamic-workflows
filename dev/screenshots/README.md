# README screenshots

The screenshots in [docs/screenshots](../../docs/screenshots/README.md) are real captures.
These scripts make them again, for example after a UI change.

## How it works

1. `shoot.sh light|dark` copies the demo project ([demo-shop](demo-shop): a small
   API with six route files, an `audit-routes` workflow, and a `hang-demo` workflow) to
   `/tmp/pi-wf-shots/demo-shop` and starts pi there in tmux, 110×34. pi uses its light
   or dark theme, as in a light or dark terminal. tmux records every byte that pi writes
   (`pipe-pane`). The script drives a real session with the keys a user would press:
   the keyword in the editor, `/audit-routes`, the approval, the monitor views during
   and after the run, the result card, and a hung agent that gets an interrupt. For
   each screen it notes the byte position in a manifest.
2. `render.sh` replays the recorded bytes in xterm.js (`dump.mjs`, a terminal
   emulator in Node) and writes each screen as ANSI text from the emulator's cells. A
   replay is more faithful than `tmux capture-pane`: tmux's grid loses the background of
   some cells that pi draws. `snap.mjs` crops each screen (an overlay box, or a span of
   rows found by its text) and draws it with xterm.js in headless Chrome: Menlo 12,
   2x, in three terminal color sets (dark, light, warm light). The light and warm light
   sets come from the light session; pi writes the same colors for both. The images
   are lossless WebP.

## Run

Needs tmux, Chrome or Chromium (`CHROME` sets the path), `cwebp`, and a pi with this
package installed. The runs use your default model and cost tokens (with a fast model,
about 400k tokens per session).

```bash
cd dev/screenshots
npm install
./shoot.sh light
./shoot.sh dark
./render.sh            # writes ../../docs/screenshots/{dark,light,warm}/*.webp
```

`WORK` sets the work directory (default `/tmp/pi-wf-shots`). The live run is not the
same each time (the agents write their own words), so check the images before you
commit them.
