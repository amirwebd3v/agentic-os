# Week 1 acceptance (W1-13)

*Recorded 2026-10-26, at `main` after PR #34. Legend: ✅ verified · ⬜ open, needs you · N/A doesn't apply to the chosen setup.*

**Overall:** 33 ✅, 3 ⬜ (all manual: Obsidian ×2, network-unplugged), 1 N/A. `pnpm verify` is green: server 130, web 38.

## How things were verified
- **Every merge:** the coordinator ran `pnpm verify` at the PR's head commit before merging. Web PRs were also built first.
- **Pre-Wave-4 live run (2026-10-26)** on a fresh GitHub clone with throwaway config and temp dirs:
  - 16/16 live HTTP security checks;
  - 10/10 live vault checks;
  - the Laya sidecar on the GPU;
  - a 9router smoke test (see PR #27's description for the transcript).

## Results
| Ticket | Criterion | | Evidence |
|---|---|---|---|
| W1-01 | Clean clone `pnpm i && pnpm verify` | ✅ | Fresh GitHub clone, frozen-lockfile install, 65/65 at the time; the hook was enabled automatically |
| W1-01 | No config or data files tracked | ✅ | `git ls-files`; `parseConfig` refuses data dirs inside the repo (tested) |
| W1-01 | Config tests | ✅ | `server/test/config.test.ts` |
| W1-02 | Fresh `brain.db`, migrated | ✅ | `db.test.ts`; `user_version` is now 4 (`0001`–`0004`) |
| W1-02 | Audit log append-only + hash chain | ✅ | Triggers + tampering test; the live chain verified after the vault run |
| W1-02 | Idempotent jobs, stale-lock recovery | ✅ | `db.test.ts` |
| W1-03 | Key in Windows Credential Manager | ✅ | Real set/get on the machine; `pnpm secrets status` shows the source |
| W1-03 | No key in git or logs | ✅ | Secret scan below; pino redaction; login token never logged (live check) |
| W1-04 | Security tests | ✅ | `security.test.ts`, plus 16 live HTTP checks: Host, Origin, X-AOS, single-use login, CSP, decoy cookie |
| W1-04 | Loopback-only bind | ✅ | `netstat`: only `127.0.0.1:3000` / `:3100` |
| W1-04 | Login and cookie survive a restart | ✅ | W1-04 live check |
| W1-05 | No-key mode | ✅ | `llm.test.ts`; the banner in the UI |
| W1-05 | 6/6 smoke against `api.anthropic.com` | N/A | You use 9router (`cc/*`) and have no Console key. Switching is a `.env` change; re-run `pnpm smoke` then. |
| W1-05 | 9router with config only | ✅ | Live `pnpm smoke`: plain, stream, tools (parallel), cache (19,425 tokens read), structured and errors ✅; batch ⏭ (404, recorded as a capability flag) |
| W1-05 | Every call in `llm_calls` | ✅ | `llm.test.ts`, failures included |
| W1-06 | Kill mid-stream → "interrupted" kept | ✅ | W1-06 live: hard kill, 521 chars kept as `aborted` |
| W1-06 | 100 sessions listed in under 100 ms | ✅ | W1-06 seed + timing |
| W1-06 | No key → clear error, no crash | ✅ | 409 `provider_not_configured`, tested |
| W1-07 | Create, stream, stop, re-file, interrupted | ✅ | W1-07 e2e via Vite, and again on the production build under CSP |
| W1-07 | Remote image → no request | ✅ | Markdown `![]()` and raw `<img>` → "[image blocked]", zero requests (network log) |
| W1-07 | Provider banner | ✅ | Checked against the mock (the live provider is configured) |
| W1-08 | Vault opens cleanly **in Obsidian** | ⬜ | `vault:init` structure verified live; opening it in Obsidian is for you |
| W1-08 | An outside edit is recorded and then protected | ✅ | Live: an external file write → `vault.user_edit` audited within 0.5–10 s; a later app write → `conflict`, the user text intact, the approval queued |
| W1-08 | No remote, app commits | ✅ | Live: `remote -v` empty; `aos: init vault` commit |
| W1-09 | GPU check | ✅ | torch 2.14.1+cu132, capability (7, 5), sm_75 in the arch list, matmul OK |
| W1-09 | Loopback + bearer | ✅ | Only `127.0.0.1:8009`; no key or wrong key → 401 |
| W1-09 | Bench: p50 < 200 ms, VRAM < 7 GB | ✅ | p50 62 ms, p95 100 ms, 1.36–1.6 GB |
| W1-09 | Works with the **network unplugged** | ⬜ | Offline env vars are set, and Hub calls refused as expected; the physical unplug test is for you |
| W1-10 | Eval ≥ 9/10; a "new area" case proposes, never creates | ✅ | 5 live runs: 10, 10, 10, 9, 9; the misses were only the cat case (filed under home-household) |
| W1-10 | Re-running the same job is a no-op | ✅ | `categorize.test.ts` |
| W1-10 | Summary note opens **in Obsidian** | ⬜ | Frontmatter and wikilink tested; opening it in Obsidian is for you |
| W1-11 | Approving an area → active, written to `CLAUDE.md`, inbox re-filed | ✅ | `approvals.test.ts`; the PR #33 e2e (propose → approve → recategorize); W1-11 live in the built UI |
| W1-11 | Edit before approving stores `edit_distance` | ✅ | `approvals.test.ts`; W1-12 live: 0.18 |
| W1-11 | At most 15 a day; batch reject | ✅ | `approvals.test.ts`; W1-11 live batch reject |
| W1-12 | One question at a time, at most 10 a day | ✅ | `persona.test.ts`; W1-12 live |
| W1-12 | End → proposals; approve writes, ticks, commits | ✅ | W1-12 live: `persona/values.md`, values-1 ticked, values-3 not |
| W1-12 | Accepted statement in the prompt, cache hits | ✅ | W1-12 live: the next chat used it; `cache_read_tokens` 2404 |

## Security pass (W1-13)
See the "Security pass" section of PR #35 for `pnpm audit`, the secret scan and the manual review.
