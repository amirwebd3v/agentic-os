# AOS-W1 Implementation Plan: Agentic OS, Week 1

*Created 2026-10-26 with the fullstack-dev-skills `create-implementation-plan` workflow. The backlog lives in this Obsidian vault (`docs/`), replacing Jira: the board is [[Backlog.base]], each ticket in [`tickets/`](tickets/) is self-contained, and the build loop is in [[Workflow]].*

## Summary

| Metric | Value |
|--------|-------|
| **Epic** | AOS-W1: Week 1 foundations ([plan-review.md §6](../plan-review.md)) |
| **Total tickets** | 13 |
| **Total story points** | 37 |
| **Overall complexity** | Medium |
| **Execution waves** | 6 |
| **Critical path** | W1-01 → W1-02 → W1-05 → W1-06 → W1-10 → W1-12 → W1-13 (19 pts) |
| **Key dependencies** | No API key until you add it. W1-05 smoke, W1-10 eval and W1-12 cache checks run "blocked: no key" until then. `uv` must be installed (W1-09). |

**Realism check:** 37 points is more than one solo week. The **must-have line** is W1-01…W1-10 plus W1-13 (32 pts). That gives you a usable, safe chat that files itself. W1-11 (review UI) and W1-12 (persona) can slip into week 2 without blocking anything else, because proposals already queue up in the database.

**Out of scope for Week 1 (Month 1 per the plan):** `items` extraction table, hybrid search and indexing, Docling ingestion, bge-m3, Gmail, chat tools, MCP, backups. Week 1 uses no 9router.

## Completion status

Status lives only in each ticket's frontmatter. See the board: ![[Backlog.base]]

## Execution order (topologically sorted)

| # | Ticket | Summary | Pts | Risk | Depends on |
|---|--------|---------|-----|------|------------|
| 1 | W1-01 | Monorepo scaffold, config, tooling | 2 | Low | — |
| 2 | W1-02 | SQLite: migrations, Week 1 tables, append-only audit | 3 | Low | 01 |
| 3 | W1-03 | Secrets in Windows Credential Manager | 1 | Low | 01 |
| 4 | W1-04 | Fastify, local hardening, token login, CSP | 3 | Med | 02, 03 |
| 5 | W1-05 | `llm.ts`, no-key mode, provider smoke test | 3 | Med | 02, 03 |
| 6 | W1-08 | Vault: Obsidian conventions, `CLAUDE.md`, safe writer, watcher | 3 | Med | 01, 02 |
| 7 | W1-09 | Python sidecar (Laya, CUDA) + `decider.ts` | 3 | Med | 01, 03 |
| 8 | W1-06 | Chat backend: sessions, SSE, crash-safe persistence | 3 | Med | 04, 05 |
| 9 | W1-07 | Chat UI (Vue) with sanitized Markdown | 5 | Med | 04 |
| 10 | W1-10 | Session categorization + summary note (cascade) | 5 | High | 05, 06, 08, 09 |
| 11 | W1-11 | Review queue + edit distance | 3 | Low | 02, 04, 07 |
| 12 | W1-12 | Persona interview mode | 2 | Low | 06, 10, 11 |
| 13 | W1-13 | Verification, README, acceptance run | 1 | Low | all |

## Parallel execution strategy

### Wave 1: Skeleton (2 pts)
| Ticket | Summary | Pts | Skill |
|---|---|---|---|
| W1-01 | Scaffold | 2 | typescript-pro |

### Wave 2: Storage and secrets (4 pts), in parallel
| Ticket | Summary | Pts | Skill |
|---|---|---|---|
| W1-02 | SQLite foundation | 3 | sql-pro |
| W1-03 | Secrets | 1 | secure-code-guardian |

### Wave 3: Platform services (12 pts), in parallel
| Ticket | Summary | Pts | Skill |
|---|---|---|---|
| W1-04 | Server + hardening | 3 | secure-code-guardian, fullstack-guardian |
| W1-05 | LLM client | 3 | typescript-pro, claude-api |
| W1-08 | Vault | 3 | typescript-pro |
| W1-09 | Sidecar + decider | 3 | python-pro |

### Wave 4: Chat (8 pts), in parallel
| Ticket | Summary | Pts | Skill |
|---|---|---|---|
| W1-06 | Chat backend | 3 | typescript-pro |
| W1-07 | Chat UI | 5 | vue-expert |

**Note:** W1-07 can start in Wave 3 against a mocked `/api`, since it only needs W1-04's auth and headers to integrate.

### Wave 5: Filing and review (8 pts), in parallel
| Ticket | Summary | Pts | Skill |
|---|---|---|---|
| W1-10 | Categorization | 5 | prompt-engineer, typescript-pro |
| W1-11 | Review queue | 3 | vue-expert |

### Wave 6: Persona and verification (3 pts)
| Ticket | Summary | Pts | Skill |
|---|---|---|---|
| W1-12 | Persona mode | 2 | prompt-engineer |
| W1-13 | Verify | 1 | test-master, code-reviewer |

**Coordination notes:**
- `server/test/helpers.ts` (`buildTestApp`, `makeTestDb`, fakes) is shared. Create it in W1-02 and extend it per ticket, so parallel tickets don't conflict.
- Migrations are numbered. W1-02 owns `0001`, W1-10 owns `0002`. Any other schema change gets the next number. Never edit an applied migration.
- You're working solo, so the "parallel" waves mean the order is flexible, not that separate agents are needed. Run one ticket at a time by following [[Workflow]] (fullstack-dev-skills + ponytail + claude-mem).

## Skill recommendations

| Work type | Skill (fullstack-dev-skills) |
|---|---|
| Server, TS modules | `typescript-pro` |
| Security-critical code (guards, auth, sanitizer, writer) | `secure-code-guardian`, then a `security-reviewer` pass in W1-13 |
| SQL, migrations | `sql-pro` |
| Vue UI | `vue-expert` |
| Python sidecar | `python-pro` |
| Prompts and schemas for filing and persona | `prompt-engineer` |
| Tests and acceptance | `test-master` |
| Scope control (every ticket) | `ponytail` (full), `/ponytail-review` per ticket, `/ponytail-debt` per wave, `/ponytail-audit` in W1-13 |
| Cross-session memory (code repo only) | `claude-mem`: `/claude-mem:mem-search` at ticket start. See the privacy rule in [[Workflow]] |

## Week 1 definition of done
1. `pnpm verify` is green.
2. Every acceptance criterion is ticked in `docs/week1/acceptance.md`, or marked "blocked: no API key yet".
3. You chat in the app daily. Sessions file themselves (flagged) into areas, with summary notes visible in Obsidian.
4. No secrets or personal data in the code repo. The vault has no remote. Ports 3000 and 8009 are loopback-only.

## Document links
- Overview: [docs/plan-review.md](../plan-review.md)
- Tickets: [docs/week1/tickets/](tickets/)
