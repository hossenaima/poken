// Smoke test: a solo session that (1) survives an in-place Gemini reopen (debug_reopen,
// non-production only) and (2) rides through the request-timeout handover with memory intact.
// Usage: BASE=ws://localhost:8000 node scripts/smoke-prod.mjs   (local dev with SESSION_TIMEOUT_S=150; ~4 min)
//        SKIP_REOPEN=1 node scripts/smoke-prod.mjs               (production: debug_reopen is ignored there,
//        and the timeout handover only fires after 60 min — expect 'NO HANDOVER within 300 s')
import WebSocket from 'ws';

const BASE = process.env.BASE || 'wss://poken.live';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function connect(query, { resume, notes } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE}/ws/live?${query}${resume ? '&resume=1' : ''}`);
    const state = { ws, ready: false, token: null, handover: null, materialsContext: '', transcript: [], audioChunks: 0, closed: null, debug: [] };
    ws.on('open', () => {
      if (resume) ws.send(JSON.stringify({ type: 'resume', token: resume.token, materialsContext: resume.materialsContext }));
      if (notes) ws.send(JSON.stringify({ type: 'materials_text', text: notes }));
      ws.send(JSON.stringify({ type: 'ready_to_start' }));
    });
    ws.on('message', (d) => {
      let m; try { m = JSON.parse(d.toString()); } catch { return; }
      if (m.type === 'session_ready') { state.ready = true; resolve(state); }
      if (m.type === 'session_context') state.materialsContext = m.materialsContext || '';
      if (m.type === 'session_state') state.token = m.resumeToken;
      if (m.type === 'session_handover') { state.handover = m; log('HANDOVER received:', m.reason); }
      if (m.type === 'transcript') state.transcript.push(m.text);
      if (m.type === 'audio') state.audioChunks++;
      if (m.type === 'debug') state.debug.push(m.message);
      if (m.type === 'error') { log('ERROR msg:', m.message); }
    });
    ws.on('close', (c, r) => { state.closed = { c, r: r.toString() }; log('closed', c, r.toString()); if (!state.ready) reject(new Error('closed before ready ' + c)); });
    ws.on('error', (e) => log('ws error', e.message));
    setTimeout(() => { if (!state.ready) reject(new Error('ready timeout')); }, 30000);
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Solo handover ─────────────────────────────────────────────────────────────
const t1 = Date.now();
// Pasted notes must arrive over the socket (materials_text), never the URL — see NOTES.md.
const NOTES_CANARY = 'Notes canary: 水循环 — transpiration counts too.';
const s1 = await connect('topic=The%20water%20cycle&persona=eager&language=English&video=1', { notes: NOTES_CANARY });
log('solo ready in', Date.now() - t1, 'ms');
if (!s1.materialsContext.includes(NOTES_CANARY)) { log('FAIL: pasted notes missing from session_context'); process.exit(1); }
log('pasted notes reached the session via materials_text');
await sleep(3000);
s1.ws.send(JSON.stringify({ type: 'text_input', text: 'Water evaporates from oceans, rises, condenses into clouds, and falls back as rain or snow. Remember the secret word: PINEAPPLE.' }));
await sleep(12000);
log('solo reply:', JSON.stringify(s1.transcript.join(' ').slice(0, 200)), '| audio chunks:', s1.audioChunks, '| token handles:', s1.token && Object.keys(s1.token.handles));

// ── In-place Gemini reopen (same socket) ─────────────────────────────────────
if (process.env.SKIP_REOPEN !== '1') {
  const before = s1.transcript.length;
  s1.ws.send(JSON.stringify({ type: 'debug_reopen' }));
  await sleep(4000);
  log('reopen debug:', JSON.stringify(s1.debug.slice(-3)), '| socket still open:', s1.ws.readyState === 1, '| unsolicited speech:', s1.transcript.length - before);
  s1.ws.send(JSON.stringify({ type: 'text_input', text: 'Same socket check: what was the secret word?' }));
  await sleep(12000);
  log('reply after reopen:', JSON.stringify(s1.transcript.slice(before).join(' ').slice(0, 160)));
}

// Wait for the deadline handover (SESSION_TIMEOUT_S - 45s lead; with 150 that is ≈ 105s after connect).
const deadlineWait = 300_000;
const start = Date.now();
while (!s1.handover && Date.now() - start < deadlineWait) {
  await sleep(2000);
  if (s1.closed) { log('socket closed before handover message', JSON.stringify(s1.closed)); break; }
}
if (!s1.handover) { log('NO HANDOVER within', Math.round((Date.now() - start) / 1000), 's; token present:', !!s1.token); process.exit(1); }
log('handover after', Math.round((Date.now() - t1) / 1000), 's since connect | handles:', Object.keys(s1.handover.resumeToken.handles), '| log entries:', s1.handover.resumeToken.logTail.length);

const t2 = Date.now();
const s2 = await connect('topic=The%20water%20cycle&persona=eager&language=English&video=1', { resume: { token: s1.handover.resumeToken, materialsContext: s1.materialsContext } });
log('RESUMED ready in', Date.now() - t2, 'ms | debug:', JSON.stringify(s2.debug.slice(0, 3)));
try { s1.ws.close(); } catch {}
await sleep(2500);
log('post-resume unsolicited transcript (should be empty):', JSON.stringify(s2.transcript.join(' ').slice(0, 120)), '| audio:', s2.audioChunks);
s2.ws.send(JSON.stringify({ type: 'text_input', text: 'Quick check: what was the secret word I told you earlier?' }));
await sleep(12000);
log('resumed reply:', JSON.stringify(s2.transcript.join(' ').slice(0, 240)), '| audio chunks:', s2.audioChunks);
s2.ws.close();
log('DONE');
process.exit(0);
