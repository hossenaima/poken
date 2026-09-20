// Runs a short typed teaching session against a server and saves the real reflection payload.
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';
const base = process.argv[2] || 'ws://localhost:8000';
const out  = process.argv[3] || 'reflection.json';
const TOPIC = 'Photosynthesis';
const LINES = [
  "Okay, so photosynthesis is how a plant makes its own food instead of eating like we do.",
  "It takes in three things: sunlight, water through the roots, and carbon dioxide through tiny pores in the leaves called stomata.",
  "The green stuff in the leaves is chlorophyll, and it sits inside little compartments called chloroplasts. Chlorophyll is what actually catches the light.",
  "Leaves look green because chlorophyll absorbs red and blue light but reflects green light back at your eyes.",
  "The plant uses that captured energy to stick the water and carbon dioxide together into glucose, which is a sugar, and oxygen comes out as a leftover.",
  "So the oxygen you are breathing right now is basically plant exhaust.",
];
const ws = new WebSocket(`${base}/ws/live?topic=${encodeURIComponent(TOPIC)}&persona=eager&language=English&video=0`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let turnDone = false;
ws.on('open', () => ws.send(JSON.stringify({ type: 'ready_to_start' })));
ws.on('message', async d => {
  const m = JSON.parse(d.toString());
  if (m.type === 'turn_complete') { turnDone = true; return; }
  if (m.type === 'reflection') {
    writeFileSync(out, JSON.stringify(m.data, null, 2));
    console.log('reflection saved to', out);
    ws.close(); process.exit(0);
  }
  if (m.type === 'session_ready') {
    await sleep(2500);
    for (const line of LINES) {
      turnDone = false;
      ws.send(JSON.stringify({ type: 'text_input', text: line }));
      console.log('teacher:', line.slice(0, 60) + '…');
      for (let i = 0; i < 40 && !turnDone; i++) await sleep(500);
      await sleep(800);
    }
    console.log('requesting reflection…');
    ws.send(JSON.stringify({ type: 'request_reflection' }));
  }
});
ws.on('close', () => process.exit(0));
setTimeout(() => { console.error('timed out'); process.exit(1); }, 240000);
