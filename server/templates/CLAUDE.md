# Vault rules

This file is the rulebook for Agentic OS and for any Claude session opened in this vault. Edit it freely: the app re-reads `## Areas` at every boot.

## Areas

<!-- One line per top-level area: - `slug` | Name | mode | description
     mode is do | explain | tutor. The description is the text the decider matches against.
     Removing a line archives the area (never deletes it). A malformed line stops the sync, so nothing is archived by a typo. -->
- `software-development` | Software development | do | Code, tools, debugging, architecture and dev environment work.
- `studies` | Studies | tutor | MSc cybersecurity: courses, assignments, exams and thesis.
- `career` | Career | do | Jobs, applications, CV, interviews, networking and professional growth.
- `admin-finance` | Admin & finance | do | Bills, taxes, insurance, contracts, bureaucracy, banking and budgeting.
- `health` | Health | do | Medical appointments, fitness, sleep, nutrition and mental health.
- `home-household` | Home & household | do | Housing, repairs, shopping, chores and moving.
- `relationships-social` | Relationships & social | do | Friends, family, events and how I want to show up for people.
- `learning-reading` | Learning & reading | do | Books, articles, courses and self-study outside the degree.
- `projects-side` | Side projects | do | Personal projects that are not part of studies or paid work.
- `personal-reflection` | Personal reflection | do | Journaling, goals, values, reviews and decisions about my life.

## Area modes

- `do`: carry out the task.
- `explain`: explain how, let me do it.
- `tutor`: teach. Explain the concept and ask me questions before giving any solution.

## Sensitivity tiers

- **T0 public:** already public, e.g. published posts, open-source code.
- **T1 personal (default):** everyday notes, study material, plans, preferences.
- **T2 sensitive:** health details, finances, relationships, private reflection. Never sent to a model unless my request explicitly targets it.
- **T3 never ingest:** passwords, 2FA seeds and codes, card or bank numbers, ID or passport scans, tax IDs. Redacted before storage; never written to this vault.

## Filing rules

- Top-level areas are the list above. To add one, add a line to that list: the app reads it at every boot.
- Every item has exactly one primary area, plus any number of tags.
- Unsure? File to `inbox/` and flag it for review.

## Behaviour rules

- Never send anything (email, message, post, invite) on my behalf.
- Never build profiles of third parties. Notes about other people are only what I wrote myself.
- In `tutor` areas, explain and ask before solving.
- Never overwrite a note I edited; propose the change for review instead.

## Folders

- `career/`: my master CV and contact details (`master.md`, `contact.md`); the app reads them to tailor applications.
- `wiki/`: lasting knowledge, by area.
- `journal/`: dated entries.
- `inbox/`: unfiled items waiting for review.
- `outputs/`: drafts and documents the app produced.
- `exports/`: nightly JSONL exports of database tables.
- `attachments/`: files linked from notes (not committed).
