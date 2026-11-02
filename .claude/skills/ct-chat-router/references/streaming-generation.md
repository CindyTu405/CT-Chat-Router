# Streaming and background generation (backend /chat)

Applies to `backend/main.py` `/chat`, the `GENERATIONS` buffer, the resume endpoint, and any new `StreamingResponse`. Teaching doc with the concepts: `docs/20261022_(BugA)streaming-lifecycle-guide.html`.

## Decided design (Bug A)
- Generation runs in a background `asyncio.create_task`, not inside the HTTP response generator. A closed connection or a switched conversation must not stop the model call.
- An in-memory buffer `GENERATIONS[ai_msg_id] = {"text": str, "done": bool}` collects chunks. On finish, the task writes the full text to the AI message row with its own `Session(engine)`.
- `/chat` still returns a stream (it reads the buffer from offset 0). `GET /messages/{id}/stream?offset=N` resumes from a character offset. While generating it waits for new text; when done it returns the rest. If the buffer is gone, it reads the DB row.
- Errors inside the task are appended to the text as a visible line, so a failed generation never stays a silent empty row.
- Buffers are kept about 60 s after `done` so a switching client can still finish reading, then removed.
- Frontend contract (in App.jsx): switching conversations or starting New Chat does NOT call `abort()`; it only clears the stream ref and sets `activeRootIdRef`. Old read loops check `activeRootIdRef` and cancel their own reader. `loadChat` calls `resumeGeneration(rootId, id)` when the last loaded message is an assistant row with empty content. Every write from the resume loop is guarded by the same `activeRootIdRef` check, so a reply never lands in another conversation.
- Stop generation is NOT built (see SKILL.md Cancelled). OpenRouter bills the full run regardless.

## Pitfalls
- Do not pass request-scoped ORM objects (`history` from `get_conversation_history`) into the background task. The request session commits and closes, and loaded instances expire. Copy the fields you need into plain objects first (e.g. `SimpleNamespace(role=..., content=...)`) before `create_task`.
- The task's DB write must use its own session. Do not reuse the request `session` (`Depends(get_session)`) after the response has been returned.
- The registry lives in one process. It is correct for the single uvicorn process in docker-compose (`--reload`). It breaks with multiple workers or replicas; that needs Redis or a DB table before scaling out.
- A backend restart loses in-flight text. This was accepted (decision D). Rows that were never finished keep their last saved content.
- Offsets are in characters, matching the frontend `aiResponseText.length`. Do not switch to bytes.

## Verifying streaming behavior (the test method matters)
- FastAPI `TestClient` buffers the whole streamed response before returning. It cannot simulate a client disconnect, so a test that reads three chunks and "disconnects" actually reads everything. Do not use it to prove the background task survives disconnects.
- Use a real server and a raw client:
  1. Write a harness module in the scratch dir (not in the repo). It imports `main`, replaces `openrouter_chat_stream` / `gemini_chat_stream` with a slow fake async generator, forces `is_model_allowed` to return True, and exposes `app = main.app`.
  2. Start uvicorn with Bash `run_in_background: true` (no trailing `&`), from the backend dir: `PYTHONPATH=<scratch dir> .venv/bin/uvicorn <module>:app --port <port>`. The same works for `npx vite --port <port> --strictPort` from `frontend/` (see frontend-ui-patterns.md). Note the PID (`pgrep -af uvicorn`). Background servers end with the session, so start them in the same session that runs the test.
  3. Health-check in a separate call (`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:<port>/docs` → 200). Confirm the harness file exists first; a heredoc in an interrupted call may not have written it.
  4. Client: `urllib` POST to `/chat`, read a few bytes, close the response. Wait past the fake stream length, then `GET /messages/{id}/stream?offset=0` should return the full text, and offset=k should return the exact tail. Check `prefix + tail == full`.
  5. Stop the server by PID: `pgrep -af uvicorn` to list it, then `kill <pid>`, then confirm it is gone. Do not use `pkill -f <pattern>` where the pattern also appears in the command you are running: it matches your own tool shell and kills it (exit -15), and the server survives anyway.
- Module imports in the venv: run with the project `.venv` (it has sqlmodel, authlib, etc.). Plain `python3` lacks the deps.

## Editing backend/main.py
- As of 2026-10-28 `backend/main.py` and `backend/models.py` are LF. Before a scripted edit check `grep -c $'\r' <file>` and write back with the file's own line ending, or the whole file shows as changed in git.
- Check with `python3 -m py_compile backend/main.py` after each edit.
