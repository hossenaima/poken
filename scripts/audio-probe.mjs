// Mic-path probe: streams a 16 kHz PCM16 WAV as teacher speech (speech_start → chunks → speech_end)
// and prints what the server relays as teacher_transcript / transcript, plus language events.
// Usage: node scripts/audio-probe.mjs <wav> [ws-base] [language]
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
const [,, wav, base = 'ws://localhost:8000', language = 'English'] = process.argv;
const pcm = readFileSync(wav).subarray(44);
const ws = new WebSocket(`${base}/ws/live?topic=Photosynthesis&persona=eager&language=${encodeURIComponent(language)}&video=1`);
let teacher = '', student = ''; let previews = 0, lastPreview = ''; let ready = false; const t0 = Date.now(); const stamp = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
ws.on('open', () => ws.send(JSON.stringify({ type: 'ready_to_start' })));
ws.on('message', async (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'teacher_preview') { previews++; lastPreview = m.text; return; }
  if (m.type === 'teacher_transcript') { teacher = m.replace ? m.text : teacher + m.text; return; }
  if (m.type === 'transcript') { student += m.text; return; }
  if (m.type === 'turn_complete') { console.log(stamp(), 'student:', JSON.stringify(student.slice(0, 120))); student = ''; return; }
  if (['audio', 'session_state', 'session_context', 'emotion', 'coaching_tip'].includes(m.type)) return;
  if (m.type === 'debug' && /Teacher speech|buffered|flushing/.test(m.message)) return;
  console.log(stamp(), m.type, m.language || '', m.source || '', m.message ? m.message.slice(0, 70) : '');
  if (m.type === 'session_ready' && !ready) {
    ready = true;
    await sleep(Number(process.env.PROBE_DELAY_MS) || 3500); // greeting first; PROBE_DELAY_MS=30000 exercises the idle-reopen path
    ws.send(JSON.stringify({ type: 'speech_start' }));
    for (let i = 0; i < pcm.length; i += 4096) { ws.send(pcm.subarray(i, i + 4096)); await sleep(128); }
    ws.send(JSON.stringify({ type: 'speech_end', media: { camera: false, whiteboard: false, screen: false } }));
    await sleep(1500);
    console.log(stamp(), 'previews:', previews, 'last:', JSON.stringify(lastPreview.slice(0, 60)));
    console.log(stamp(), 'teacher_transcript relayed:', JSON.stringify(teacher));
    await sleep(14000);
    console.log(stamp(), 'teacher_transcript final:', JSON.stringify(teacher));
    ws.close();
  }
});
ws.on('close', () => process.exit(0));
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 60000);
