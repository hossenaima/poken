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

```bash
npx vercel deploy --prod --yes
```

`GEMINI_API_KEY` must exist in the Vercel project's environment variables. Production:
https://poken-xi.vercel.app

## Layout

```
api/server.ts        HTTP (Hono) + WebSocket + Gemini Live + prompts — the one Vercel function
server/              materials extraction, vision and video analysis
public/              index.html, app.js, logo.svg — served statically by Vercel
dev.ts               local dev entry (listens on :8000)
vercel.json          rewrites /ws/live and /api/* to the function; maxDuration
```
