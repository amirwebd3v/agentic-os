# Week 1 retro (2026-10-26)

**Result:** all 13 tickets done in one day of wall-clock time, built by 11 parallel Claude sessions plus a coordinator. 21 PRs merged (#14–#35, with #26 closed as a duplicate). `main`: server 131 + web 38 tests, no known vulnerabilities, no leaked secrets in history. 3 acceptance items are left for you (Obsidian ×2, the network-unplugged check).

## What worked
- **Contract files before parallel work.** `api-contract.md` and `review-contract.md` let backend/UI and producer/consumer pairs build at the same time with almost no rework. The two contract deviations were caught and documented by the implementing session.
- **Clear file ownership in every brief.** That removed real conflicts; the only ones left were `pnpm-lock.yaml`, root `package.json` scripts, `main.ts` plugin lines and `CLAUDE.md` Lessons, which are all mechanical.
- **The coordinator verifies, then merges.** Running verify independently at each head caught things the sessions' own reports missed:
  - the flaky git timeout;
  - the static wildcard 404;
  - the stranded late commits.
- **Live checks beat unit tests for integration bugs.** The pre-Wave-4 live run found three issues no test had:
  - the sidecar orphan on Windows;
  - Laya's `none`-option misfiling;
  - `uv` missing from PATH in already-open shells.
- **The learning loop.** 17 lessons in `CLAUDE.md`. The repeat mistakes now have mechanical guards:
  - the pre-push verify hook and its `GIT_*` scrub;
  - `--match-head-commit`;
  - injected `webDist`;
  - the test timeout;
  - stale-sidecar reaping.

## What took longer than planned
| Item | Why | Lesson |
|---|---|---|
| Message ordering between sessions | Messages are queued per turn, so "ready" and "rebase please" crossed constantly | One explicit state per message, and "push nothing after ready" (`CLAUDE.md` rule 8) |
| Late pushes after merge (×4) | Sessions kept improving their branch after reporting ready | `--match-head-commit`; follow-ups only on request |
| Windows specifics | The PATH of running shells, grandchild processes surviving kills, long temp paths, no Visual Studio | Fixed install locations, reap-on-start, short paths, prebuilt binaries only |
| The provider decision | 9router + `cc/*` subscription vs. a Console key | Keep the provider config-only; the smoke test decides the features |
| W1-10's "new area" behaviour | Laya is confident (0.87) on the cat case, so it never escalates | Expected for small deciders. Calibrate on your own data in Month 1 |

## Re-pointing Month 1
1. **Calibrate before auto-filing.** Everything is still `flagged`. Collect 50+ of your own corrections (re-files in the UI), then fit the confidence threshold for ≥95% precision (plan M12). Also run the Laya-vs-Kev-0.8B benchmark on that set.
2. **The `items` table + extraction** (planned for Month 1). Today, decisions and to-dos live only as Markdown sections in the summary notes.
3. **Hybrid search** (FTS5 + sqlite-vec + bge-m3 in the sidecar) is the next big capability. Chat has no tools yet.
4. **Before Gmail:** the job runner needs a lock token and one worker per kind (see [[debt]]: `runner.ts` / `jobs.ts`), so a slow mail sync can't starve filing.
5. **Docling ingestion** reuses the sidecar process.
6. **Process:** keep the waves of 2–4 sessions, write a contract file per wave, and have the coordinator do a live run between waves. It found more than the per-PR checks did.

## Open for you
- Open the vault and a session summary note in Obsidian (W1-08, W1-10).
- Classify once with the network unplugged (W1-09).
- `agentic-os.json` in the repo root still lists `cc/claude-sonnet-5-5` / `cc/claude-opus-5-5`. They're overridden by `.env`, so it's harmless, but it may confuse you later.
- 9router listens on `0.0.0.0:20128` with no key required. Bind it to `127.0.0.1` and set `REQUIRE_API_KEY=true`.
