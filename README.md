# Poken

Learn by teaching. You explain a topic out loud; an AI student listens, watches your camera,
whiteboard or screen, asks questions — and is deliberately wrong about 30% of the time so
you have to catch it. You pick your student's persona — eager, skeptic, or confused.

Built on Gemini Live (native audio), Hono + `ws`, and a single vanilla-JS page. Hosted on
Google Cloud Run. Handoff notes — architecture, the session-handover design, and known
pitfalls — are in [`NOTES.md`](NOTES.md).

## Run it

```bash
npm install
cp .env.example .env   # add GEMINI_API_KEY
npm run dev            # http://localhost:8000
```

`npm run typecheck` runs strict TypeScript over the server.

## Deploy

Cloud Run, via Cloud Build:

```bash
gcloud builds submit --config cloudbuild.yaml --project poken-app-260919
```

Production: https://poken.live (also `www.poken.live`; the Cloud Run URL
https://poken-7skula3n3a-uc.a.run.app still serves the same service).
GCP project `poken-app-260919`.
Needs the Secret Manager secret `gemini-api-key` in the project. `cloudbuild.yaml` sets the
60-minute request timeout, session affinity (required for WebSockets), and
`SESSION_TIMEOUT_S` to match the timeout.

## Built with Devin

Part of this codebase is implemented by [Devin](https://devin.ai), Cognition's AI software
engineer, working from specs the team writes as GitHub issues. Each task runs in its own
draft PR: the kickoff `/devin` command, Devin's commits, its own verification summary, and the
team's review are all on the PR.

| Task | Issue | PR | Devin session |
|---|---|---|---|
| Traditional → Simplified Chinese conversion in transcripts | [#1](https://github.com/poken-app/poken/issues/1) | [#4](https://github.com/poken-app/poken/pull/4) (merged) | [cd128bce](https://app.devin.ai/sessions/cd128bce0a45447a92124ebea0ec4a55) |
| Teacher transcription via ElevenLabs Scribe v2 Realtime | [#2](https://github.com/poken-app/poken/issues/2) | [#5](https://github.com/poken-app/poken/pull/5) (merged) | [4c4040ee](https://app.devin.ai/sessions/4c4040eed2df4cc3bbe6a2497f50038d) |
| Dead-code removal (Firebase remnants, unused CDN script, unused route, dead state) | [#7](https://github.com/poken-app/poken/issues/7) | [#8](https://github.com/poken-app/poken/pull/8) (merged) | [f8431d3f](https://app.devin.ai/sessions/f8431d3f32d74aeda6db191e4053ced1) |
| Coaching tips for typed teacher messages | [#9](https://github.com/poken-app/poken/issues/9) | [#13](https://github.com/poken-app/poken/pull/13) (merged; cooldown fix added in review) | [03a071b6](https://app.devin.ai/sessions/03a071b636564376b841392ef0c77215) |
| Demo hardening: pinned jsPDF, persona/language recap, protected `/api/logs` | [#10](https://github.com/poken-app/poken/issues/10) | [#14](https://github.com/poken-app/poken/pull/14) (merged) | [c957bb8a](https://app.devin.ai/sessions/c957bb8a588c42a882c84dbea7600102) |
| Remove the ElevenLabs Scribe integration (Gemini transcription only) | [#27](https://github.com/poken-app/poken/issues/27) | [#28](https://github.com/poken-app/poken/pull/28) (merged) | [0f39c396](https://app.devin.ai/sessions/0f39c396a9114c3fab286bcae8dbca52) |
| Detect more diagram-request phrasings; student never refuses to draw *(feature later removed)* | [#29](https://github.com/poken-app/poken/issues/29) | [#30](https://github.com/poken-app/poken/pull/30) (merged) | — |
| On-demand diagrams drawn from the student's explanation, not the request *(feature later removed)* | [#31](https://github.com/poken-app/poken/issues/31) | [#32](https://github.com/poken-app/poken/pull/32) (merged) | — |
| Gemini transcription: trailing silence + settle so utterance tails aren't dropped | [#33](https://github.com/poken-app/poken/issues/33) | [#34](https://github.com/poken-app/poken/pull/34) (merged) | — |
| Transcript chunks concatenated verbatim (approach corrected in review) | [#35](https://github.com/poken-app/poken/issues/35) | [#36](https://github.com/poken-app/poken/pull/36) (merged) | — |
| Drop the leftover "solo" label from the session debug line | [#39](https://github.com/poken-app/poken/issues/39) | [#40](https://github.com/poken-app/poken/pull/40) | [session](https://app.devin.ai/sessions/704fccc21e474541844d22634dd1a614) |
| App-wide auth 1/3: Supabase auth moved into its own module | [#41](https://github.com/poken-app/poken/issues/41) | [#42](https://github.com/poken-app/poken/pull/42) | |
| App-wide auth 2/3: return to the screen sign-in started from | [#43](https://github.com/poken-app/poken/issues/43) | [#44](https://github.com/poken-app/poken/pull/44) | |
| App-wide auth 3/3: one account control on every screen that wants one | [#45](https://github.com/poken-app/poken/issues/45) | [#46](https://github.com/poken-app/poken/pull/46) | |
| In-app confirm dialog, and Delete all for Learn history | [#47](https://github.com/poken-app/poken/issues/47) | [#48](https://github.com/poken-app/poken/pull/48) | |
| Teaching history: delete one or all, and a way back to the landing page | [#49](https://github.com/poken-app/poken/issues/49) | [#50](https://github.com/poken-app/poken/pull/50) | |
| Learn Mode: bold, subheads and lists in explanations | [#52](https://github.com/poken-app/poken/issues/52) | [#53](https://github.com/poken-app/poken/pull/53) | |
| One mascot 1/3: extract the shared blob component | [#54](https://github.com/poken-app/poken/issues/54) | [#55](https://github.com/poken-app/poken/pull/55) | |
| One mascot 2/3: the two loading screens | [#56](https://github.com/poken-app/poken/issues/56) | [#57](https://github.com/poken-app/poken/pull/57) | |
| One mascot 3/3: the session student and the pill | [#58](https://github.com/poken-app/poken/issues/58) | [#59](https://github.com/poken-app/poken/pull/59) | |
| Teach page: drop branding and stats, student choice moves left | [#60](https://github.com/poken-app/poken/issues/60) | [#61](https://github.com/poken-app/poken/pull/61) | |
| Account control in one fixed corner on every screen | [#62](https://github.com/poken-app/poken/issues/62) | [#63](https://github.com/poken-app/poken/pull/63) | |
| Grid-paper background on teach, learn and open questions | [#64](https://github.com/poken-app/poken/issues/64) | [#65](https://github.com/poken-app/poken/pull/65) | |
| Learn and open questions: content on a white card | [#66](https://github.com/poken-app/poken/issues/66) | [#67](https://github.com/poken-app/poken/pull/67) | |
| Reflection: grid paper, neutral palette, Pokey with a line | [#68](https://github.com/poken-app/poken/issues/68) | [#69](https://github.com/poken-app/poken/pull/69) | |
| Persona cards: Pokey instead of emoji, coloured selection | [#70](https://github.com/poken-app/poken/issues/70) | [#71](https://github.com/poken-app/poken/pull/71) | |
| Learn page: saved topics rendered twice (race in showTopics) | [#72](https://github.com/poken-app/poken/issues/72) | [#73](https://github.com/poken-app/poken/pull/73) | |
| Floating polka dots on teach, learn and open questions | [#74](https://github.com/poken-app/poken/issues/74) | [#75](https://github.com/poken-app/poken/pull/75) | |
| Visible float dots, emoji-free reflection buttons, pastel gradient | [#76](https://github.com/poken-app/poken/issues/76) | [#77](https://github.com/poken-app/poken/pull/77) | |
| Opaque buttons and cards on the grid screens; plain Teach Again | [#78](https://github.com/poken-app/poken/issues/78) | [#79](https://github.com/poken-app/poken/pull/79) | |
| Opaque Upload button and signed-in account pill | [#80](https://github.com/poken-app/poken/issues/80) | [#81](https://github.com/poken-app/poken/pull/81) | |
| Progress bar from upload to end of document analysis | [#82](https://github.com/poken-app/poken/issues/82) | [#83](https://github.com/poken-app/poken/pull/83) | |
| Pre-session progress bar no longer snaps back to empty | [#84](https://github.com/poken-app/poken/issues/84) | [#85](https://github.com/poken-app/poken/pull/85) | |
| Document viewers: draggable popup in session, side panel in Learn | [#86](https://github.com/poken-app/poken/issues/86) | [#87](https://github.com/poken-app/poken/pull/87) | |

## Layout

```
main.ts              process entry — listens on $PORT
api/server.ts        HTTP (Hono) + WebSocket + Gemini Live + prompts
server/              materials extraction, vision and video analysis
public/              index.html, app.js, logo.svg — served by the same process
Dockerfile           node:20-slim, tsx runtime (no build step)
cloudbuild.yaml      build → push → gcloud run deploy poken
```
