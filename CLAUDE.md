# CT-Chat-Router: working rules

Repo root = the directory containing this file (git, branch main). All paths below are relative to it.
Before starting work read `PLAN_v2.md`, `BUGS.md`, `BACKLOG.md`, and for Phase 3b also `HANDOVER.md` + `DESIGN_P3.md`.
The `ct-chat-router` skill holds the project map, key code facts and known pitfalls.

## Tone
Be direct: match the length of your reply to the weight of the ask. A one-line question gets a one-line answer, and finished work gets a short report of what changed, what's verified, and what's left, never a replay of the process. No filler ("Great question," "I'd be happy to"), no restating the request back, no re-summarizing what you already said, no narrating tool calls the user can see. Plain claims over adjectives; when unsure, say so plainly. Agree because it's right, not because the user said it. Depth is earned: give it when the user asks for detail, teaches, or the stakes demand it, not by default.
Reply in the language the user writes in.

## Who writes code
- ALL code is written by the `implementer` subagent. The main agent does NOT write code itself, even for hard technical points. The main agent diagnoses, spikes, and writes precise specs; the subagent implements. (The user corrected this once when F7 was hand-written.)
- Subagent reports must be terse: one-line summary + commit hash.
- Commit-message format: subagents often deviate. Write the exact message in the task text and say "EXACTLY", then `git log --oneline -3` to confirm before pushing.
- Parallel work: subagents share ONE working dir. Before dispatching a batch, grep which files each task touches and run in parallel only tasks with disjoint file sets. Same-file tasks are serialized or folded into one subagent making two separate commits. If `git commit` fails on `index.lock`, retry once after 2 s.

## Requirements vs approval
- A user posting a LIST of items (e.g. G1-G9) is only raising requirements, NOT approving implementation. Discuss each item's details and get explicit confirmation BEFORE delegating any code. Implementing an unconfirmed list produced wrong work that had to be fully reverted (e051fec).
- 先寫教學再執行: for any change that introduces a new front-end or back-end concept (bug fixes included), write the teaching guide first (`docs/*.html`, self-contained, same style as `docs/create-all-guide.html`; structure: concept, why, code, short practice list), commit it as its own `docs:` commit, wait for the user to read it and say 開始, THEN delegate. When a design decision is made or a step lands, update the same guide (decision table + implementation record) in a separate `docs:` commit.

## Planning and verification
- Break each phase into numbered tasks with acceptance criteria in the plan doc (like `PLAN_20261012.md`), track progress with the task list, commit per task with the task id (e.g. `feat: (P0-1) ...`).
- Write each task's acceptance criteria as RUNNABLE commands ("run X → prints Y"). On completion re-run them yourself, plus `git log` / `git status`, and read the changed code, before marking done and pushing. A subagent's "completed" is an unverified claim.
- Before editing for a user request, run `git status` and `git log --oneline -5`: the user sometimes commits the same change between turns.
- Verify UI changes by viewport width (desktop >= 768, mobile < 768). When a change splits mobile and desktop behavior, re-test the desktop features of the same element too (drag handle position and result, column widths, footer position).
- Browser checks use Claude in Chrome. Procedure: `.claude/skills/ct-chat-router/references/frontend-ui-patterns.md`, section Verification.
- Frontend-only edits: `cd frontend && npm run build` is the quick gate (no UI test suite). Say explicitly in the report that visual behavior was not browser-verified when it wasn't.
- Backend streaming: verify with a fake-LLM harness on a real uvicorn server, never real Gemini/OpenRouter calls (they cost money). Ask the user to run the real-model check.
- Before any scripted file edit check line endings (`grep -c $'\r' <file>`). As of 2026-10-28 `backend/main.py` and `backend/models.py` are LF; frontend files are LF. Write back with the file's own ending.
- `database.py` sets `echo=True`: any script importing it prints every SQL statement. Filter the output.
- DB gotcha: this machine has BOTH a docker pgvector (chat_db, port 5432) and a native PostgreSQL 16. Always `docker compose ps` first. If chat_db is down, STOP and report; do not start a throwaway native cluster.

## Commits and git
- One step per commit: `fix:` / `feat:` / `docs:` with step id, e.g. `feat: (P5b) ...`.
- Plan-doc changes always get their own separate commit, never bundled with code.
- Bugs go in `BUGS.md` and get a separate step and commit, not folded into the current step.
- Update the plan file status when a step is finished or verified.
- UI change confirm-before-commit: for any visual change, build, then give the user the exact tuning knobs (which class/value to change, what each direction does) and leave the change UNCOMMITTED. Commit and push only after the user confirms it looks right in the browser.
- Undoing a batch of premature commits: `git revert --no-commit <hashes newest-first>` then one commit (no force-push). Keep the requirements-doc (BACKLOG) commit OUT of the revert range.

## Phase 3b rules
- Stop after EACH wave for the user's manual verification before releasing the next. Task ids are `P3b-x`.
- B1-B4 / F7-F9 subagent tasks must read `PLAN_v2.md` + `DESIGN_P3.md` first.
- G2-G9 are still unconfirmed requirements (see BACKLOG.md). Do NOT implement any until its details are confirmed one by one.

## Visual overlap rule
When a floating control (⋯, buttons) covers text, fade the text with a `mask-image` gradient rather than hard-clipping or adding padding. Confirm the symptom first ("covered by the button" and "clipped too early" are different bugs).

## Context hygiene
Durable state lives in the skill, the PLAN docs and git. Suggest a fresh session (`/clear`) once a conversation gets very long.
Past planning from the earlier OpenCode sessions is in `~/.local/share/opencode/opencode.db` (SQLite; `session_v2` / `session_message`).
