# NOTES — Poken handoff

Poken is a real-time "learn by teaching" app: one Node process on Cloud Run, one Gemini
Live session, one page. This file records the decisions that cost something to reach and the
mistakes already made. Read it before changing anything non-trivial; add to it when you
learn something the next session would otherwise rediscover the hard way.

## Where things run

- **Production:** https://poken-7skula3n3a-uc.a.run.app — Cloud Run service `poken`,
  `us-central1`, in its own GCP project **`poken-app-260919`** (project number 619178789674,
  billing "My Billing Account"). Deploys are manual:
  `gcloud builds submit --config cloudbuild.yaml --project poken-app-260919`
  (builds the image, pushes it, deploys). `scripts/smoke-prod.mjs` defaults to the URL.
- **Project setup that was needed (once):** enable `run`, `cloudbuild`, `secretmanager`,
  `containerregistry`, `artifactregistry`; create secret `gemini-api-key`; grant both
  `619178789674-compute@developer.gserviceaccount.com` and
  `619178789674@cloudbuild.gserviceaccount.com` the roles run.admin, iam.serviceAccountUser,
  secretmanager.secretAccessor, storage.admin, artifactregistry.writer. The first
  `builds submit` right after enabling APIs failed with PERMISSION_DENIED even as project
  owner — propagation delay; the retry a minute later succeeded.
- **One process** (`main.ts` → `api/server.ts`): Hono serves `public/` and `/api/*`, and the
  same `http.Server` upgrades `/ws/live` to a WebSocket. Nothing is written to disk.
- **Local dev:** `npm run dev` (tsx watch on :8000). `npm run typecheck` runs strict `tsc`.
- **Env:** `GEMINI_API_KEY` (Secret Manager `gemini-api-key` in prod; `.env` locally,
  gitignored). `SESSION_TIMEOUT_S` (see below). Optional `CLEANUP_MODEL`.
- **Cloud Run flags that matter** (all in `cloudbuild.yaml`): `--timeout=3600` is the hard
  ceiling on one WebSocket connection (the Cloud Run maximum); `--session-affinity` keeps every
  request of a connection on the same instance — WebSockets die without it; `SESSION_TIMEOUT_S`
  is set to the same 3600 so the server can hand the client over before the platform cuts the
  socket. Change one, change both.

## Two connection limits and how sessions survive them

**1. Cloud Run cuts the request at `--timeout` (60 min).** The server times its own clock from
`SESSION_TIMEOUT_S` (there is no platform deadline API — if this env is missing the default is
3600, and if it is *wrong* handovers fire at the wrong moment, silently). 45s before the limit
it sends `{type:'session_handover', resumeToken}`; the client opens a new socket with
`&resume=1`, sends `{type:'resume', token, materialsContext}` then `ready_to_start`, keeps the
mic hot and queues frames (`wsSend`) until the new `session_ready`. The old socket stays open
until then. Rehearse locally: `SESSION_TIMEOUT_S=150 npm run dev`.

**2. Gemini Live closes its own connection after ~10 minutes (`goAway`).** This is handled
*without* touching the browser socket: `reopenGemini()` closes the Gemini session, holds any
teacher audio in the blackout buffer, and reconnects with the **session-resumption handle** so
the model keeps its full memory and does not greet again (a rejected handle falls back to a
fresh session primed with a `[RESUME]` digest). The same path recovers any mid-lesson Gemini
close. Exercise it on demand with the `debug_reopen` WebSocket message (ignored when
`NODE_ENV=production`); the smoke script does this.

The resume token carries the handle, a digest of the lesson, the last 60 log entries, settings
and elapsed time; `session_state` (a fresh token) is pushed after every teacher turn and whenever
Gemini issues a new handle, and mirrored to `sessionStorage` — so unexpected socket closes
reconnect with backoff (1s→30s, 3 attempts) and a reloaded tab gets **Resume last session**.
Every Live session also sets `contextWindowCompression: { slidingWindow: {} }` — Gemini's own
fix for the `code 1007` overflow that used to kill sessions around the 10-minute mark. Token
estimates are logged per teacher turn (`[Poken][Tokens]`).

## Design decisions (deliberate)

- **No classroom mode.** Multi-student sessions (mic arbitration, N Live sessions,
  addressed-student locks) were the buggiest subsystem by far; the product is one student. Gone: `classroom`/`students` query params, the `student_speaking` /
  `student_turn_complete` / `student_interrupted` / `teacher_turn` / `classroom_audio` messages,
  student profiles/voices, classroom orbs and the mode tabs.

- **No server-side file store.** Files travel over the WebSocket as `material_file` frames and
  the handover carries the analyzed context, so nothing needs disk or a bucket. Add storage
  only if a feature actually needs files to outlive a session.
- **Cloud Run, not a serverless-function host.** A 5-minute function cap forces a full client
  handover every ~4 minutes; Cloud Run's 60-minute request timeout plus in-place Gemini
  reopens make handovers hourly. Don't move to a host that caps request duration below that.
- **Pasted notes travel as a `materials_text` frame, never in the WebSocket URL.** URLs are
  written to Cloud Run request logs (so the notes would sit in Cloud Logging) and are
  length-capped (URL-encoded non-Latin text grows ~9×, so the session would fail to open). The
  client sends it pre-session, before `ready_to_start`; frames arrive in order, so it is in
  place when materials are assembled. Anything user-authored goes over the socket.

## Bugs already fixed (don't reintroduce)

- `media.camera = …` referenced an undeclared variable; the ReferenceError was swallowed and
  `[MEDIA]` cues never reached the model. Now `mediaState` is declared in connection scope.
- Audio in the 1.5s post-`onopen` blackout was **discarded**; it is now **buffered and flushed**.
- Teacher transcription was hard-gated on `teacherHasSpoken`, dropping the first utterance;
  chunks are now held (3s window) and flushed when speech is confirmed.
- Typed `text_input` never reached the session log (so reflections/resume tokens ignored
  typed-only sessions). It does now.
- `process.exit(1)` on a missing key would kill the whole process (and every session on the
  instance); it throws instead.

## Mistakes already made (so you don't repeat them)

- **Gemini's `onopen` fires synchronously inside `ai.live.connect()`**, before the awaited
  session binding exists. Anything in `onopen` that touches the session must run in a
  `setTimeout` (the 400ms greeting kick) — `afterOpen()` takes a getter for this reason.
  Reading it synchronously throws a ReferenceError (temporal dead zone).
- **ESM needs explicit `.js` extensions on relative imports** (`'../server/x.js'`). `tsx`
  tolerates the bare form; plain Node does not (`ERR_MODULE_NOT_FOUND`).
- **`pdf-parse` is imported lazily.** Its `pdfjs-dist` can throw `DOMMatrix is not defined` at
  import time when the optional native `@napi-rs/canvas` is absent; it is only the PDF *text
  fallback* (Gemini vision is the primary PDF path), so it must never take the process down.
- **Deleting a CSS/markup range by start/end anchors once took ~100 unrelated lines with it**
  (the toolbar, coaching panel, mic row and timeout-modal styles — shipped unstyled). When
  cutting between anchors, list the selectors in the removed range first and eyeball them;
  in the browser, check a computed style (`getComputedStyle(muteBtn).borderRadius`), not
  just that the page loads.
- A `session_state` token pushed only on teacher turns carried a Gemini handle from *before*
  the model's reply; it is now also pushed whenever Gemini issues a newer handle.
- `preview_start`/the in-app browser can't grant mic/camera; drive the session with
  `text_input` and read `debugEvents` / `.t-entry` from the page instead.

## Verified (2026-09-19)

- Local + production: landing → setup → session; Gemini Live opens; greeting arrives;
  typed teacher message → spoken student reply with transcript; live transcript cleanup;
  resume token with a Gemini handle issued; reflection renders after a handover.
- Cloud Run (2026-09-19, project `poken-app-260919`): `/`, `/app.js`, `/api/topics` 200;
  WebSocket session opens through the Cloud Run proxy, greeting + typed exchange + spoken reply
  + `session_state` tokens; service shows timeout 3600, session affinity on, secret bound.
- Local, same code, `SESSION_TIMEOUT_S=150`: in-place Gemini reopen (`debug_reopen`) keeps the
  socket and the memory; request-timeout handover at 105s resumes with memory.
- Not verified in a browser here: mic/VAD/echo-guard/camera paths (device capture is
  blocked in the tool browser) — only `wsSend` queuing changed on those paths.

## Known limitations / next steps

- `/api/logs` is unauthenticated and its ring is per-instance (with `--session-affinity` a
  browser sticks to one instance, so it usually shows the right one); Cloud Logging is authoritative.
- The `[RESUME]` digest fallback loses the model's own memory; handles are the normal path.
