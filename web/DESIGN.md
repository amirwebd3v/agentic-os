---
name: Agentic OS
description: A quiet, text-first ledger for reviewing drafts and decisions on your own laptop.
---

<!-- SEED: established with the user before implementation; re-run /impeccable document once there's code to capture the actual tokens and components. -->

# Design System: Agentic OS

This replaces the Week 1 look (system font, blue accent, a session sidebar). The old look is evidence, not authority. The foundation was chosen from research on 2026-10-27 (see `docs/week2/implementation-plan.md`, "Design system decision").

## Overview

**Creative North Star: "The Quiet Ledger"**

Mode: **Operate**. One person opens this to read drafts line by line, check where each line came from, and decide. The scene: a laptop in a bright room by day and a dim one at night, so light and dark are equal first-class themes that follow the OS. The interface is a well-kept logbook: text first, status and facts before decoration, dense without crowding, calm enough to read a long draft in.

The structure comes from GitHub's Primer, the review-and-diff interface this app most resembles, not from a dashboard kit: a persistent left navigation, dense list rows, flat bordered surfaces, a clear state vocabulary, and a reading column for documents. Primer supplies the principles and the colour tokens. The app owns its own components.

**Key Characteristics:**
- Text-first and flat: structure comes from borders, spacing and weight, not shadows or ornament.
- One restrained accent, used for the current location and the primary action, nothing else.
- State is always visible: every item shows its status (pending, processing, flagged, failed, final) in words, not colour alone.
- Documents get a reading column; queues get dense rows.
- Motion is functional only: focus, expand/collapse, progress; none otherwise, and none under `prefers-reduced-motion`.

## Colors

**Strategy: Restrained.** Neutrals tinted slightly cool plus one accent. The exact values are taken from Primer's primitives when W2-08 implements this [to be resolved during implementation]: the semantic roles below are the commitment.

- **Ground and surfaces:** a quiet off-white in light and a soft dark grey in dark. Never pure white or pure black, so long reading doesn't glare.
- **Text:** one strong foreground and one muted foreground; both meet WCAG 2.2 AA on every surface they sit on.
- **Accent:** a single blue-leaning hue for the current nav item, links and the primary button.
- **Status roles:** success, attention, danger and neutral, each paired with a word and an icon-free marker (for example "Flagged"), never colour alone.
- **Diff roles:** added and removed lines use a tinted ground *and* a `+` / `−` marker.

**The One Accent Rule.** The accent covers well under a tenth of any screen. If two things on a screen are accent-coloured, one of them is wrong.

## Typography

**Face:** the platform UI stack for text (Operate surfaces are best served by a workhorse stack), and the platform monospace for ids, hashes, diffs and cite markers [exact stacks to be resolved during implementation].

**Character:** neutral and legible. Hierarchy comes from size, weight and spacing, not from a display face.

- A small, tight scale: one page title, section titles, body, and a muted small label.
- **Reading column:** drafts and cover letters use a measure of about 65–75 characters and a comfortable line height; queue rows use a tighter line height.
- Numbers in tables and counts use tabular figures.

## Layout

A persistent left navigation (Review now; Applications once W2-08 ships) beside a main area. Two main-area shapes:
- **Queue:** a single dense list with a toolbar above it.
- **Document:** a reading column on the left and, on wide screens, a source panel on the right that shows the master-CV bullet behind the line in focus. Below about 900 px the source panel moves under the line.

One spacing rhythm on a 4 px base [to be confirmed against Primer's scale]. More space above a heading than below it. Works from 800 px to 1600 px wide; no horizontal page scroll.

## Elevation & Depth

Flat by default. Surfaces are separated by 1 px borders and tonal steps. There are no shadows at rest. A single subtle shadow may mark a transient layer (a menu or dialog) if one is ever needed.

**The Flat-By-Default Rule.** If a surface needs a shadow to be seen, it needs a border instead.

## Shapes

Small, consistent corner radii (about 6 px) on controls, rows and panels; a full pill only for count badges. Borders are 1 px and low-contrast. No clipping tricks, no decorative geometry.

## Do's and Don'ts

### Do:
- **Do** show a status word on every item and every state transition.
- **Do** show a generated line next to its source text, with `+` / `−` markers on diffs.
- **Do** give every interactive element a visible focus ring that meets WCAG 2.2 focus appearance.
- **Do** follow the OS theme and `prefers-reduced-motion`.
- **Do** render all model- and file-supplied text as text or through the sanitized Markdown path.

### Don't:
- **Don't** add heavy decoration, ornament or motion (confirmed by the owner).
- **Don't** use gradients, glows, sparkles or chat-assistant styling.
- **Don't** build rows of big-number stat tiles that don't lead to an action.
- **Don't** convey meaning by colour alone.
- **Don't** add a UI dependency for something native HTML and a few lines of CSS do. If a widget is genuinely complex (dialog, menu, tabs), use the unstyled, accessible Reka UI primitives and style them here, after checking the current version and licence in that ticket.
