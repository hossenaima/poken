# NOTES — Poken handoff

Poken is a real-time "learn by teaching" app: one Node process on Cloud Run, one Gemini
Live session, one page. This file records the decisions that cost something to reach and the
mistakes already made. Read it before changing anything non-trivial; add to it when you
learn something the next session would otherwise rediscover the hard way.

## Where things run

- **Production:** https://poken.live — Cloud Run service `poken`,
  `us-central1`, in its own GCP project **`poken-app-260919`** (project number 619178789674,
  billing "My Billing Account"). Deploys are manual:
  `gcloud builds submit --config cloudbuild.yaml --project poken-app-260919`
  (builds the image, pushes it, deploys). `scripts/smoke-prod.mjs` defaults to the URL.
- **Deploying — two people deploy by hand, so the last deploy wins, even if its code is
  older.** `builds submit` uploads your *working directory*, not GitHub. So: `git pull` first;
  deploy only from a clean tree whose HEAD is pushed (`git status -sb` shows
  `## main...origin/main` and nothing else); say so in chat before deploying; after, confirm
  with `gcloud run services describe poken --region us-central1 --project poken-app-260919
  --format="value(status.latestReadyRevisionName)"`. On 2026-09-19 two overlapping deploys
  put a stale copy live for ~4 minutes (`poken-00005`) and silently rolled back a fix that was
  already on `main`. To see what any revision actually shipped, its source tarball is kept in
  `gs://poken-app-260919_cloudbuild/source/`.
- **Custom domain `poken.live`** (Namecheap, bought 2026-09-19): two Cloud Run *domain
  mappings* on service `poken`, apex + `www`, both in `us-central1`. Apex is 4 A + 4 AAAA
  records at Google's `216.239.3{2,4,6,8}.21` / `2001:4860:4802:3{2,4,6,8}::15`; `www` is a
  CNAME to `ghs.googlehosted.com`. The `TXT @ google-site-verification=...` record must stay
  — deleting it un-verifies the domain in Search Console and the mappings break. Cert
  provisioning took ~2h, not the ~15 min the docs suggest; `DomainRoutable: True` with
  `CertificateProvisioned: Unknown` just means "waiting", not "broken".
- **Domain mappings are a Preview feature** Google explicitly calls "not production-ready",
  which mattered here because Live sessions hold a WebSocket for up to 60 minutes. Tested
  after setup: `wss://poken.live/ws/live` upgraded in 140ms and held open cleanly, so the
  frontend passes WebSockets fine. If Live sessions ever start dropping on `poken.live` but
  *not* on the `run.app` URL, that's the mapping — the fix is a global external Application
  Load Balancer (~$20/mo), not application code. Check that before debugging the server.
- **Changing the domain means changing Supabase, not Google Cloud.** Nothing in the Cloud Run
  service or `cloudbuild.yaml` names a URL, and the Google OAuth client points at
  `poken.supabase.co/auth/v1/callback`, so it is untouched by a new app domain. What does
  need updating is Supabase → Authentication → URL Configuration: **Site URL** and the
  **Redirect URLs** allow-list (`https://poken.live/**`). `learn-store.js` builds `redirectTo`
  from `location.origin`, so sign-in silently fails on any origin missing from that list.
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
- **Learn Mode accounts:** anonymous sign-in is **off** on the hosted project — keep it off
  (public repo + publishable key = anyone could mint users). Signed out, a learn tree is
  in-memory only; sign-in is Google, and because that navigates away the tree is stashed in
  `sessionStorage` and rebuilt + saved on return. A page cannot show its own dialog on tab
  close (browsers allow only the generic *Leave site?* box), so the in-page banner is the
  warning. Google OAuth client ID/secret live in the Supabase dashboard, never in the repo.
- **Supabase vanity subdomain:** the project answers on **`poken.supabase.co`** as well as its
  ref domain (free on Pro; `supabase vanity-subdomains ... --experimental`). It exists so
  Google's consent screen says "continue to poken.supabase.co" instead of the project ref.
  `public/learn-store.js` uses it, so the OAuth callback is
  `https://poken.supabase.co/auth/v1/callback` — that exact URI must be in the Google OAuth
  client's authorized redirect URIs, or sign-in fails with `redirect_uri_mismatch`. The ref
  domain keeps working; both are the same project.
- **Supabase** (Learn Mode's knowledge tree; schema applied 2026-09-19): project `Poken`, ref
  `qdaqmtgfikkrtnjsjmnu`, `us-west-2`, in Jerry's Pro org. `supabase/config.toml` is committed;
  link state (`supabase/.temp`) is gitignored, so each machine links once:
  `supabase login` then `supabase link --project-ref qdaqmtgfikkrtnjsjmnu`. No database password
  needed — the CLI uses a temporary login role. **If `supabase login` says "You are now logged
  in" without opening a browser, a stale `SUPABASE_ACCESS_TOKEN` env var is overriding it**
  (the CLI prefers the env var; it silently "logged in" with a dead token). Remove the var, open
  a new terminal, log in again. Migrations must be **additive** (new tables/columns; no renames
  or drops): the app deploys by hand, so the database can be ahead of the running code.

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

The `[RESUME]` digest block is sent on **every** resume/reopen, handle or not — a handle issued seconds after an exchange can lag Gemini's state and resume a model missing that exchange (the smoke test's secret word was forgotten twice); the redundant reminder costs nothing. The resume token carries the handle, a digest of the lesson, the last 60 log entries, settings
and elapsed time; `session_state` (a fresh token) is pushed after every teacher turn and whenever
Gemini issues a new handle, and mirrored to `sessionStorage` — so unexpected socket closes
reconnect with backoff (1s→30s, 3 attempts) and a reloaded tab gets **Resume last session**.
Every Live session also sets `contextWindowCompression: { slidingWindow: {} }` — Gemini's own
fix for the `code 1007` overflow that used to kill sessions around the 10-minute mark. Token
estimates are logged per teacher turn (`[Poken][Tokens]`).

## Design decisions (deliberate)

- **Teacher transcription is Gemini Live's `inputTranscription`**; an ElevenLabs Scribe
  integration was tried and removed (2026-09-19) — its punctuation and segment timing caused
  more transcript bugs than it fixed.
- **The reflection page is a loop, not a report card.** It shows, in order: the session's topic and
  length, key vocabulary, a numbered list of what was covered (`topicsCovered`), and the concepts to
  revisit. Each concept is a button: it carries a short `label` (and, when the session was taught off
  a Learn Mode tree, the `nodeId` it came from), and clicking it hands you to Learn Mode — scrolled to
  that explanation, or starting it as a fresh topic. So a gap goes study → teach again. Removed
  (2026-09-19) as noise: strengths, student questions, next steps, presentation skills, presentation
  mechanics, and the PDF download (with the jsPDF dependency). Section headers are always written from
  `uiLabels` with an English default, so teaching again in another language can't keep stale headers.

- **The student cannot draw.** On-demand diagram generation was removed (2026-09-19): the image
  model added seconds of latency to a request that also fired on phrases that were not requests,
  and the sketch often did not match what the teacher had just explained. Gone: the image model
  and `generateStudentDiagram`, request detection (`isDiagramRequest`, the spaceless fallback),
  `buildDiagramBrief`, `triggerOnDemandDiagram`, `POST /api/diagram/test`, the `student_diagram`
  and `diagram_frame` / `diagram_popup_*` frames, and the annotatable sketch popup in the client.
  The prompt now tells the student to say it cannot draw and describe the picture in words.
  The teacher's own whiteboard is untouched, and Learn Mode's `/visual` diagrams are a separate
  feature that still works.

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
- **Learn Mode's web sources are Wikipedia, not Gemini's Google Search grounding.** The
  grounding terms (ai.google.dev/gemini-api/terms) forbid modifying or interspersing content
  with grounded results, storing them beyond the user's own chat history, "learning from" them
  or using them for another purpose, and tracking interactions with a specific result — Learn
  Mode nests deep-dives inside explanations, hands them to the AI student, and will persist and
  score them. Don't add `googleSearch` to a Learn Mode call. Wikipedia is **backend-only**: the
  learner never sees citations or links, so the prompt's "explain in your own words, never
  copy" rule is what keeps this within CC BY-SA — don't weaken it without adding visible
  credit. Wikipedia requests must send the `User-Agent` in `server/learn.ts` (Wikimedia
  blocks clients without contact info). Details: `docs/LEARN_MODE_PLAN.md`, Phase 3.

## Mid-session language switching

`language` is live state on the connection, not a constant. It changes two ways:

- **Explicit request** — `detectLanguageSwitchRequest()` on every finished teacher utterance and
  typed message: a switch cue ("switch to", "can you speak in", "say that in", 用/说/换成…)
  plus a language name or alias (`chinese`, `中文`, `español`, …), with a spaceless fallback for
  Gemini's fragmented ASR ("swi tch to chi nese"). A language merely *mentioned* ("the word
  for water in Spanish") does not switch.
- **Auto-detection** — `dominantScript()` over a rolling 80-char window of *raw* teacher
  transcript text, before `enforceTranscriptLanguage` (which would otherwise strip the new
  script entirely). The window matters: Gemini streams CJK **one character per chunk**, so
  per-chunk detection never reaches the 4-letter minimum and the whole utterance was being
  filtered down to punctuation (`",,"`). Han/Devanagari/Arabic at ≥70% switches immediately;
  Latin needs ≥12 letters in the window (a romanized word is not a switch) and lands on
  English — Spanish/French/German/Portuguese cannot be told apart by script, so they need an
  explicit request. Characters stripped before the switch fired are recovered (`droppedRaw`)
  and relayed, so the teacher's sentence is whole.
- Transcript buffers concatenate Gemini's chunks verbatim (`joinChunk()` is plain `buf + chunk`):
  the chunks are sub-word fragments ("pho", "tos", "yn", "the", "sis"…) and Gemini already puts
  a leading space on a chunk that starts a new word, so inserting spaces mangles words. Merged
  words are repaired by the cleanup pass; diagram/vision detection keeps its spaceless fallback.
- Gemini's input transcription emits **Traditional** characters (陽光, 葉綠素) even in a
  Simplified session. `enforceTranscriptLanguage` now runs `opencc-js`
  (`Converter({ from: 'tw', to: 'cn' })`, built once at module scope) on Simplified Chinese
  sessions, so every consumer — transcript relays, cleanup fallback, session log, resume
  digest — sees Simplified immediately, before the Gemini cleanup pass. Conversion happens
  *after* `dominantScript`/`autoDetectLanguage`, which still see the raw chunk.
- `node scripts/audio-probe.mjs <16k-pcm.wav> [ws-base] [language]` streams real speech
  through the mic path — synthesize test audio with
  `say -v Tingting "…" -o zh.aiff && afconvert -f WAVE -d LEI16@16000 -c 1 zh.aiff zh.wav`.

`switchLanguage()` sends the model a `[SYSTEM]` note (the system instruction also carries
`LANGUAGE_SWITCH_RULE` so it never refuses), emits `language_changed` to the client (which
updates `sessionLanguage` for cleanup calls, the resume token and the select), and pushes a
fresh resume token so a handover keeps the new language. `npx tsx --env-file=.env
scripts/test-language.ts` checks the detectors; `node scripts/switch-probe.mjs` runs the
English → Chinese flow against a local server.

## Live-model flakiness (known Google bug)

`gemini-2.5-flash-native-audio` intermittently closes the session mid-reply with
`1007 The audio content type (CONTENT_TYPE_AUDIO) is not supported for this model configuration`
— no audio from us involved; seen 2 of 5 local runs on 2026-09-19, and reported on Google's
forum (Aug 2026) with no root cause. Handling: **every** Gemini close is recovered in place by
`reopenGemini()` (a session that died young drops its handle and rebuilds from the digest),
bounded to 3 reopens per minute before a visible error. Google staff suggest
`gemini-3.1-flash-live-preview`, which is now the default (first audio ~0.9 s vs ~2.3 s; passed the
same language-switch and audio probes). `AUDIO_MODEL=gemini-2.5-flash-native-audio-latest` switches back.

### What the 3.1 live model needs that 2.5 did not

Three differences, all found by probe and all handled in `api/server.ts` — check them first if a
future model swap goes quiet:

1. **`audio:` / `video:`, never `media:`.** The SDK still maps `media:` onto the deprecated
   `mediaChunks` field; 3.1 rejects it and closes with
   `1007 realtime_input.media_chunks is deprecated`. Audio goes in `audio:`, camera and whiteboard
   frames in `video:`.
2. **The teacher's turn needs an explicit end.** 2.5 ends a turn on its own VAD; 3.1 waits for
   `sendRealtimeInput({ audioStreamEnd: true })`. Without it the student hears the teacher but
   never replies, and the transcript stays empty. Sent from `speech_end` alongside the trailing
   silence.
3. **Chinese arrives spaced out** ("光 合 作 用"). `transcriptChunk()` collapses whitespace between
   Han/punctuation pairs and is the single place both the teacher and student transcripts go
   through — fix spacing there, not at the call sites.

## Bugs already fixed (don't reintroduce)

- `/api/cleanup-transcript` (Gemini Flash) occasionally echoed its *entire prompt* back as the
  "cleaned" text for very short inputs ("Change language." → a paragraph of instructions in the
  teacher's bubble). The transcript is now delimited with `<<< >>>`, `cleanupLooksBroken()`
  rejects outputs containing prompt fingerprints or longer than 3× the input (+80), and the
  client applies the same length guard.

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

- `/api/logs` is open unless `LOGS_KEY` is set in the environment; when it is, requests need
  `?key=<LOGS_KEY>` (else 401). Production does not set it yet — the secret has to be created
  and wired into `cloudbuild.yaml` first. Its ring is per-instance (with `--session-affinity` a
  browser sticks to one instance, so it usually shows the right one); Cloud Logging is authoritative.
- The `[RESUME]` digest fallback loses the model's own memory; handles are the normal path.
