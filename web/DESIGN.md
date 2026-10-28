---
name: Agentic OS
description: A quiet, text-first ledger for reviewing drafts and decisions on your own laptop.
---

# Design System: Agentic OS

Shipped in W2-08 (2026-10-28). The tokens live in `web/src/style.css`; this file says what they are for. The foundation was chosen from research on 2026-10-27 (`docs/week2/implementation-plan.md`, "Design system decision").

## Overview

**Creative North Star: "The Quiet Ledger"**

Mode: **Operate**. One person opens this to read drafts line by line, check where each line came from, and decide. Light and dark are equal themes that follow the OS (no switch, plan R15). Text first, status and facts before decoration, dense without crowding, calm enough to read a long draft in.

Structure follows GitHub's Primer: a persistent left navigation, dense ledger rows, flat bordered surfaces, a fixed status vocabulary, and a reading column for documents. Primer supplies the colour values; the app owns its components (no UI library; Reka UI only if a dialog, menu or tabs is ever truly needed, R14).

## Colors

**Strategy: Restrained.** Values are copied from `@primer/primitives` 11.10.0 (MIT), not imported: its light + dark theme files are ~39 kB gzipped, over R13's 30 kB gate. Light = Primer `light`; dark = Primer `dark-dimmed` (a soft grey ground, not near-black).

| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg` | `#f6f8fa` | `#212830` | The page ground. Never pure white or black. |
| `--field` | `#ffffff` | `#151b23` | Inputs only. |
| `--inset` | `#818b981f` | `#656c7633` | Source quotes, code, diffs, hover. |
| `--fg` | `#1f2328` | `#d1d7e0` | Text (14.8:1 / 10.3:1). |
| `--muted` | `#59636e` | `#9198a1` | Labels, hints, metadata (5.7:1 / 5.1:1). |
| `--border` | `#d1d9e0` | `#3d444d` | Separators and panels. |
| `--border-strong` | `#818b98` | `#656c76` | Form-control edges (3:1 non-text). |
| `--accent` | `#0969da` | `#539bf5` | Links, the current nav item, focus, the line in focus. Dark uses a dimmed scale step because `fgColor-accent` (#478be6) is 4.3:1 there. |
| `--accent-bg` / `--on-accent` | `#0969da` / `#fff` | `#316dca` / `#f0f6fc` | The one primary button per screen. |
| `--accent-tint` | `#ddf4ff` | `#4184e41a` | Background of the line in focus. |
| `--success`, `--attention`, `--danger` (+ `-tint`) | Primer `fgColor-*` / `bgColor-*-muted` | same; dark danger `#f47067` (4.0:1 for `#e5534b`) | Status outlines and notice grounds. Text on tints is always `--fg`. |
| `--add-word` / `--del-word` | `#aceebb` / `#ffcecb` | `#46954a66` / `#e5534b66` | Word diff (Primer `diffBlob-*Word-bgColor`). |

**The One Accent Rule.** One primary button per screen (Applications: "Tailor CV and letter"; application page: "Finalise and create files"). Approve/Reject, Save line, Retry export and the import are neutral buttons.

## Typography

- **Sans:** Primer's `fontStack-sansSerif` without Mona Sans (not loaded; no web fonts under the CSP). **Mono:** Primer's `fontStack-monospace`, for ids, cite markers, diffs and paths.
- **Scale:** page title 20/28 semibold; section 16/24 semibold; entry 15 semibold; UI body 14/20; labels and hints 12 muted.
- **Reading column:** drafts and letters at 16/26 with a 68ch measure (`--measure`). Tables use tabular figures.

## Layout

- Shell: a 12rem left nav (Applications, Review with a count badge) and a scrolling main area with 24/32 px padding. Spacing is Primer's 4 px scale (`--s1` 4 … `--s7` 48).
- **Queue / list:** a single dense table (`.ledger`) or stacked cards with a toolbar above.
- **Document:** the reading column; at ≥ 1180 px a sticky source panel (16–24rem) beside it shows the master text behind the line in focus and a word diff. Below that the same source block opens under the focused line. Works from 800 to 1600 px with no horizontal page scroll (checked at 800 and 1280).

## Elevation & Shapes

Flat. 1 px borders and tonal steps, no shadows. Radius 6 px (`--radius`) on controls, notices, panels and status labels; a full pill only for the nav count badge.

## Components

- **Status label** (`.status.working|ready|attention|danger|done`): a word, a tint and a 1 px outline in the status colour (no side-tab edge). Words come from `statusLabel()` in `stores/career.ts` for every state: the running step ("Writing the draft"), Ready for review, Needs your check, Failed, Creating files, Final, Files failed, Applied, Withdrawn.
- **Notice** (`.notice[.ok|.attention|.danger]`): a block with a 1 px border in the status colour; it opens with a bold sentence that names the state.
- **Draft line** (`DraftLine.vue`): text, an Edit button (or Source once final), "Check: this line …" tags from the verifier in words, "Edited by you, not re-checked". Focus or click selects it; the focused line gets the accent tint and edge. Edit in place: a textarea, Save line / Cancel, Ctrl+Enter saves, Esc cancels and returns focus to Edit.
- **Source** (`LineSource.vue`): each cited master line as a quote with its id, then "Changes from that text" with `<del>`/`<ins>` (strike-through and underline plus screen-reader "removed:"/"added:", never colour alone).
- **Master import** (`MasterImport.vue`): a neutral button with the outcome as a notice and file warnings as a list.

## Rules

- All model- and file-supplied text renders with `{{ }}`; Markdown, if ever needed, only through `renderMarkdown`. ESLint forbids `v-html`.
- Focus is a 2 px accent outline with 2 px offset on every interactive element.
- Motion: none. `prefers-reduced-motion` also switches off any transition.
- Status is always a word; colour only reinforces it.

## Don'ts

- No gradients, glows, shadows at rest, decorative icons or chat-assistant styling.
- No big-number stat tiles that don't lead to an action.
- No UI dependency for something native HTML and a few lines of CSS do.
