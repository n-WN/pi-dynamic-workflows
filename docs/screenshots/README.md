# Screenshots

Every screen of the extension in three terminals. Click an image to see it in full size.

| Set | Terminal | pi theme |
|---|---|---|
| **Dark** | black background, kitty's default palette | dark |
| **Light** | white background, the macOS Terminal palette | light |
| **Warm light** | `#f1efe7` background, `#37342e` text (the author's kitty) | light |

## How they are made

These are real captures, not mockups. pi 1.1.0 runs in tmux on a small demo project
([dev/screenshots/demo-shop](../../dev/screenshots/demo-shop)) with real agents. tmux
records every byte that pi writes to the terminal. The bytes are then replayed in
xterm.js, a terminal emulator, and each screen is cropped from the emulator's cells
and drawn with Menlo 12 at 2x. The dark set comes from a session in which pi uses its
dark theme; the light and warm light sets come from one session in which pi uses its
light theme (pi writes the same colors for both, so only the terminal's own colors
differ). The images are lossless WebP. To make them again, see
[dev/screenshots](../../dev/screenshots/README.md).

## The keyword in the editor

The editor highlights `ultracode` and says what it does.

| Dark | Light | Warm light |
|---|---|---|
| ![The keyword in the editor, dark](dark/keyword.webp) | ![The keyword in the editor, light](light/keyword.webp) | ![The keyword in the editor, warm light](warm/keyword.webp) |

## The approval dialog

Phases with details, facts from the script, tools, model, budget, and the choices.

| Dark | Light | Warm light |
|---|---|---|
| ![The approval dialog, dark](dark/approval.webp) | ![The approval dialog, light](light/approval.webp) | ![The approval dialog, warm light](warm/approval.webp) |

## During a run: the tool row and the task line

The tool row in the conversation updates live; the task line sits below the editor.

| Dark | Light | Warm light |
|---|---|---|
| ![During a run: the tool row and the task line, dark](dark/taskline.webp) | ![During a run: the tool row and the task line, light](light/taskline.webp) | ![During a run: the tool row and the task line, warm light](warm/taskline.webp) |

## The run list

`/workflows` (or `alt+w`): runs of this session and a summary of the selected one.

| Dark | Light | Warm light |
|---|---|---|
| ![The run list, dark](dark/runs.webp) | ![The run list, light](light/runs.webp) | ![The run list, warm light](warm/runs.webp) |

## The run view, during a run

Status words in the bar's colors, live slots, and an activity track per phase.

| Dark | Light | Warm light |
|---|---|---|
| ![The run view, during a run, dark](dark/run-mid.webp) | ![The run view, during a run, light](light/run-mid.webp) | ![The run view, during a run, warm light](warm/run-mid.webp) |

## The run view, at the end

The tracks show the shape of the run: Discover, then Audit, then the Verify fan-out, then Report.

| Dark | Light | Warm light |
|---|---|---|
| ![The run view, at the end, dark](dark/run-end.webp) | ![The run view, at the end, light](light/run-end.webp) | ![The run view, at the end, warm light](warm/run-end.webp) |

## The timeline, during a run

One bar per agent; dots are time spent waiting for a free slot.

| Dark | Light | Warm light |
|---|---|---|
| ![The timeline, during a run, dark](dark/timeline-mid.webp) | ![The timeline, during a run, light](light/timeline-mid.webp) | ![The timeline, during a run, warm light](warm/timeline-mid.webp) |

## The timeline, at the end

Barriers between phases and the slow tail of a phase at a glance.

| Dark | Light | Warm light |
|---|---|---|
| ![The timeline, at the end, dark](dark/timeline-end.webp) | ![The timeline, at the end, light](light/timeline-end.webp) | ![The timeline, at the end, warm light](warm/timeline-end.webp) |

## The phase view (Audit)

The agents of a phase, and a preview of the selected one.

| Dark | Light | Warm light |
|---|---|---|
| ![The phase view (Audit), dark](dark/phase-mid.webp) | ![The phase view (Audit), light](light/phase-mid.webp) | ![The phase view (Audit), warm light](warm/phase-mid.webp) |

## The phase view (Verify)

Two independent checks per finding, all confirmed.

| Dark | Light | Warm light |
|---|---|---|
| ![The phase view (Verify), dark](dark/phase-verify-end.webp) | ![The phase view (Verify), light](light/phase-verify-end.webp) | ![The phase view (Verify), warm light](warm/phase-verify-end.webp) |

## An agent: structured result

Model, tokens, tools, transcript, prompt, tool calls, and the result as highlighted JSON.

| Dark | Light | Warm light |
|---|---|---|
| ![An agent: structured result, dark](dark/agent-mid.webp) | ![An agent: structured result, light](light/agent-mid.webp) | ![An agent: structured result, warm light](warm/agent-mid.webp) |

## An agent: markdown result

A text result renders as markdown; the scroll position is in the border.

| Dark | Light | Warm light |
|---|---|---|
| ![An agent: markdown result, dark](dark/agent-report.webp) | ![An agent: markdown result, light](light/agent-report.webp) | ![An agent: markdown result, warm light](warm/agent-report.webp) |

## The result card

What arrives in the conversation when the run ends.

| Dark | Light | Warm light |
|---|---|---|
| ![The result card, dark](dark/result-card.webp) | ![The result card, light](light/result-card.webp) | ![The result card, warm light](warm/result-card.webp) |

## A hung agent

No activity for over a minute: the agent list shows it as quiet.

| Dark | Light | Warm light |
|---|---|---|
| ![A hung agent, dark](dark/hang-list.webp) | ![A hung agent, light](light/hang-list.webp) | ![A hung agent, warm light](warm/hang-list.webp) |

## A hung agent: detail

The detail view says what you can do.

| Dark | Light | Warm light |
|---|---|---|
| ![A hung agent: detail, dark](dark/hang-agent.webp) | ![A hung agent: detail, light](light/hang-agent.webp) | ![A hung agent: detail, warm light](warm/hang-agent.webp) |

## Interrupt with a message

`i` stops only the hanging step; the agent keeps its conversation.

| Dark | Light | Warm light |
|---|---|---|
| ![Interrupt with a message, dark](dark/hang-interrupt.webp) | ![Interrupt with a message, light](light/hang-interrupt.webp) | ![Interrupt with a message, warm light](warm/hang-interrupt.webp) |

## After the interrupt

The agent went on and answered.

| Dark | Light | Warm light |
|---|---|---|
| ![After the interrupt, dark](dark/hang-done.webp) | ![After the interrupt, light](light/hang-done.webp) | ![After the interrupt, warm light](warm/hang-done.webp) |
