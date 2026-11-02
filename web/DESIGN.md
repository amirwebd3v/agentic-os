---
name: Agentic OS
description: An editorial workspace for reading, correcting and tracking what the app drafts for you.
---

# Design System: Agentic OS

Redesigned 2026-10-29 (replaces "The Quiet Ledger" of W2-08). Tokens live in `web/src/style.css`; this file says what they are for.

## Overview

**Creative North Star: "The Editorial Workspace"**

Mode: **Operate**. One person opens this in short sessions to answer one question, "what do I do next?", then reads drafts line by line. The drafts are documents, so they are set like documents: a text serif at reading size, with the interface around them in the platform sans. Calm, flat, warm-neutral paper; one accent; light and dark follow the OS (no switch).

## Colors

**Strategy: Restrained.** One ground, one ink, one accent; status colours only reinforce a word.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg` | `#f6f5f1` | `#141514` | Paper ground. Never pure white or black. |
| `--surface` | `#fdfcf9` | `#1b1c1b` | Panels, notices, the source panel, row hover: one tone step up. |
| `--field` | `#ffffff` | `#0f100f` | Inputs only. |
| `--inset` | ink at 4–5% | white at 5% | Hover, quotes, chips. |
| `--fg` / `--muted` | `#1c1d1f` / `#5d6064` | `#e8e6e1` / `#a2a19c` | Text (15.9:1 / 6.1:1 light). |
| `--border` / `--border-strong` | `#e3e1db` / `#8d9095` | `#2d2e2c` / `#6c6d69` | Row rules / control edges and section rules (3:1). |
| `--accent` | `#1f5f4a` | `#74c9a5` | Links, current nav item, focus ring, the line in focus. |
| `--accent-bg` | `#1f5f4a` | `#2b7a5f` | The one primary button per screen. |
| `--success` `--attention` `--danger` (+ `-tint`) | green / amber / red | lifted for dark | Status dots and notice grounds; text on tints stays `--fg`. |

## Typography

- **Newsreader** (variable, optical size; self-hosted from `@fontsource-variable/newsreader`, served from `'self'` so the CSP stays strict): page titles, section titles, application and entry names, every draft and master CV line, source quotes.
- **Platform sans** (`Segoe UI Variable` first): navigation, buttons, labels, hints, tables, forms.
- **Scale:** Home greeting 44/50; page title 34/40; section 22/28 (26/32 inside a draft); draft text 18/29 at a 68ch measure; UI body 15/22; hints 13/19. Tabular figures in tables and dates.

## Layout

- A sticky top bar: wordmark, Home · Applications · Master CV · Review (with a count), a `?` for shortcuts, and "New application". Content sits in one centred column (max 76rem) with equal 32 px margins (16 px on a phone).
- **Home** answers "what do I do next?" in groups, in this order: Needs you (including a final draft you still have to send, and pending reviews), Follow-ups due, In progress, Sent, then Email and Social as "not connected". Rows, not tiles; each row has its next step in words and at most one inline action.
- **Applications**: search (`/`), filter chips with counts (All, Needs you, Follow up, In progress, Sent, Archived), select rows to archive, restore or delete in bulk.
- **Application page**: names and actions (Retry, Rename, Archive, Delete) at the top, then the state notice, then the draft as a document with its sources beside it at ≥ 1180 px (below the focused line otherwise). Removed lines stay one click from "Put back".
- **Email** (redesigned 2026-11-02, Operate, "achromatic ledger" inside this palette): the title row is one status sentence that leads with what needs you (an account to reconnect, sorting paused), then mail to sort, last sync and whether Claude analysis is on. Below it three columns: the views (Needs sorting, each category, Sender rules, with counts) at 14rem; the open view, fluid; the status rail (accounts, Claude analysis, learning) at 17rem. The open view is in the URL (`?view=`). A category leads with its paragraph, set as reading text, then its mail as a table with a quiet Move menu per row. Under 1100px the rail moves under the open view; under 720px the views become one select.
- **Master CV**: the whole master as an editable document (entries with their header fields, lines, skills, languages), reorder with Up/Down, a sticky save bar while there are unsaved changes, `Ctrl S` saves. A save refuses to overwrite a change made meanwhile in Obsidian.

## Elevation & Shapes

Flat. Surfaces differ by tone and 1 px rules, never by shadow. Only things that float get a shadow: the save bar and the shortcuts dialog. Buttons and status labels are fully round (pill); inputs, panels and notices use `--radius` 8 px.

## Components

- **Status** (`.status.working|ready|attention|danger|done|archived`): a word with a coloured dot on a tint. The working dot pulses (off under reduced motion). Words come from `statusLabel()`.
- **Next step** (`nextStep()` in `stores/career.ts`): the Home group and the owner's next action in words, shared by Home and the list filters.
- **Notice** (`.notice[.ok|.attention|.danger]`): opens with a bold sentence naming the state.
- **Draft line** (`DraftLine.vue`): its Edit and Remove actions appear on hover or focus (always on touch); the focused line gets the accent tint. `j`/`k` move between lines, `e` edits.
- **Save bar** (`.savebar`): inverted pill, only while something is unsaved.

## Rules

- All model, file and owner text renders with `{{ }}` or `v-model`; Markdown only through `renderMarkdown`. ESLint forbids `v-html`.
- Focus is a 2 px accent outline, 2 px offset, on every control.
- Motion: 120 ms colour and opacity changes on controls and the pulsing working dot; `prefers-reduced-motion` turns all of it off.
- Status is always a word; colour only reinforces it.
- Single-key shortcuts never fire inside a field, a dialog or with a modifier (`keys.ts`).

## Don'ts

- No gradients, glows, glass, decorative icons or emoji, no unicode arrows as icons.
- No coloured side stripes on lines, cards or notices.
- No big-number stat tiles; Home is rows that lead to an action.
- No web font from a third-party host; no UI dependency for what native HTML and a few lines of CSS do.
