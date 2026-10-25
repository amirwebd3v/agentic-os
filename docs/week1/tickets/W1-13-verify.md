---
id: W1-13
title: "Week 1 verification, README, acceptance"
epic: AOS-W1
issue: https://github.com/amirwebd3v/agentic-os/issues/13
points: 1
wave: 6
risk: Low
depends_on:
  - "[[W1-01-scaffold]]"
  - "[[W1-02-database]]"
  - "[[W1-03-secrets]]"
  - "[[W1-04-server-security]]"
  - "[[W1-05-llm-client]]"
  - "[[W1-06-chat-backend]]"
  - "[[W1-07-chat-ui]]"
  - "[[W1-08-vault]]"
  - "[[W1-09-sidecar-decider]]"
  - "[[W1-10-categorization]]"
  - "[[W1-11-review-queue]]"
  - "[[W1-12-persona]]"
skills:
  - test-master
  - code-reviewer
---

# W1-13 — Week 1 verification, README, acceptance run

**Points:** 1 · **Risk:** Low · **Depends on:** all · **Skill/agent:** `test-master`, `code-reviewer`
Overview: [plan-review.md §6](../../plan-review.md) · Plan: [implementation-plan.md](../implementation-plan.md)

## Summary
Prove Week 1 against the plan's acceptance tests and leave a README that lets you set the system up again from scratch.

## Implementation steps
1. **`README.md`:** prerequisites (Node 22, pnpm, uv, git, NVIDIA driver), then the commands in order:
   `pnpm i` → `cp agentic-os.example.json agentic-os.json` (edit paths) → `pnpm vault:init` → `pnpm sidecar:setup` → `pnpm dev` → open the printed login URL → later `pnpm secrets set anthropic` → `pnpm smoke`. Also: the firewall command (admin), "keep data outside OneDrive", and troubleshooting (sidecar down, provider not configured).
2. **`pnpm verify`** must pass: typecheck, lint, all unit tests.
3. **Manual acceptance checklist** `docs/week1/acceptance.md`: tick each acceptance criterion from W1-01…W1-12 and record evidence (command output, screenshots, timings, `nvidia-smi`, `netstat`).
4. **Security pass:** run `pnpm audit --prod`, `gitleaks detect` on both repos, and a manual review of `guards.ts`, `auth.ts`, `markdown.ts` and `writer.ts` with the `security-reviewer` checklist.
5. **Over-engineering pass:** run `/ponytail-audit` on the whole repo and delete what it flags (or justify each kept item in [[debt]]). Run `/ponytail-debt` to bring the ledger up to date.
6. **Retro notes:** what took longer than estimated, so the Month 1 plan can be re-pointed.

## Acceptance criteria
- [ ] Every Week 1 acceptance criterion is ticked with evidence, or explicitly marked "blocked: no API key yet" (W1-05 smoke, W1-10 eval, W1-12 cache check).
- [ ] No secrets in either repo. No personal data in the code repo.
