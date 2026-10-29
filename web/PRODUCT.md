# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One person: the owner of this installation, working alone on their own laptop. There are no other accounts, roles or audiences. They open the app in short sessions to review what the system drafted or proposes, and to see what is pending.

## Product Purpose

A private, local-first knowledge base over the areas of the owner's life (career first; email, social accounts and the blog next), with one-click automations that produce **drafts only**, and a status view of what is done, pending and next. Success: the owner can tailor a job application in one click, trust that every generated line traces to their own master CV, and see at a glance what needs them.

## Positioning

Privacy and accuracy are enforced in code, not promised: contact details never reach a model, untrusted text (job postings, mail) is quarantined, every generated line cites its source bullet and is machine-verified, and nothing is sent, published or submitted by the system.

## Operating Context

Runs on `127.0.0.1` on the owner's Windows laptop, served by the app's own server. Notes live in an Obsidian vault the owner also edits by hand. Text is generated through the Claude API. Documents the owner sends are Word and PDF files. The owner reads drafts line by line, in a bright room by day and a dim one at night. Content is in English and German.

## Capabilities and Constraints

Built: a review queue (today it carries vault-conflict items) and a provider-status banner. Planned in `docs/week2/implementation-plan.md`: master-CV import, job-posting intake, a tailoring pipeline with a verifier, an application page (per-line sources, diff against the master CV, edit in place, status), `.docx` downloads, job-status polling, and a Home page that shows what is done, what waits on the owner and what comes next.

Constraints: drafts only; all text from a model or a file renders as text or through the sanitized Markdown path, never as raw HTML; a strict CSP (no inline script, no in-browser PDF preview); local only; Vue 3 + Vite + Pinia with hash routing; no new UI dependency without a ticket that needs it.

Undecided: the email and social/blog slices (they follow the career slice), charts or trends, and a dark/light override setting (decided against for now).

## Brand Commitments

The product name is "Agentic OS". No logo, voice or other brand assets exist or are committed.

## Evidence on Hand

No real user data lives in the repository; test fixtures are synthetic. The owner's CV, postings and contact details stay outside the repo, so there is no real content to design with yet and none may be invented.

## Product Principles

1. **Draft only.** The system proposes; the owner decides and sends.
2. **Every claim shows its source.** A generated line is shown next to the owner's own words it came from.
3. **Failures are visible and specific.** A step that fails says so within seconds; nothing retries silently for an hour.
4. **Private by construction.** Sensitive data is kept out of prompts, logs and the UI by code, not by care.
5. **One click for the routine, a clear stop for anything consequential.**

## Accessibility & Inclusion

[inferred, to confirm] Target WCAG 2.2 AA. Fully usable by keyboard. Follows the OS light/dark setting and `prefers-reduced-motion`. Meaning is never carried by colour alone (diffs already use `+`/`−` markers). UI language is English; content may be English or German.
