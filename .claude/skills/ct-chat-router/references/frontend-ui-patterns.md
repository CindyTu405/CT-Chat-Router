# Frontend UI patterns (CT-Chat-Router)

Applies to `frontend/src/components/Sidebar.jsx` (ChatRow) and similar list rows. Tailwind v4 + React 19.

## Hover must live on the group wrapper, not on the clickable button
A row's ⋯ menu is a sibling of the main `<button>`, not a child. Putting `hover:bg-*` on the button makes the background vanish when the pointer moves onto ⋯. Put the hover background on the outer `group relative` div and keep only click/cursor styles on the button. Show ⋯ with `group-hover:opacity-100`.
- Do NOT use `focus-within` / `group-focus-within` to show ⋯: the active row's button holds focus after a click, so ⋯ stays visible permanently. Hover-only is the agreed behavior.

## Active (currently open) row is state, not hover
Derive it from a parent prop: App passes `activeChatId={messages[0]?.id ?? null}` down to Sidebar, which passes it to each row. In the row:
```
const isActive = chat.id === activeChatId;
className={`group relative rounded-xl transition-all ${isActive ? 'bg-white/80 shadow-sm' : 'hover:bg-white/80 hover:shadow-sm'}`}
```
Active and hover styles are mutually exclusive so the open row does not look hovered.

## Nothing but JSX between `return (` and the root element
A `const x = ...;` or a `//` line comment placed after `return (` is a syntax error. Compute values and write `//` comments ABOVE `return`. Inside the parentheses, only JSX and `{/* */}` comments are valid, and only before the root element. A failed `npm run build` on this is the signal, so run the build before opening the browser.

## Title fade instead of hard clip (text under a floating control)
Single-line title: `whitespace-nowrap overflow-hidden` plus a right-edge mask so the last ~3rem fades out:
```
[mask-image:linear-gradient(to_right,#000_calc(100%-3rem),transparent_100%)]
[-webkit-mask-image:linear-gradient(to_right,#000_calc(100%-3rem),transparent_100%)]
```
- The fade length must be at least the width of the control it avoids, and the title's right padding must be small enough (`pr-2`) that text actually reaches the fade zone. A large right padding hides the problem by leaving a gap.
- Tuning knobs: fade length = the `3rem` in both mask lines (larger = longer fade); text right edge = the row's `pr-*`.
- Confirm with the user that the symptom is "covered by the button" before choosing this fix.

## Floating panel anchored to a trigger (dropdown / popover)
- The panel is absolutely positioned inside a `relative` wrapper that wraps only the trigger, so `top-full` / `bottom-full` hug the trigger's edge.
- The horizontal anchor must be responsive. A centered panel (`left-1/2 -translate-x-1/2`) wider than half its trigger's position overflows the left edge at 375px. Use `left-0 md:left-1/2 md:-translate-x-1/2` (left-aligned on mobile, centered from md) and cap width with `max-w-[calc(100vw-2rem)]`.
- Flip up/down in `useLayoutEffect`, not `useEffect`: it runs before paint, so the panel never flashes in the wrong place. Compare space below and above the trigger with the panel's `offsetHeight + gap`, then pick `bottom-full mb-1` or `top-full mt-1`.
- Close on outside click with a document `mousedown` listener (fires before click, so it cannot race with other handlers), check `wrapperRef.contains(e.target)`, and remove both listeners in the effect cleanup.
- A trigger on a tinted background should drop its border, shadow, and white fill when the user asks it to blend in: `bg-transparent` plus a hover tint. Check the computed `border-top-width` and `box-shadow` in the browser, not just the class list.
- Measure a panel: click the trigger to open it, then compare `getBoundingClientRect()` centers (centered anchor) or left edges (left anchor), and confirm `right <= innerWidth`. Close it again afterwards. Teaching doc: `docs/dropdown-anchor-guide.html`.

## One component, two layouts (mobile drawer vs desktop column)
A sidebar or panel that is a full-screen overlay on mobile and a resizable column on desktop needs these rules together:
- **Desktop width goes in inline style only when `isDesktop` is true.** Inline style beats every class, so a leftover `width: X%` would override the mobile `w-full`. Track `isDesktop` with `window.matchMedia('(min-width: 768px)')` in `useState` plus a `change` listener. Do not check `window.innerWidth` once at mount: it misses later resizes.
- **Never put `md:static` and `md:relative` on the same element.** Tailwind emits both in the same breakpoint, and the later rule in the generated CSS wins, so `relative` is lost. Then any `absolute` child (the drag handle) positions against the wrong ancestor and jumps to the page corner. Use `fixed inset-0 z-40 w-full md:relative` for the drawer (or `md:static` if no absolute child needs a parent).
- **Open state needs `flex`, not just `flex-col`.** `hidden md:flex` for the closed state and `fixed ...` alone for the open state leaves the element `display: block`, so `flex-col`, `flex-1 min-h-0` and `mt-auto` all do nothing and the footer floats to the middle. Put `flex` in both states, e.g. `flex fixed ...` vs `hidden md:flex md:w-0`.
- **Desktop-only handles get `hidden md:block`** (drag handles, resize separators), so they do not sit on top of the mobile overlay.
- **Mobile close control is `md:hidden absolute`**, placed at top-left (sidebar) or top-right (panel). Any row or button that starts at the top of the same column needs top padding (`pt-16 md:pt-4`) so the close control does not cover it.

## Fixed-height textarea (border-box)
- With `box-sizing: border-box`, a height of 56px includes the 1px borders, leaving a 54px content box. If the content needs 56px (24px line-height + 32px padding), `overflow-y: auto` shows a scrollbar on an empty input. Detect it with `scrollHeight > clientHeight`.
- Fix: set `overflow-y: hidden` in the fixed-height (empty) state and restore `auto` once the content grows. Do not remove overflow entirely; the growing state needs it at the max height.

## Verification
- `npm run build` catches syntax errors but not visual results. Say so in the report.
- Check hover/active by viewport: desktop >= 768 px. Mobile sidebar is a drawer.

### Tooling: Claude in Chrome
- Tools are `mcp__claude-in-chrome__*` and act in the user's real Chrome (their sign-ins, their extension permissions). Load the core tools in ONE ToolSearch call first (tabs_context_mcp, tabs_create_mcp, navigate, computer, read_page, javascript_tool, read_console_messages; add form_input / find when needed). The `chrome-browser` skill has the details.
- Always open the app in a NEW tab (`tabs_create_mcp`). Do not drive the user's existing tabs. Close the tab when done.
- localhost must be allowed in the extension's site permissions. If a call is refused or a permission dialog appears, stop and ask the user.
- Measure with `javascript_tool` (`getBoundingClientRect()`, `getComputedStyle()`, `scrollWidth > innerWidth`); look with a `computer` screenshot. Check computed styles, not just class lists.
- Hover/active: move the mouse over the row with `computer`, then screenshot or read computed `background-color`.
- Drag handles: first try a real drag with `computer` (left_click_drag). If the width does not change, fall back to dispatching events from `javascript_tool`: `pointerdown` on the handle (`bubbles: true, button: 0, pointerType: 'mouse'`), then `pointermove` and `pointerup` on `window`. Confirm by reading the element width and `localStorage` afterwards. (Under the old Hermes harness, CDP mouse events did not trigger `pointermove` listeners on window, so a drag looked broken when it was not. Claude in Chrome may behave differently; trust a measured width, not the screenshot alone.)
- Mobile layout check (375px): a real Chrome window cannot be shrunk reliably that small, so do not depend on `resize_window`. Instead, in `javascript_tool`, append a same-origin iframe to the page: `position: fixed; top: 0; left: 0; width: 375px; height: 740px; z-index: 99999; background: #fff; border: 0;` with `src = location.origin`. Media queries and `matchMedia('(min-width: 768px)')` inside the iframe evaluate against the iframe width. Measure inside via `iframe.contentDocument` / `iframe.contentWindow` (right edges vs the container's right edge; overflow shows as `scrollWidth > innerWidth`). Remove the iframe afterwards. Limits: no touch emulation, so touch-only behavior still needs a manual check.
  - Status: written for the Claude Code migration and NOT yet tried. On first use confirm it works; if the iframe is blocked, ask the user to resize the window or use DevTools device mode.

### Browser verification of a chat behavior
1. Start the backend harness and the Vite dev server with Bash `run_in_background: true` (no trailing `&`). Backend: from the backend dir, `PYTHONPATH=<scratch dir> .venv/bin/uvicorn <module>:app --port <port>` (harness: see streaming-generation.md). Frontend: from `frontend/`, `npx vite --port 5173 --strictPort`. Health-check each in a separate call with curl (`/docs` → 200, and `http://127.0.0.1:5173` → 200). Vite needs CORS (already allowed for 5173) and `frontend/.env` must point VITE_API_URL at the test backend port. A `chrome-error://` page with ERR_CONNECTION_REFUSED means a dev server is not up; do not read the DOM from it, fix the server first.
2. Login: the app uses OAuth cookie sessions. If the test backend needs a signed-in user, ask the user to sign in in that tab. Never type credentials. (Unchecked in this setup: whether the harness backend on another port accepts the user's existing session. Find out on the first run.)
3. Click New Chat before each scenario. Sending while a conversation is open appends a child to that tree, so no new sidebar row appears and the test reads the wrong thread.
4. Send by filling the textarea and pressing Enter (`computer` key press, or a `keydown` Enter event from `javascript_tool`). Enter only sends at desktop width (>= 768 px).
5. Find sidebar rows with `innerText.includes(<unique title>)`, not equality: each row's text also contains the date line.
6. For "still generating" checks, take two or more readings of a growing marker (e.g. the `[n]` chunk counter) a fraction of a second apart and compare. One snapshot cannot tell "mid-generation" from "finished".
7. Scope any DB assertion to the test's `session_id`. Global queries pick up rows left by earlier runs, including empty assistant rows from interrupted tests.
8. Test rows stay in the DB after the run. Name them with a unique prefix and say so in the report.
9. When finished, stop both servers (stop the background tasks, or `pgrep -af uvicorn` / `pgrep -af vite` then `kill <pid>`) and confirm they are gone.

## Teaching docs
Self-contained HTML in `docs/` (see `docs/css-hover-mask-guide.html` for the sidebar hover/mask case, `docs/create-all-guide.html` for the house style). The hover and mask demos should be interactive in the browser, not just described.