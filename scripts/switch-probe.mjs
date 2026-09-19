// Language-switch probe: node scripts/switch-probe.mjs [port] [label] — typed English → "switch to Chinese" → a Chinese question.
import WebSocket from 'ws';
const port = process.argv[2] || '8000'; const label = process.argv[3] || 'default';
const ws = new WebSocket(`ws://localhost:${port}/ws/live?topic=Photosynthesis&persona=eager&language=English&video=1`);
let tr=''; let ready=false; const t0=Date.now(); const stamp = () => ((Date.now()-t0)/1000).toFixed(1)+'s';
const log = (...a) => console.log(`[${label}]`, stamp(), ...a);
ws.on('open', () => ws.send(JSON.stringify({type:'ready_to_start'})));
ws.on('message', d => { const m=JSON.parse(d.toString());
  if (m.type==='transcript') { tr+=m.text; return; }
  if (['audio','session_state','session_context','emotion'].includes(m.type)) return;
  if (m.type==='turn_complete') { log('student:', JSON.stringify(tr.slice(0,110))); tr=''; return; }
  log(m.type, m.language||'', m.source||'', m.message ? m.message.slice(0,70) : '');
  if (m.type==='session_ready' && !ready) { ready=true;
    setTimeout(()=>ws.send(JSON.stringify({type:'text_input', text:'Plants turn sunlight into sugar.'})), 3000);
    setTimeout(()=>ws.send(JSON.stringify({type:'text_input', text:'Can we switch to Chinese?'})), 18000);
    setTimeout(()=>ws.send(JSON.stringify({type:'text_input', text:'光合作用需要什么？'})), 33000);
    setTimeout(()=>ws.close(), 48000); } });
ws.on('close', (c,r) => { log('closed', c, r.toString(), '| pending:', JSON.stringify(tr.slice(0,80))); process.exit(0); });
setTimeout(()=>{ log('TIMEOUT'); process.exit(1); }, 65000);
