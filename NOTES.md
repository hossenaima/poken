# NOTES — Poken handoff

Poken is a real-time "learn by teaching" app: one Vercel function, one Gemini Live
session, one page. This file records the decisions that cost something to reach and the
mistakes already made. Read it before changing anything non-trivial; add to it when you
learn something the next session would otherwise rediscover the hard way.

## Where things run

- **Production:** https://poken-xi.vercel.app (Vercel project `poken`, Hobby plan).
  Deploys are manual: `npx vercel deploy --prod --yes`. Preview: `npx vercel deploy --yes`.
- **Static frontend** (`public/`) is served by Vercel's CDN; **one function** (`api/server.ts`)
  serves `/api/*` and the WebSocket at `/ws/live` (both via rewrites in `vercel.json`).
- **Local dev:** `npm run dev` → `dev.ts` listens on :8000 and adds a static fallback for
  `public/` (gated on `!process.env.VERCEL`). `npm run typecheck` runs strict `tsc`.
- **Env:** `GEMINI_API_KEY` (set in Vercel for production/preview/development; `.env` locally,
  gitignored). Optional `CLEANUP_MODEL`; dev-only `DEV_MAX_DURATION_S` (see handover).

## The Hobby-plan constraint and the handover protocol

Vercel closes a function — and the WebSocket pinned to it — at `maxDuration`, a **hard
300s on Hobby** (`vercel.json` says 300; raise to 800 only after upgrading to Pro). A
lesson is longer than that, so every session hands itself over about every 4¼ minutes:

1. Server tracks the invocation deadline with `getDeadline()` from `@vercel/functions`
   (dev.ts falls back to `DEV_MAX_DURATION_S`, default 780s). 45s before it, it sends
   `{type:'session_handover', resumeToken}`.
2. The token carries **Gemini session-resumption handles** (for the single Live session), a digest of the
   lesson, the last 60 log entries, settings and elapsed time. The client also holds the
   analyzed `materialsContext` (sent once as `session_context`) so vision never re-runs.
3. Client opens a new socket with `&resume=1`, sends `{type:'resume', token, materialsContext}`
   then `ready_to_start`. Mic stays hot; outgoing frames queue (`wsSend`) until the new
   `session_ready`, then flush. The old socket stays open (and audible) until then.
4. The new invocation reconnects the Gemini Live session with `sessionResumption.handle`,
   so the model keeps its full memory and does **not** greet again. If a handle is rejected,
   it falls back to a fresh session primed with a `[RESUME]` digest block.
5. `session_state` (a fresh token) is pushed after every teacher turn and mirrored to
   `sessionStorage`, so unexpected closes reconnect with backoff (1s→30s, 3 attempts) and a
   reloaded tab gets a **Resume last session** button on the setup screen.

Every Live session also sets `contextWindowCompression: { slidingWindow: {} }` — Gemini's own
fix for the `code 1007` overflow that used to kill sessions around the 10-minute mark. Token estimates are
logged per teacher turn (`[Poken][Tokens]`) in case it ever recurs.

To rehearse a handover locally in two minutes: `DEV_MAX_DURATION_S=150 npm run dev`.

## Design decisions (deliberate)

- **No classroom mode.** Multi-student sessions (mic arbitration, N Live sessions,
  addressed-student locks) were the buggiest subsystem by far; the product is one student. Gone: `classroom`/`students` query params, the `student_speaking` /
  `student_turn_complete` / `student_interrupted` / `teacher_turn` / `classroom_audio` messages,
  student profiles/voices, classroom orbs and the mode tabs.

- **No Vercel Blob / HTTP materials store.** The frontend never called `/api/materials/*`;
  files travel over the WebSocket as `material_file` frames (proven path). Handover carries
  the analyzed context instead. `server/materials-store.ts` was deleted. Add Blob only if a
  feature actually needs cross-request file storage.
- **No separate 8-minute Gemini-only refresh.** Context compression plus the resumption
  handle make it unnecessary; on Hobby the full handover rebuilds sessions anyway.
- `/api/materials/session|upload|:id|notes` routes are gone with the store. `/api/materials/extract`,
  `/api/diagram/test`, `/api/cleanup-transcript`, `/api/topics`, `/api/logs` remain.

## Bugs already fixed (don't reintroduce)

- `media.camera = …` referenced an undeclared variable; the ReferenceError was swallowed and
  `[MEDIA]` cues never reached the model. Now `mediaState` is declared in connection scope.
- Audio in the 1.5s post-`onopen` blackout was **discarded**; it is now **buffered and flushed**.
- Teacher transcription was hard-gated on `teacherHasSpoken`, dropping the first utterance;
  chunks are now held (3s window) and flushed when speech is confirmed.
- Typed `text_input` never reached the session log (so reflections/resume tokens ignored
  typed-only sessions). It does now.
- `process.exit(1)` on a missing key would kill the whole Fluid instance; it throws instead.

## Mistakes already made (so you don't repeat them)

- **Gemini's `onopen` fires synchronously inside `ai.live.connect()`**, before the awaited
  session binding exists. Anything in `onopen` that touches the session must run in a
  `setTimeout` (the 400ms greeting kick) — `afterOpen()` takes a getter for this reason.
  Reading it synchronously throws a ReferenceError (temporal dead zone).
- **ESM on Vercel needs explicit `.js` extensions on relative imports.** `tsx` tolerates
  `'../server/materials-extract'`; Node's loader in production does not
  (`ERR_MODULE_NOT_FOUND`). Always write `'../server/x.js'`.
- **`pdf-parse` must be imported lazily.** Its `pdfjs-dist` throws `DOMMatrix is not defined`
  at import time on Vercel (the optional native `@napi-rs/canvas` isn't traced into the
  bundle; it is installed locally, which is why dev never showed it). It's only the PDF
  *text fallback* — Gemini vision is the primary PDF path — so on Vercel that fallback
  currently returns an error string. Upgrade path: make `@napi-rs/canvas` a real dependency
  and add it to `includeFiles`.
- Right after a deploy the first requests can return `FUNCTION_INVOCATION_FAILED` while the
  alias flips; probe again before assuming the build is broken. Use `npx vercel logs <url>`
  (start it first, then make the request — it streams live).
- `preview_start`/the in-app browser can't grant mic/camera; drive the session with
  `text_input` and read `debugEvents` / `.t-entry` from the page instead.

## Verified (2026-09-19)

- Local + production: landing → setup → session; Gemini Live opens; greeting arrives;
  typed teacher message → spoken student reply with transcript; live transcript cleanup;
  resume token with a Gemini handle issued; reflection renders after a handover.
- Local: deadline handover with `DEV_MAX_DURATION_S=150` — reconnect, `Resuming session
  (1 Gemini handle)`, `Gemini Live session opened (solo, resumed)`, no re-greeting.
- Production: WebSocket over the `/ws/live` rewrite (also reachable at `/api/server`).
- Not verified in a browser here: mic/VAD/echo-guard/camera paths (device capture is
  blocked in the tool browser) — only `wsSend` queuing changed on those paths.

## Known limitations / next steps

- Hobby: handover every ~4 min. Rehearse the demo around it or show it off on purpose.
- `/api/logs` is unauthenticated and its ring is per-instance; use `npx vercel logs`.
- The `[RESUME]` digest fallback loses the model's own memory; handles are the normal path.
