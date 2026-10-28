# Agentic OS

A personal, local-first knowledge base for the areas of your life (career first; email, social and blog next), with one-click automations that produce **drafts only** and a review queue for anything the system wants to change in your Obsidian vault. Everything runs on this laptop; data leaves it only as prompts to the configured LLM provider.

- **Plan & decisions:** [`docs/plan-review.md`](docs/plan-review.md)
- **Rules for every Claude session:** [`CLAUDE.md`](CLAUDE.md)
- **How work is built:** [`docs/Workflow.md`](docs/Workflow.md)
- **Current plan (Career slice first):** [`docs/week2/implementation-plan.md`](docs/week2/implementation-plan.md), contract in [`docs/week2/career-contract.md`](docs/week2/career-contract.md)
- **Backlog:** the GitHub Project (https://github.com/users/amirwebd3v/projects/1)

## Prerequisites (Windows 11)
| Tool | Version | Install |
|---|---|---|
| Node.js | 22.12+ | nvm-windows or nodejs.org |
| pnpm | 10 | `corepack enable` |
| git | any recent | git-scm.com |
| uv + NVIDIA driver (CUDA 13), **only for the parked decider sidecar** (needed again for the Email slice) | uv 0.13+ | `winget install --id=astral-sh.uv -e` |

There's no Visual Studio requirement: native packages use prebuilt binaries.

## First-time setup
```powershell
pnpm i                                     # also turns on the pre-push hook
Copy-Item agentic-os.example.json agentic-os.json   # set vaultDir and dataDir (absolute, outside this repo, not in OneDrive)
Copy-Item .env.example .env                # set ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY and the model names
pnpm vault:init                            # creates the Obsidian vault (its own git repo, no remote)
pnpm smoke                                 # checks the LLM provider: stream, tools, cache, structured output
```
Then open `vaultDir` in Obsidian (*Open folder as vault*) and edit its `CLAUDE.md`, which holds your areas and rules.

## Daily use
```powershell
pnpm dev          # server :3000 + web UI :5173
```
1. Open the login link the server prints. If you've lost it, run `pnpm login-url`.
2. Open http://127.0.0.1:5173. **Review** lists what the system proposes (a note you edited in Obsidian that the app also wants to change, and later your master-CV import). Approve or reject each item.
3. To add a life area, add a line to the `## Areas` list in the vault's `CLAUDE.md`; the app reads it at every boot.

## Where things live
| What | Where |
|---|---|
| Notes and the areas list (`CLAUDE.md`) | `vaultDir` (Obsidian vault, git) |
| Database, logs, provider capabilities | `dataDir/brain.db`, … |
| API keys | `.env` (gitignored), or Windows Credential Manager via `pnpm secrets set anthropic` |

Check where a key is coming from with `pnpm secrets status`.

## Commands
| Command | Does |
|---|---|
| `pnpm verify` | Typecheck, lint, and all tests (server + web). The pre-push hook runs it; never bypass it. |
| `pnpm build` | Builds the web UI into `web/dist`, which the server serves at :3000 |
| `pnpm vault:retire` | One-time cleanup of Week 1 content in an existing vault and database. Dry run by default; `--apply` does it. Stop the server first. |
| `pnpm sidecar:setup` / `pnpm sidecar` | The parked Laya decider (Python, CUDA). Not part of `pnpm dev`; the Email slice will use it. |
| `pnpm secrets status` | Shows which secrets are set and where they come from |

## Firewall (one-time, admin PowerShell)
The server (and the sidecar, when you run it) bind to `127.0.0.1` only. As a second layer, block inbound connections to their ports:
```powershell
New-NetFirewallRule -DisplayName "AgenticOS block inbound" -Direction Inbound -LocalPort 3000,8009 -Protocol TCP -Action Block
```

## Troubleshooting
| Symptom | Fix |
|---|---|
| A "Connect provider" banner | `.env` is missing `ANTHROPIC_API_KEY`, or the provider is down. Check with `pnpm smoke`, then Reload. |
| "Port 8009 is in use by …, not a sidecar" (only when running the sidecar) | Another program holds the port. Free it; the app never kills non-sidecar processes. |
| `uv` / `bun` not found right after installing | Open a new terminal: winget's PATH change only reaches new shells. |
| 401 everywhere | The session cookie expired or the database was reset. Open a fresh `pnpm login-url` link. |
| Memory tools (claude-mem) fail | It needs Bun at `~/.bun/bin/bun.exe`. Check `~/.claude-mem/logs`. |
