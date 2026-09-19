# Poken

Learn by teaching. You explain a topic out loud; an AI student listens, watch your camera,
whiteboard or screen, ask questions — and are deliberately wrong about 30% of the time so
you have to catch it. You pick your student's persona — eager, skeptic, or confused.

Built on Gemini Live (native audio), Hono + `ws`, and a single vanilla-JS page. Hosted on
Vercel. Handoff notes — architecture, the session-handover design, and known pitfalls — are in
[`NOTES.md`](NOTES.md).

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
gcloud builds submit --config cloudbuild.yaml
```

Needs the Secret Manager secret `gemini-api-key` in the project. `cloudbuild.yaml` sets the
60-minute request timeout, session affinity (required for WebSockets), and
`SESSION_TIMEOUT_S` to match the timeout.

## Layout

```
main.ts              process entry — listens on $PORT
api/server.ts        HTTP (Hono) + WebSocket + Gemini Live + prompts
server/              materials extraction, vision and video analysis
public/              index.html, app.js, logo.svg — served by the same process
Dockerfile           node:20-slim, tsx runtime (no build step)
cloudbuild.yaml      build → push → gcloud run deploy poken
```
