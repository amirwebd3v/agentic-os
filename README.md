# Agentic OS

A personal, local-first second brain. You chat in your own app; every session is filed into a life area, summarised into an Obsidian vault, and can teach the system your preferences. Everything runs on this laptop; data leaves it only as prompts to the configured LLM provider.

- **Plan & decisions:** [`docs/plan-review.md`](docs/plan-review.md)
- **Rules for every Claude session:** [`CLAUDE.md`](CLAUDE.md)
- **How work is built:** [`docs/Workflow.md`](docs/Workflow.md)
- **Backlog:** the GitHub Project (https://github.com/users/amirwebd3v/projects/1)

## Prerequisites (Windows 11)
| Tool | Version | Install |
|---|---|---|
| Node.js | 22.12+ | nvm-windows or nodejs.org |
| pnpm | 10 | `corepack enable` |
| git | any recent | git-scm.com |
| uv (Python env for the sidecar) | 0.13+ | `winget install --id=astral-sh.uv -e` |
| NVIDIA driver | CUDA 13 capable (RTX 20xx or newer) | nvidia.com |

There's no Visual Studio requirement: native packages use prebuilt binaries.

## First-time setup
```powershell
pnpm i                                     # also turns on the pre-push hook
Copy-Item agentic-os.example.json agentic-os.json   # set vaultDir and dataDir (absolute, outside this repo, not in OneDrive)
Copy-Item .env.example .env                # set ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY and the model names
pnpm vault:init                            # creates the Obsidian vault (its own git repo, no remote)
pnpm sidecar:setup                         # Python env + CUDA check + pinned Laya model (~2.5 GB once)
pnpm smoke                                 # checks the LLM provider: stream, tools, cache, structured output
```
Then open `vaultDir` in Obsidian (*Open folder as vault*) and edit its `CLAUDE.md`, which holds your areas and rules.

## Daily use
```powershell
pnpm dev          # server :3000 + Laya sidecar :8009 + web UI :5173
```
1. Open the login link the server prints. If you've lost it, run `pnpm login-url`.
2. Chat at http://127.0.0.1:5173. **End session** files the chat, and an idle chat is filed automatically after 15 minutes.
3. Use **Persona** mode (in the new-session picker) for up to 10 interview questions a day.
4. Approve, edit or reject what the system proposes (new areas, persona statements, vault conflicts) in **Review**.

## Where things live
| What | Where |
|---|---|
| Notes, persona, area summaries | `vaultDir` (Obsidian vault, git) |
| Database, logs, provider capabilities | `dataDir/brain.db`, … |
| API keys | `.env` (gitignored), or Windows Credential Manager via `pnpm secrets set anthropic` |

Check where a key is coming from with `pnpm secrets status`.

## Commands
| Command | Does |
|---|---|
| `pnpm verify` | Typecheck, lint, and all tests (server + web). The pre-push hook runs it; never bypass it. |
| `pnpm build` | Builds the web UI into `web/dist`, which the server serves at :3000 |
| `pnpm eval:categorize` | Live categorization eval on 10 fixture chats (needs the sidecar and the provider) |
| `pnpm secrets status` | Shows which secrets are set and where they come from |

## Firewall (one-time, admin PowerShell)
The server and the sidecar bind to `127.0.0.1` only. As a second layer, block inbound connections to their ports:
```powershell
New-NetFirewallRule -DisplayName "AgenticOS block inbound" -Direction Inbound -LocalPort 3000,8009 -Protocol TCP -Action Block
```

## Troubleshooting
| Symptom | Fix |
|---|---|
| A "Connect provider" banner | `.env` is missing `ANTHROPIC_API_KEY`, or the provider is down. Check with `pnpm smoke`, then Reload. |
| Chats file slowly or always ask Claude | The sidecar is down. Run `pnpm sidecar`, which also stops a stale sidecar left on :8009. The app falls back to Claude by design. |
| "Port 8009 is in use by …, not a sidecar" | Another program holds the port. Free it; the app never kills non-sidecar processes. |
| `uv` / `bun` not found right after installing | Open a new terminal: winget's PATH change only reaches new shells. |
| 401 everywhere | The session cookie expired or the database was reset. Open a fresh `pnpm login-url` link. |
| Memory tools (claude-mem) fail | It needs Bun at `~/.bun/bin/bun.exe`. Check `~/.claude-mem/logs`. |
