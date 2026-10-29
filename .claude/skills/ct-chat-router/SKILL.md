---
name: ct-chat-router
description: Project map, key code facts and known pitfalls for CT-Chat-Router (multi-model chat app, FastAPI + SQLModel + PostgreSQL backend, React 19 + Vite + Tailwind v4 frontend, conversation tree with branches). Use when working on backend/main.py, models, Alembic, streaming /chat, branches and highlight offsets, or frontend components (Sidebar, MessageList, BranchPanel).
---

# CT-Chat-Router

Repo root (git, branch main); paths are relative to it. Plan docs: `PLAN_v2.md` (current), `PLAN_20261012.md` (old), `BUGS.md`, `BACKLOG.md`, `HANDOVER.md`, `DESIGN_P3.md`. Working rules (who writes code, commit format, confirm-before-commit) are in the repo's `CLAUDE.md`.

## What it is
Multi-model AI chat app. Frontend React 19 + Vite 7 + Tailwind v4 + lucide-react + react-icons (single entry `frontend/src/App.jsx`). Backend FastAPI + SQLModel/SQLAlchemy + PostgreSQL (`backend/main.py`). Conversations are a tree: `Message.parent_id` self-reference, root has `parent_id IS NULL`. Models: `gemini*` prefix routes to Google GenAI SDK (`gemini_llm.py`), everything else to OpenRouter (`openrouter_llm.py`). Responses stream via SSE. Deploy: Docker Compose (db / pgadmin / api), Render for prod demo.

## Key code facts
- Dependencies via uv: `backend/pyproject.toml` + `backend/uv.lock`; `backend/Dockerfile` installs with `uv export` + `uv pip install --system`. `backend/requirements.txt` is STALE (ignore it).
- Alembic: `backend/alembic/` (env.py → `SQLModel.metadata` + `database.DATABASE_URL`). Run `uv run alembic ...` on host (DB at localhost:5432) or `docker compose exec api alembic ...`. Autogenerate migrations need `import sqlmodel` (already in script.py.mako). Baseline rev e4d003f1bea8 stamped pre-existing tables.
- DB env gotcha: machine has BOTH a docker pgvector (chat_db, port 5432) AND a native PostgreSQL 16 (cluster 16/main). If chat_db container is down, port 5432 is free and a subagent may spin up a throwaway native cluster — always `docker compose ps` first, and instruct subagents to STOP and report (not improvise) if the DB is down.
- Session identity: originally a browser `localStorage.chat_session_id`. Phase 0 added OAuth (google+github, httpOnly-cookie sessions, `get_current_user`). The old note said "no auth"; check `backend/main.py` for which is authoritative.
- `/chats/roots` uses a Recursive CTE for `last_activity` when sorting by `updated`.
- Delete: `DELETE /chats/{root_id}` deletes the whole tree depth-first (level DESC) to avoid FK conflicts.
- Branch↔Message are mutually-referencing FKs (Branch.root_message_id → message.id, Message.branch_id → branch.id). Create in two steps: insert message with branch_id=None → flush for id → insert Branch → flush for branch id → backfill message.branch_id → commit.
- Branch.root_message_id is NULLABLE (null until the branch's first message is sent; /chat backfills it). Branch.anchor_text stores the selected-text snapshot; create_branch no longer creates a message. GET /chats/root_id/branches lists branches anchored in a tree (recursive CTE).
- Planned unified delete: `DELETE /messages/{node_id}` (leaf only; assistant deletes its user parent too).
- Model dropdown was a native `<select>`; replaced with custom dropdown (P4).
- Sidebar components live in `frontend/src/components/` (R1 split done; App.jsx ~394 lines). `BranchTreeModal.jsx` uses React Flow.
- Enter behavior is split by `window.innerWidth < 768` (mobile: Enter = newline; desktop: Enter sends, Shift+Enter newline).

## Current status (short; verify with git log)
- Phases 0-2 done: OAuth login, Branch table and branch feature, anchor_text + offsets, branch panel.
- Phase 3b in progress (last recorded 2026-10-23, HEAD c974b2f): Bug A (background generation + resume), Bug B (title fade), sidebar hover/active, F4, F5, F7, F8, G1 done. F6 cancelled by the user.
- NEXT: discuss G2-G9 details one by one with the user, then delegate. B2-B4 (delete endpoint + ghost branches, relink, /chat context) are pending, teaching docs first.
- Cancelled: S3 stop generation (OpenRouter bills the full run anyway). Out of scope: multi-device sync, i18n, RAG, WebSocket.
- Full phase history and design decisions: `references/status-history.md`.

## Known issues to remember
- B1: empty textarea showed a scrollbar. Fix: `overflow-y: hidden` while the input is empty (references/frontend-ui-patterns.md, fixed-height textarea). Confirm in browser before commit.
- Switch-away mid-stream then back → stuck at 'Thinking...' (Bug A, fixed; confirmed in the browser and with real Gemini/OpenRouter streams). Root cause: `/chat` wrote `ai_msg.content` only after the stream loop, so an abort (AbortController on switch) left an empty row. Now: generation runs as a background task with an in-memory buffer, the frontend no longer aborts on switch, and switch-back resumes via `GET /messages/{id}/stream?offset=N`. Verified against a real uvicorn server (backend) and in the browser (frontend, fake LLM). Details: references/streaming-generation.md.
- Sidebar title overlapped by the ⋯ button: resolved (P3b-BugB) with a CSS gradient mask (`mask-image`) over the title's right 3rem, with the row's right padding reduced (pr-2) so the text can run under the fade. Keep it a fade, not a hard clip. Details and the hover/active pattern: references/frontend-ui-patterns.md.
- BACKLOG: mobile edit button is unintuitive; collapsed mobile sidebar squeezes right side (B2 fix may cover it, unverified).
- Existing E1-E12 are listed in the plan appendix. E1/E2 must be checked in S2. E4 was fixed in P5a. E12: App.css is dead code.
- react-markdown v10 rehypePlugins: a plugin that takes options (factory like rehypeHighlight(anchors)) MUST be passed as a [plugin, options] tuple — rehypePlugins 等於 [[rehypeHighlight, anchors]] — NOT by calling it first. Calling first returns the transformer, which unified re-invokes with tree undefined → 'Cannot read properties of undefined'. Zero-arg plugins (rehypeSourceOffsets) are passed directly. remark/rehype position.offset is UTF-16 code unit, matching DOM Range.startOffset, so selection→offset mapping is emoji-safe.

## References (read before editing the area)
- `references/frontend-ui-patterns.md`: Sidebar.jsx or any row component, dropdown/popover anchoring, mobile drawer vs desktop column, fixed-height textarea, and how to verify UI in the browser with Claude in Chrome.
- `references/streaming-generation.md`: `/chat`, the `GENERATIONS` buffer, the resume endpoint. Verify with a real uvicorn server and a fake LLM; TestClient cannot simulate a disconnect.
- `references/status-history.md`: phase history, highlight and branch design decisions.
