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

Production: https://poken-7skula3n3a-uc.a.run.app (GCP project `poken-app-260919`).
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

## Layout

```
main.ts              process entry — listens on $PORT
api/server.ts        HTTP (Hono) + WebSocket + Gemini Live + prompts
server/              materials extraction, vision and video analysis
public/              index.html, app.js, logo.svg — served by the same process
Dockerfile           node:20-slim, tsx runtime (no build step)
cloudbuild.yaml      build → push → gcloud run deploy poken
```
