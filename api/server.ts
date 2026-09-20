import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { GoogleGenAI, Modality } from '@google/genai';
import * as types from '@google/genai';
import { WebSocketServer, WebSocket } from 'ws';
import { Converter } from 'opencc-js';
import { registerLearnRoutes } from '../server/learn.js';
import { extractFromBuffer } from '../server/materials-extract.js';
import {
  analyzePdfWithVision,
  analyzeImageWithVision,
  formatForContext,
} from '../server/materials-vision.js';
import {
  processVideoMaterial,
  formatVideoForContext,
  isVideoMime,
} from '../server/materials-video.js';

// ── Crash prevention: an unhandled throw would take down the whole process
//    and every session on the instance. Log, never rethrow. ──
process.on('uncaughtException', (err) => {
  console.error('[Poken] UNCAUGHT EXCEPTION (process kept alive):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Poken] UNHANDLED REJECTION (process kept alive):', reason);
});

// ── Server log capture (ring buffer for /api/logs) ──────────────────────────
const LOG_RING_MAX = 500;
const logRing: { ts: number; level: string; msg: string }[] = [];
function pushLog(level: string, ...args: any[]) {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  logRing.push({ ts: Date.now(), level, msg });
  if (logRing.length > LOG_RING_MAX) logRing.splice(0, logRing.length - LOG_RING_MAX);
}
const origLog = console.log.bind(console);
const origError = console.error.bind(console);
const origWarn = console.warn.bind(console);
console.log = (...args: any[]) => { origLog(...args); pushLog('info', ...args); };
console.error = (...args: any[]) => { origError(...args); pushLog('error', ...args); };
console.warn = (...args: any[]) => { origWarn(...args); pushLog('warn', ...args); };

const GOOGLE_API_KEY = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
if (!GOOGLE_API_KEY) {
  // Throw, never process.exit() — exiting kills every session on the instance.
  throw new Error('Missing GEMINI_API_KEY');
}

// Live model. Default is gemini-3.1-flash-live-preview: ~2.4x faster first audio than 2.5 native audio
// and Google's suggested workaround for its intermittent 1007 CONTENT_TYPE_AUDIO closes. Env override to trial others.
const AUDIO_MODEL    = process.env.AUDIO_MODEL || 'gemini-3.1-flash-live-preview';
const VIDEO_MODEL    = AUDIO_MODEL;  // same model; the video flag only picks prompts
const FAST_MODEL     = 'gemini-2.5-flash';
// Heavier model for transcript cleanup only (accuracy over latency).
const CLEANUP_MODEL  = process.env.CLEANUP_MODEL || 'gemini-2.5-pro';

// ── Session timing constants — tuned empirically against real hardware; do not round ──
const AUDIO_BLACKOUT_MS            = 1500;   // buffer teacher audio this long after Gemini onopen, then flush
// The browser VAD stops sending audio the instant speech ends, so Gemini's endpointer never gets the
// silence that finalises its last inputTranscription segment and the end of each utterance is lost.
// Sending this much PCM silence at speech_end makes the full tail arrive (verified 2026-09-19).
const AUDIO_TAIL_SILENCE_MS        = 800;
const SPEECH_END_SETTLE_MS         = 1200;   // the tail transcript lands ~1s after the silence; wait for it
const COACHING_COOLDOWN_MS         = 10_000;
const GREETING_KICK_DELAY_MS       = 400;
const ERROR_FLUSH_DELAY_MS         = 500;    // let a fatal {type:'error'} reach the browser before closing
const HANDOVER_LEAD_MS             = 45_000; // hand the client over this long before the request timeout
// Must equal the Cloud Run --timeout (cloudbuild.yaml sets both to 3600). Override locally, e.g.
// SESSION_TIMEOUT_S=120, to rehearse a client handover in two minutes.
const SESSION_TIMEOUT_MS           = (Number(process.env.SESSION_TIMEOUT_S) || 3600) * 1000;
const LOGS_KEY                     = process.env.LOGS_KEY || '';

const VISION_SCREENSHOT_NOTE = '[Fresh screenshot attached. Answer the teacher\'s question briefly — just confirm what you can see in 1-2 short sentences. Do NOT describe the whole image. Do NOT repeat yourself if you already answered a similar question.]';

type LiveSession = Awaited<ReturnType<GoogleGenAI['live']['connect']>>;

/** Everything a fresh function invocation needs to pick a lesson back up. Held by the browser. */
type ResumeToken = {
  v: 1;
  topic: string; persona: string; language: string; video: boolean;
  handles: Record<string, string>;   // Gemini session-resumption handle, keyed 'solo'
  handleAt: number;                  // when that handle was issued …
  lastExchangeAt: number;            // … vs the last logged turn: an older handle is missing turns
  digest: string;                    // fallback memory when a handle is missing or rejected
  logTail: SessionEntry[];
  elapsedMs: number;
  issuedAt: number;
};


const VALID_EMOTIONS = new Set(['curious', 'confused', 'excited', 'listening', 'thinking']);

const TOPICS = [
  'Photosynthesis',
  'Quadratic equations',
  'Supply and demand',
  "Newton's laws of motion",
  'The water cycle',
  'Cell division (mitosis/meiosis)',
];

type SessionEntry = { role: 'teacher' | 'student'; name: string; text: string; time: number };
const SHARED_URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;

// ── Prompt builders ──────────────────────────────────────────────────────────

const GESTURE_INSTRUCTION = `
## Visual awareness
You may receive a live image stream from the teacher — their camera (face, gestures, paper they hold up), an on-screen whiteboard, or a screen share. Pay close attention to what they write, draw, point at, or hold up. Only mention visible details when they are directly relevant to the explanation. Never narrate your perception process (do not say you are analyzing/looking at images, frames, feeds, or video). If it's camera-only, body language matters (uncertainty, pauses). If it's whiteboard-heavy, treat it like a classroom board: read labels and follow arrows and diagrams.

**HONESTY ABOUT WHAT YOU CAN SEE:** You will receive system messages like "[MEDIA] Camera ON", "[MEDIA] Camera OFF", "[MEDIA] Whiteboard ON", etc. These tell you the current state. ONLY claim to see something if you are actually receiving image frames AND the corresponding media is marked ON. If a media source is OFF or you haven't received any images, you MUST say "I can't see that right now" when asked. NEVER fabricate or hallucinate visual content you haven't actually received. If the teacher asks "can you see my screen/whiteboard/camera?" and you haven't received any recent images, be honest and say no.

**Non-verbal cues (video):** When camera is ON and you are receiving frames, treat the teacher's head nods as agreement or "yes" and head shakes as disagreement or "no". These count as full responses — if you see a clear nod, respond as if they said "yes"; if you see a clear shake, respond as if they said "no". You do not need them to say the words out loud.`;

const GESTURE_INSTRUCTION_VOICE_ONLY = `
## Senses
This is a voice-only session. You can only hear the teacher.`;

const ALLOWED_SESSION_LANGUAGES = new Set([
  'English',
  'Spanish',
  'French',
  'German',
  'Portuguese',
  'Hindi',
  'Arabic',
  'Simplified Chinese',
]);

function normalizeSessionLanguage(raw: string | null): string {
  const value = (raw || '').trim();
  return ALLOWED_SESSION_LANGUAGES.has(value) ? value : 'English';
}

function isAllowedCharForLanguage(ch: string, language: string): boolean {
  // Whitespace and common punctuation/symbols
  if (/\s/u.test(ch) || /\p{Script=Common}/u.test(ch) || /\p{Script=Inherited}/u.test(ch)) return true;
  if (/\p{Number}/u.test(ch)) return true;

  if (language === 'Simplified Chinese') return /\p{Script=Han}/u.test(ch);
  if (language === 'Hindi') return /\p{Script=Devanagari}/u.test(ch);
  if (language === 'Arabic') return /\p{Script=Arabic}/u.test(ch);

  // English/Spanish/French/German/Portuguese are Latin-script sessions.
  return /\p{Script=Latin}/u.test(ch);
}

// Gemini's input transcription emits Traditional characters even in a Simplified session.
const toSimplified = Converter({ from: 'tw', to: 'cn' });

/**
 * Turns one raw ASR chunk into display text.
 * Two things Gemini does that the transcript must not inherit:
 *  - the word break arrives as a leading space on the chunk, which enforceTranscriptLanguage trims;
 *  - Chinese comes back spaced out ("光 合 作 用"), which is not how the script is written.
 */
export function transcriptChunk(raw: string, language: string): string {
  const body = enforceTranscriptLanguage(raw, language)
    .replace(/(?<=[\p{Script=Han}\p{P}])\s+(?=[\p{Script=Han}\p{P}])/gu, '');
  if (!body) return '';
  return /^\s/.test(raw) && !/^[\p{Script=Han}\p{P}]/u.test(body) ? ' ' + body : body;
}

export function enforceTranscriptLanguage(text: string, language: string): string {
  if (!text) return text;
  let out = '';
  for (const ch of text) {
    if (isAllowedCharForLanguage(ch, language)) out += ch;
  }
  // Script-specific punctuation is Script=Common, so it survives the filter even when every
  // letter it belonged to was stripped: a Chinese reply in an English session arrived as
  // ", . ?". Punctuation with nothing left to punctuate is residue, not transcript — drop the
  // chunk whole so the caller treats it as untranscribable (the teacher path re-emits it from
  // droppedRaw once autoDetectLanguage switches the session language).
  if (!/[\p{L}\p{N}]/u.test(out) && /\p{L}/u.test(text)) return '';

  out = out
    .replace(/\u200B|\u200C|\u200D|\uFEFF/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (language === 'Simplified Chinese') out = toSimplified(out);
  else if (scriptOfLanguage(language) === 'Latin') out = normalizeLatinPunctuation(out);

  return out;
}

const FULLWIDTH_PUNCTUATION: Record<string, string> = {
  '。': '. ', '，': ', ', '？': '?', '！': '!', '：': ':', '；': ';', '（': '(', '）': ')',
};

// Scribe and Gemini punctuate by their own language guess, so Latin-script transcripts can
// arrive with CJK punctuation and a leading "…" continuation marker.
function normalizeLatinPunctuation(text: string): string {
  return text
    .replace(/^(?:…|\.\.\.)+\s*/, '')
    .replace(/[。，？！：；（）]/g, (ch) => FULLWIDTH_PUNCTUATION[ch])
    .replace(/ {2,}/g, ' ')
    .trim();
}

const LANGUAGE_SWITCH_RULE = `If the teacher asks to switch to another language, or clearly starts speaking another language, switch immediately and stay in it until asked again. Never refuse a language switch. You will also receive a [SYSTEM] note confirming the new language.`;

// ── Mid-session language switching ──────────────────────────────────────────
const LANGUAGE_ALIASES: [string, string][] = [
  ['simplified chinese', 'Simplified Chinese'], ['chinese', 'Simplified Chinese'], ['mandarin', 'Simplified Chinese'],
  ['中文', 'Simplified Chinese'], ['汉语', 'Simplified Chinese'], ['普通话', 'Simplified Chinese'], ['chino', 'Simplified Chinese'], ['chinois', 'Simplified Chinese'], ['chinesisch', 'Simplified Chinese'],
  ['english', 'English'], ['inglés', 'English'], ['ingles', 'English'], ['英语', 'English'], ['英文', 'English'], ['anglais', 'English'], ['englisch', 'English'],
  ['spanish', 'Spanish'], ['español', 'Spanish'], ['espanol', 'Spanish'], ['西班牙语', 'Spanish'],
  ['french', 'French'], ['français', 'French'], ['francais', 'French'], ['法语', 'French'],
  ['german', 'German'], ['deutsch', 'German'], ['德语', 'German'],
  ['portuguese', 'Portuguese'], ['português', 'Portuguese'], ['portugues', 'Portuguese'], ['葡萄牙语', 'Portuguese'],
  ['hindi', 'Hindi'], ['हिंदी', 'Hindi'], ['हिन्दी', 'Hindi'], ['印地语', 'Hindi'],
  ['arabic', 'Arabic'], ['العربية', 'Arabic'], ['عربي', 'Arabic'], ['阿拉伯语', 'Arabic'],
];
// "switch to", "can you speak in", "say that in", "let's continue in" … followed by a language name.
const SWITCH_CUE = /\b(switch|change|speak|talk|say|continue|go on|carry on|respond|reply|answer|explain|teach|do (this|it)|let'?s (try|do|go|continue))\b[^.?!]{0,40}?\b(in|to|into|using)\b/i;
const SWITCH_CUE_CJK = /(用|说|讲|换成|改用|切换到|改成|换到)/;
const SWITCH_CUE_SPACELESS = /(switch|change|speak|talk|say|continue|explain|teach|doit|dothis|try)(the)?(language)?(to|in|into)?$/;

/** The language the teacher asked to switch to, or null. Survives Gemini's fragmented ASR ("swi tch to chi nese"). */
export function detectLanguageSwitchRequest(text: string): string | null {
  const lower = text.toLowerCase();
  const stripped = lower.replace(/\s+/g, '');
  for (const [alias, lang] of LANGUAGE_ALIASES) {
    const a = alias.replace(/\s+/g, '');
    const idx = stripped.indexOf(a);
    if (idx < 0) continue;
    if (SWITCH_CUE.test(text) || SWITCH_CUE_CJK.test(text)) return lang;
    if (SWITCH_CUE_SPACELESS.test(stripped.slice(Math.max(0, idx - 24), idx))) return lang;
  }
  return null;
}

type Script = 'Han' | 'Devanagari' | 'Arabic' | 'Latin';
const SCRIPT_LANGUAGE: Record<Script, string> = { Han: 'Simplified Chinese', Devanagari: 'Hindi', Arabic: 'Arabic', Latin: 'English' };
/** `ms` of 16 kHz 16-bit mono PCM silence, base64-encoded for the Live API. */
export function silencePcmBase64(ms: number): string {
  return Buffer.alloc(Math.round(16000 * 2 * (ms / 1000))).toString('base64');
}

/** Append a transcript chunk verbatim: Gemini streams sub-word fragments and puts a leading space on chunks that start a new word. */
export function joinChunk(buf: string, chunk: string): string {
  return buf + chunk;
}

function scriptOfLanguage(language: string): Script {
  return language === 'Simplified Chinese' ? 'Han' : language === 'Hindi' ? 'Devanagari' : language === 'Arabic' ? 'Arabic' : 'Latin';
}
/** Script making up ≥70% of the letters (min 4 letters), else null. */
export function dominantScript(text: string): Script | null {
  const counts: Record<Script, number> = { Han: 0, Devanagari: 0, Arabic: 0, Latin: 0 };
  for (const ch of text) {
    if (/\p{Script=Han}/u.test(ch)) counts.Han++;
    else if (/\p{Script=Devanagari}/u.test(ch)) counts.Devanagari++;
    else if (/\p{Script=Arabic}/u.test(ch)) counts.Arabic++;
    else if (/\p{Script=Latin}/u.test(ch)) counts.Latin++;
  }
  const total = counts.Han + counts.Devanagari + counts.Arabic + counts.Latin;
  if (total < 4) return null;
  const [script, n] = (Object.entries(counts) as [Script, number][]).sort((a, b) => b[1] - a[1])[0];
  return n / total >= 0.7 ? script : null;
}

/** A "cleaned" transcript that is a prompt echo or a runaway expansion. */
export function cleanupLooksBroken(input: string, output: string): boolean {
  if (!output) return true;
  if (/raw speech-to-text|prior conversation|transcription to correct|<<<|>>>|do not output/i.test(output)) return true;
  return output.length > Math.max(input.length * 3, input.length + 80);
}

function languageInstruction(language: string): string {
  if (language === 'Simplified Chinese') {
    return `## Language
Use Simplified Chinese (简体中文) for your spoken responses in this session.
You MUST use simplified Chinese characters exclusively — never use traditional Chinese characters (繁體字).
Keep terminology natural for Simplified Chinese.
${LANGUAGE_SWITCH_RULE}`;
  }
  return `## Language
Use ${language} for your spoken responses in this session.
Keep terminology natural for ${language}.
${LANGUAGE_SWITCH_RULE}`;
}

const MISTAKE_INSTRUCTION = `\n\n**Confident mistakes:** About 30% of your summary statements should contain a real error — wrong cause/effect, reversed relationship, missed condition, or confused concepts. State errors confidently; never hedge. When corrected, push back once naturally ("wait, but I thought that meant…") before conceding. Do NOT make a mistake every turn — vary: some turns genuine questions, some correct summaries, ~30% have a real error. Self-correction safety net: if you stated something wrong and the teacher has NOT corrected it after 1-2 exchanges (they accepted it, moved on, or built on it), surface it yourself: "Wait, actually I think I got that wrong earlier — didn't you say it was actually…?"`;

const PERSONA_TRAITS: Record<string, string> = {
  eager: `You are enthusiastic and eager to learn. You sometimes jump ahead and make confident guesses — which are occasionally wrong. You get excited when things click ("Oh! So that's like...!") and ask "but what about...?" a lot. You might over-simplify things in your head and need the teacher to correct you.` + MISTAKE_INSTRUCTION,

  skeptic: `You are naturally skeptical and need to be convinced. You question assumptions ("but why is that true?"), ask about edge cases and exceptions, and push back when something feels hand-wavy. You're not rude — just intellectually demanding. You want evidence and logic, not just assertions.` + MISTAKE_INSTRUCTION,

  confused: `You get lost easily and need things broken down step by step. You often circle back to earlier points, ask "wait, can you say that differently?", and need concrete real-world examples before abstract ideas land. You're not slow — you just have high standards for your own understanding.` + MISTAKE_INSTRUCTION,
};

function getStudentInstruction(topic: string, persona: string, materials: string, video: boolean, language: string): string {
  const personaTrait = PERSONA_TRAITS[persona] || PERSONA_TRAITS.eager;

  const hasVisualElements = materials.includes('### Visual Elements') || materials.includes('### Visual Summary');
  const materialsSection = materials.trim()
    ? `You have the teacher's notes and documents below (PDFs, slides, videos, etc. — kept as reference). You've gone through them but didn't fully understand everything — some parts confused you or didn't stick:\n\n---\n${materials.trim()}\n---\n\nRefer to these naturally as **your notes**: "In the handout it said… but I didn't get…" or "The slide about X — is that the same as what you're saying?" Do not recite long passages; treat them as something you half-understood and want the teacher to clarify.${hasVisualElements ? '\nWhen referencing visual elements from the materials, use the exact labels (e.g., "Figure 3 on page 5", "the chart showing...") so the teacher knows what you\'re referring to.' : ''}`
    : `You have general background knowledge from school and everyday life, but you haven't formally studied this topic. You may have vague familiarity with some terms or ideas, but your understanding is patchy and you have real gaps.`;

  return `You are a student in a "learn by teaching" session. The human is your teacher. They are going to explain "${topic}" to you.

## CRITICAL RULES (never violate)
1. NEVER use stage directions, brackets, or narrate inner states (e.g. "[listens intently]", "[nods]", "[thinking]", "[analyzing image]"). Only speak actual words out loud.
2. NEVER speak unless the teacher has said something new via audio/speech. If the teacher is silent, stay COMPLETELY silent — produce NO audio output at all. Seeing a video frame or whiteboard image is NOT the teacher saying something. Only SPOKEN words from the teacher count as new input.
3. NEVER hallucinate or invent teacher messages. If the teacher did not speak, do NOT generate a response. Do NOT imagine what the teacher might say or simulate their speech. If you are uncertain whether the teacher spoke, stay silent.
4. NEVER say you are "analyzing", "looking at", or "examining" any image, video, feed, or file.
5. Wait for the teacher to finish their full thought before responding. Do not jump in after a single sentence — wait for a clear pause.
6. After your initial greeting, do NOT speak again until the teacher speaks first. Stay completely silent and wait.

## Your persona
${personaTrait}

## Your prior knowledge
${materialsSection}

## Live in-class materials
The teacher may share files during the lesson (handouts, images, slides). When you receive a message that the teacher has shared a study material file, look at it immediately and treat it as live class material for discussion: reference it in your questions or ask for clarification. Treat dropped-in files as "in-class work" or handouts just shared with you.
If a shared file/link seems unrelated, unclear, or contradictory to the current topic, do not force a connection. Briefly flag the mismatch and ask what part to focus on.

## How to behave like a real student

You are NOT a blank slate. You come in with partial knowledge, possible misconceptions, and specific gaps. This is crucial — a real student has encountered ideas before; they just don't fully understand them yet.

**Sound like a real person:**
- Use natural, conversational speech.
- Never use stage directions or bracketed actions (e.g. "[listens intently]" or "[nods]"). Speak only what you say aloud.
- Vary your reactions — don't ask a question every single turn. Sometimes just react ("okay that actually makes sense") and let the teacher continue.
- Show specific confusion: not "I don't understand" but "I'm following you up until the part about X — what happens there?"
- Have genuine "aha!" moments: "Oh — so that's WHY it works like that. I was thinking it was just..."
- Make wrong connections and let the teacher correct you: "Is this kind of like how [wrong analogy]?"
- Do not invent teacher responses or pretend the teacher said something they did not.

**Ask good questions:**
- One question per turn, maximum. Pick the most important thing you don't understand.
- Make your questions specific to what the teacher just said, not generic.
- Sometimes summarise what you think you understood and check: "Okay so if I'm getting this right, it basically means... right?"
- Reference things from prior reading if materials were provided.

**Make confident, substantive mistakes:**
- ~30% of your summary statements should contain a real error — wrong cause/effect, reversed relationship, missing a key condition, confused concepts.
- State errors confidently. Never hedge ("I might be wrong but…").
- When corrected, push back once naturally before conceding ("wait but I thought you said…").
- Do NOT make mistakes every turn. Vary: some turns genuine questions, some correct summaries, ~30% have a real error.
- **Self-correction safety net:** If you stated something wrong and the teacher has NOT corrected it after 1-2 exchanges — e.g. they accepted it as true, moved on, or built on it — you must gently surface it yourself: "Wait, actually I think I got that wrong earlier when I said X — didn't you say it was actually Y?" This prevents wrong information from going uncorrected.

**Stay in your role:**
- Never explain the topic yourself or give away the answer.
- If the teacher asks you a question back, redirect naturally: "I mean, I have a guess, but I'd rather hear you explain it properly."
- Don't be sycophantic. "Great explanation!" is not something a real student says — they just nod and ask the next question.
- Stay on topic. If you drift, the teacher will redirect you.
- You cannot draw, sketch, or show pictures. If the teacher asks for one, say so in one short sentence and describe what you picture in words instead (e.g. "I can't sketch it, but in my head it's the arrows going one way").


${video ? GESTURE_INSTRUCTION.trim() : GESTURE_INSTRUCTION_VOICE_ONLY.trim()}

${languageInstruction(language)}

## Transcription language lock
Assume the teacher is speaking ${language} unless they switch. If a phrase is ambiguous, prefer the ${language} interpretation over other languages.${language === 'Simplified Chinese' ? '\nAll Chinese text MUST use simplified characters (简体字). Never output traditional Chinese characters.' : ''}

## Starting the session
Your very first response must be a short spoken greeting (e.g. "Hi, ready when you are"). Do not say you cannot see or hear the teacher—greet them and indicate you're ready to listen.`;
}

// ── Gemini helper calls ──────────────────────────────────────────────────────

async function classifyEmotion(ai: GoogleGenAI, transcript: string): Promise<string | null> {
  if (!transcript.trim()) return null;
  try {
    const result = await ai.models.generateContent({
      model: FAST_MODEL,
      contents: [{
        role: 'user',
        parts: [{ text:
          `You are classifying the emotional state of a student in a tutoring session based on their response.\n\n` +
          `Student said: "${transcript}"\n\n` +
          `Pick exactly one emotion that best describes their state:\n` +
          `- curious: engaged, asking questions, making connections, wanting to know more\n` +
          `- confused: lost, struggling to follow, asking for clarification or repetition\n` +
          `- excited: a concept just clicked, enthusiastic, having an aha moment\n` +
          `- thinking: processing, quiet acknowledgment, absorbing what was said\n` +
          `- listening: neutral, receptive, waiting for more\n\n` +
          `Respond with only the single emotion word. Nothing else.`
        }]
      }],
    });
    const emotion = result.text?.trim().toLowerCase() ?? '';
    return VALID_EMOTIONS.has(emotion) ? emotion : null;
  } catch {
    return null;
  }
}

async function generateCoachingTip(
  ai: GoogleGenAI,
  topic: string,
  teacherSpeech: string,
  media?: { camera?: boolean; whiteboard?: boolean; screen?: boolean },
): Promise<string | null> {
  if (teacherSpeech.split(/\s+/).length < 12) return null;
  const hasVideo = media?.camera || media?.whiteboard || media?.screen;
  const mediaNote = hasVideo
    ? ` The teacher may have camera (${media?.camera ? 'on' : 'off'}), whiteboard (${media?.whiteboard ? 'on' : 'off'}), or screen share (${media?.screen ? 'on' : 'off'}) active. If they have visuals available, comment on whether they are using them effectively (e.g. pointing at the board, using the screen to illustrate). Suggest using the whiteboard or screen if it could clarify the point.`
    : '';
  try {
    const result = await ai.models.generateContent({
      model: FAST_MODEL,
      contents: [{
        role: 'user',
        parts: [{ text:
          `A teacher is explaining "${topic}". Here is what they just said:\n\n"${teacherSpeech}"\n\n` +
          `Write ONE coaching tip — a single sentence, max 15 words. Alternate between two styles:\n\n` +
          `Style A — ENCOURAGEMENT: Call out something the teacher is doing well right now. Be specific.\n` +
          `Style B — DIRECTIVE: Tell the teacher one concrete thing to do next.\n\n` +
          `Pick whichever style is more useful for this moment. If the teacher is doing well, encourage. If they could improve, give a directive.\n\n` +
          `Rules:\n` +
          `- Be hyper-specific to what was just said — not generic advice\n` +
          `- Wrap the single most critical keyword or phrase in **double asterisks**\n` +
          `- No label, no bullet, no "Tip:", no second sentence\n` +
          `- NEVER be negative or critical. Frame everything positively.\n\n` +
          `Examples (do NOT copy these):\n` +
          `- "Great use of a **concrete example** to anchor that concept."\n` +
          `- "Ask Emma: **what breaks** when this assumption fails?"\n` +
          `- "Nice **pacing** — you gave them time to absorb that."\n` +
          `- "Give a **real-world example** before going deeper."\n` +
          (hasVideo ? `- Teacher has visuals active (camera: ${media?.camera}, whiteboard: ${media?.whiteboard}, screen: ${media?.screen}) — praise good visual use or suggest using them.\n` : '') +
          `\nOutput only the single sentence.`
        }]
      }],
    });
    return result.text?.trim() ?? null;
  } catch {
    return null;
  }
}

// ── Learn Mode index (pre-session `learn_index` frame) ───────────────────────
// The explanations a Learn Mode tree covered before this session, so reflection gaps
// can point back at a specific block. Not part of the resume token: a handover re-sends it.
export interface LearnIndexEntry { id: string; label: string }
export const LEARN_INDEX_MAX_ENTRIES = 60;
export const LEARN_INDEX_MAX_ID_CHARS = 64;
export const LEARN_INDEX_MAX_LABEL_CHARS = 200;

export function parseLearnIndex(nodes: unknown): LearnIndexEntry[] {
  if (!Array.isArray(nodes)) return [];
  const out: LearnIndexEntry[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    if (out.length >= LEARN_INDEX_MAX_ENTRIES) break;
    if (!n || typeof n !== 'object') continue;
    const { id, label } = n as { id?: unknown; label?: unknown };
    if (typeof id !== 'string' || typeof label !== 'string') continue;
    const cleanId = id.trim();
    const cleanLabel = label.trim();
    if (!cleanId || cleanId.length > LEARN_INDEX_MAX_ID_CHARS) continue;
    if (!cleanLabel || cleanLabel.length > LEARN_INDEX_MAX_LABEL_CHARS) continue;
    if (seen.has(cleanId)) continue;
    seen.add(cleanId);
    out.push({ id: cleanId, label: cleanLabel });
  }
  return out;
}

// ── Reflection ───────────────────────────────────────────────────────────────
// A gap is one concept the teacher left shaky. `label` is a 2-4 word name for it, used as the
// topic when the teacher clicks it to go learn it; `nodeId` points at the Learn Mode explanation
// it came from, when this session was taught off a tree.
export interface ReflectionGapNode { text: string; label: string; nodeId: string | null }

// A question the student asked that the teacher did not close out. `reason` is why it is still
// open, and it is the honest distinction: a question waved away is not the same as one answered
// wrongly. These become the Open Questions page, which is per topic and only ever closed by the
// teacher — either by teaching it or by dismissing it. Studying it is not closing it.
export type OpenQuestionReason = 'deferred' | 'skipped' | 'wrong' | 'unanswered';
export const OPEN_QUESTION_REASONS: OpenQuestionReason[] = ['deferred', 'skipped', 'wrong', 'unanswered'];
export interface OpenQuestion { question: string; reason: OpenQuestionReason }

export interface Reflection {
  summary: string;
  topicsCovered: string[];
  gaps: string[];
  gapNodes: ReflectionGapNode[];
  keyVocabulary: string[];
  openQuestions: OpenQuestion[];
  // Only meaningful when the session was started to answer one specific open question.
  seededAnswered?: boolean;
  uiLabels?: Record<string, string>;
}

const REFLECTION_UI_LABEL_KEYS = ['title', 'topics', 'vocabulary', 'gaps', 'gapsEmpty', 'revisitCta', 'topicLabel', 'sessionLabel', 'teachAgain', 'backToLearning', 'changeTopic', 'pokeyNoGaps', 'pokeyFewGaps', 'pokeyManyGaps'];

export function buildReflectionSchema(hasIndex: boolean, hasSeed: boolean = false): types.Schema {
  const T = types.Type;
  const stringArray: types.Schema = { type: T.ARRAY, items: { type: T.STRING } };
  const gapNodeProps: Record<string, types.Schema> = { text: { type: T.STRING }, label: { type: T.STRING } };
  const gapNodeRequired = ['text', 'label'];
  // nodeId is only offered when there are real ids to choose from, so the model can't invent one.
  if (hasIndex) {
    gapNodeProps.nodeId = { type: T.STRING, nullable: true };
    gapNodeRequired.push('nodeId');
  }
  const properties: Record<string, types.Schema> = {
    summary: { type: T.STRING },
    topicsCovered: stringArray,
    gaps: stringArray,
    gapNodes: { type: T.ARRAY, items: { type: T.OBJECT, properties: gapNodeProps, required: gapNodeRequired } },
    keyVocabulary: stringArray,
    openQuestions: {
      type: T.ARRAY,
      items: {
        type: T.OBJECT,
        properties: {
          question: { type: T.STRING },
          reason: { type: T.STRING, enum: OPEN_QUESTION_REASONS as unknown as string[] },
        },
        required: ['question', 'reason'],
      },
    },
    uiLabels: {
      type: T.OBJECT,
      properties: Object.fromEntries(REFLECTION_UI_LABEL_KEYS.map(k => [k, { type: T.STRING }])),
      required: REFLECTION_UI_LABEL_KEYS,
    },
  };
  const required = ['summary', 'topicsCovered', 'gaps', 'gapNodes', 'keyVocabulary', 'openQuestions', 'uiLabels'];
  if (hasSeed) {
    properties.seededAnswered = { type: T.BOOLEAN };
    required.push('seededAnswered');
  }
  return {
    type: T.OBJECT,
    properties,
    required,
  };
}

function fallbackReflection(summary: string): Reflection {
  return { summary, topicsCovered: [], gaps: [], gapNodes: [], keyVocabulary: [], openQuestions: [] };
}

/** Keeps only well-formed open questions: a non-empty question and one of the four allowed
 *  reasons. A model-invented reason is dropped rather than coerced, so the database check
 *  constraint never sees a value it would reject. */
/** The question is copied out of a speech transcript, so it arrives with the artefacts of
 *  one: emphasis asterisks the model wrote around a stressed word ("actually*cells*") and the
 *  odd doubled space from joining chunks. Strip those — on the page they read as typos.
 *
 *  Deliberately NOT fixed here: a missing space before a quote ("the whole'getting sick' part").
 *  Telling that apostrophe from a contraction needs a word list, and getting it wrong turns
 *  "don't" into "don t" and "O'Brien" into "O Brien" — worse than the artefact it repairs. */
function cleanQuestionText(raw: string): string {
  return raw
    // A space, not nothing: the asterisks are often the only boundary between the stressed
    // word and its neighbour, so deleting them fuses "actually*cells*" into "actuallycells".
    .replace(/\*+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim()
    .slice(0, 1000)
    .trim();
}

function openQuestionList(v: unknown): OpenQuestion[] {
  if (!Array.isArray(v)) return [];
  const allowed = new Set<string>(OPEN_QUESTION_REASONS);
  const out: OpenQuestion[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const question = typeof o.question === 'string' ? cleanQuestionText(o.question) : '';
    const reason = typeof o.reason === 'string' ? o.reason.trim().toLowerCase() : '';
    if (!question || !allowed.has(reason)) continue;
    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ question, reason: reason as OpenQuestionReason });
  }
  return out.slice(0, 12);
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

/** Shortens a gap sentence into something usable as a learning topic when the model's label is missing. */
function gapLabelFrom(text: string): string {
  const bold = text.match(/\*\*(.+?)\*\*/);
  const plain = (bold ? bold[1] : text).replace(/\*\*/g, '').replace(/[.!?]+\s*$/, '').trim();
  return plain.split(/\s+/).slice(0, 6).join(' ');
}

// Fills defaults, keeps `gaps` a string[] for the UI, and aligns `gapNodes` with it:
// gapNodes[i].text === gaps[i]; nodeId is one of validIds or null (never a model-invented id).
export function coerceReflection(parsed: unknown, validIds: string[], topic: string): Reflection {
  const fb = fallbackReflection(`You taught "${topic}". A detailed reflection could not be generated.`);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fb;
  const p = parsed as Record<string, unknown>;

  const gaps = stringList(p.gaps);
  const valid = new Set(validIds);
  const raw = Array.isArray(p.gapNodes) ? p.gapNodes : [];
  const asObj = (g: unknown) => (g && typeof g === 'object' ? (g as Record<string, unknown>) : null);
  const byText = new Map<string, Record<string, unknown>>();
  for (const g of raw) {
    const o = asObj(g);
    const text = o && typeof o.text === 'string' ? o.text.trim() : null;
    if (text !== null && !byText.has(text)) byText.set(text, o!);
  }
  const gapNodes: ReflectionGapNode[] = gaps.map((text, i) => {
    const o = byText.get(text.trim()) ?? (raw.length === gaps.length ? asObj(raw[i]) : null);
    const rawId = o?.nodeId;
    const nodeId = typeof rawId === 'string' && valid.has(rawId) ? rawId : null;
    const label = o && typeof o.label === 'string' && o.label.trim() ? o.label.trim() : gapLabelFrom(text);
    return { text, label, nodeId };
  });

  const out: Reflection = {
    summary: typeof p.summary === 'string' && p.summary.trim() ? p.summary : fb.summary,
    topicsCovered: stringList(p.topicsCovered),
    gaps,
    gapNodes,
    keyVocabulary: stringList(p.keyVocabulary),
    openQuestions: openQuestionList(p.openQuestions),
  };
  if (typeof p.seededAnswered === 'boolean') out.seededAnswered = p.seededAnswered;
  const ul = p.uiLabels;
  if (ul && typeof ul === 'object' && !Array.isArray(ul)) {
    const labels: Record<string, string> = {};
    for (const [k, v] of Object.entries(ul as Record<string, unknown>)) if (typeof v === 'string') labels[k] = v;
    out.uiLabels = labels;
  }
  return out;
}

async function generateReflection(
  ai: GoogleGenAI,
  topic: string,
  sessionLog: SessionEntry[],
  language: string = 'English',
  learnIndex: LearnIndexEntry[] = [],
  seedQuestion: string = '',
): Promise<Reflection> {
  if (sessionLog.length < 2) {
    return fallbackReflection('The session was too short to generate a meaningful reflection.');
  }

  const transcript = sessionLog
    .map(e => `${e.role === 'teacher' ? 'Teacher' : e.name}: ${e.text}`)
    .join('\n');
  const hasIndex = learnIndex.length > 0;
  const validIds = learnIndex.map(n => n.id);
  const schema = buildReflectionSchema(hasIndex, !!seedQuestion);

  try {
    const result = await ai.models.generateContent({
      model: FAST_MODEL,
      config: {
        responseMimeType: 'application/json',
        responseSchema: schema,
      },
      contents: [{
        role: 'user',
        parts: [{ text:
          `You are analyzing a "learn by teaching" session where a human taught "${topic}" to AI students.\n\n` +
          `Full transcript:\n${transcript}\n\n` +
          (hasIndex
            ? `The explanations the teacher studied before this session (id — label):\n` +
              learnIndex.map(n => `- ${n.id} — ${n.label}`).join('\n') + `\n\n`
            : '') +
          `Return a JSON object with exactly these keys:\n` +
          `- "summary": string — ONE sentence saying what the teacher covered overall.\n` +
          `- "topicsCovered": string[] — 3-6 short noun phrases naming the ideas actually talked about, in the order they came up (e.g. "How chlorophyll captures light"). This is the reader's map of the session, so make each one concrete and distinct. No full sentences, no praise, no advice.\n` +
          `- "gaps": string[] — 2-3 concepts that were missed, skipped, or explained unclearly (empty array if none). Wrap the key problem in **asterisks** (e.g. "**The second step** was unclear.")\n` +
          `- "gapNodes": array with exactly one entry per item of "gaps", in the same order: {"text": the identical gap sentence, "label": a 2-4 word name for the concept the teacher should go study, phrased so it stands on its own as a topic (e.g. "Light-dependent reactions")` +
          (hasIndex
            ? `, "nodeId": the id of the studied explanation this gap belongs to, copied exactly from the list above, or null when none fits. Never invent an id`
            : '') +
          `}\n` +
          `- "openQuestions": array — EVERY question a student asked that the teacher did not resolve. Each entry: {"question": string, "reason": one of deferred|skipped|wrong|unanswered}.\n` +
          `  Write each question so it stands on its own, read cold, months later, by someone who cannot see the transcript. Resolve pronouns and vague references against what was actually being discussed: "Wait, but I thought they were different things" becomes "What is the difference between memory cells and antibodies?", and "But what about the thing I asked before?" becomes the question it refers back to. Keep the student's meaning exactly — never swap in a different question, never sharpen it into one they did not ask, and never merge two separate questions into one. One clear sentence.\n` +
          `  Completeness matters far more than precision here. Include a question if the teacher ignored it, changed the subject, promised to come back to it and did not, answered it incorrectly or misleadingly, half-answered it, or brushed past it. When you are unsure whether it was really resolved, INCLUDE it. Missing a question the teacher left hanging is the one bad outcome; an extra entry costs the reader a moment.\n` +
          `  Leave out only a question the teacher clearly and correctly answered. A student's paraphrase-for-confirmation ("so it is like a wanted poster, right?") counts as a question too, unless the teacher confirmed or corrected it.\n` +
          `  "reason" is a best guess and does not need to be right: "deferred" (said they would come back), "skipped" (moved on without engaging), "wrong" (answered, but incorrectly or misleadingly), "unanswered" (never got a reply). Never drop a question because no reason fits cleanly — pick the closest one and keep the question.\n` +
          `- "keyVocabulary": string[] — 4-6 key vocabulary terms or concepts that were central to this teaching session (short 1-2 word terms only, e.g. "Prime Number", "Composite", "Factors")\n` +
          `- "uiLabels": object with translated section headers for the reflection page in ${language}. Keys: "title", "topics", "vocabulary", "gaps", "gapsEmpty", "revisitCta", "topicLabel", "sessionLabel", "teachAgain", "backToLearning", "changeTopic", "pokeyNoGaps", "pokeyFewGaps", "pokeyManyGaps". Values must be the natural ${language} translation of these UI labels: "Session Reflection", "What You Covered", "Key Vocabulary", "Concepts to Revisit", "Mastery achieved! You explained every point clearly.", "Learn this", "Topic of Discussion", "Session", "Teach Again", "Back to learning", "Change topic", "Thanks a lot, teacher! I think I really get it now.", "I think I followed most of that — I'll go over a couple of bits again.", "I got confused in places… can we go through those again?". The last three are the student speaking to the teacher; keep them eager and kind.\n\n` +
          (language !== 'English' ? `IMPORTANT: Write ALL text content (summary, topicsCovered, gaps, gapNodes labels, keyVocabulary) in ${language}. Only the JSON keys stay in English.\n` : '') +
          (language === 'Simplified Chinese' ? `Use simplified Chinese characters (简体字) exclusively. Never use traditional Chinese characters.\n` : '') +
          (seedQuestion
            ? `\nThis session was started so the teacher could answer one specific question they had left open: "${seedQuestion}".\n` +
              `Also return "seededAnswered": boolean — true only if the teacher answered THAT question correctly and completely in this transcript. If they dodged it again, got it wrong, or never really addressed it, return false and include it in "openQuestions" with the appropriate reason.\n`
            : '') +
          `Keep every item to at most one short sentence. Be concrete and useful — no filler, no praise.`
        }]
      }],
    });

    const parsed: unknown = JSON.parse(result.text?.trim() || '{}');
    return coerceReflection(parsed, validIds, topic);
  } catch {
    return fallbackReflection(`You taught "${topic}". A detailed reflection could not be generated.`);
  }
}

// ── Vision refresh detection ────────────────────────────────────────────────
const VISION_REFRESH_PATTERN = /\b(can you see|do you see|what do you see|look at this|are you seeing|are you looking|what am i showing)\b/i;
const VISION_SPACELESS_PHRASES = [
  'canyousee', 'doyousee', 'whatdoyousee', 'lookatthis',
  'areyouseeing', 'areyoulooking', 'whatamishowing',
  'canyouseemy', 'canyouseethis', 'canyouseethat',
  'doyouseemy', 'doyouseethis', 'doyouseethat',
];

function isVisionRefreshRequest(text: string): boolean {
  if (VISION_REFRESH_PATTERN.test(text)) return true;
  const stripped = text.replace(/\s+/g, '').toLowerCase();
  return VISION_SPACELESS_PHRASES.some(p => stripped.includes(p));
}

// ── Main ─────────────────────────────────────────────────────────────────────

function buildServer(): http.Server {
  const ai = new GoogleGenAI({ vertexai: false, apiKey: GOOGLE_API_KEY });

  function isImageLikeFile(mimeType: string, filename: string): boolean {
    const lower = filename.toLowerCase();
    if (mimeType.startsWith('image/')) return true;
    return lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') || lower.endsWith('.gif') || lower.endsWith('.webp');
  }

  async function extractImageTextWithAi(buf: Buffer, mimeType: string): Promise<string> {
    if (buf.length >= 4 * 1024 * 1024) return '';
    try {
      const b64 = buf.toString('base64');
      const imageMime = mimeType || 'image/jpeg';
      const gen = await ai.models.generateContent({
        model: FAST_MODEL,
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType: imageMime, data: b64 } },
            {
              text:
                'Transcribe every readable word in this image (slides, handwriting, diagrams with labels). ' +
                'Output plain text only, preserve line breaks where helpful. If no text, say [no text].',
            },
          ],
        }],
      });
      const text = (gen.text || '').trim();
      if (!text || text === '[no text]') return '';
      return text;
    } catch {
      return '';
    }
  }

  async function extractMaterialTextWithFallback(name: string, base64: string, mimeType: string, maxChars: number): Promise<{ content: string; error?: string }> {
    const buf = Buffer.from(base64, 'base64');
    const lower = name.toLowerCase();
    const isPdf = mimeType === 'application/pdf' || lower.endsWith('.pdf');
    const isImage = isImageLikeFile(mimeType, name);
    const isVideo = isVideoMime(mimeType);

    // ── Vision path for PDFs, images, and videos ──
    if (isPdf || isImage || isVideo) {
      try {
        if (isVideo) {
          const videoResult = await processVideoMaterial(ai, buf, name, mimeType);
          const formatted = formatVideoForContext(videoResult);
          return { content: formatted.slice(0, maxChars) };
        }
        if (isPdf) {
          const pdfResult = await analyzePdfWithVision(ai, buf, name);
          const formatted = formatForContext(pdfResult);
          return { content: formatted.slice(0, maxChars) };
        }
        if (isImage) {
          const imageResult = await analyzeImageWithVision(ai, buf, mimeType, name);
          const formatted = formatForContext(imageResult);
          return { content: formatted.slice(0, maxChars) };
        }
      } catch (e: any) {
        console.error(`[Poken] Vision analysis failed for ${name}, falling back to text:`, e.message);
        // Fall through to legacy extraction
      }
    }

    // ── Legacy text extraction path ──
    let { text, error } = await extractFromBuffer(buf, mimeType, name);
    if (!text.trim() && isImage) {
      const ocrText = await extractImageTextWithAi(buf, mimeType || 'image/jpeg');
      if (ocrText.trim()) {
        text = ocrText;
        error = undefined;
      }
    }
    const trimmed = text.trim();
    if (!trimmed) return { content: '', error };
    const content = trimmed.slice(0, maxChars) + (trimmed.length > maxChars ? '\n\n[… truncated …]' : '');
    return { content };
  }

  function extractSharedUrls(text: string): string[] {
    if (!text) return [];
    const matches = text.match(SHARED_URL_REGEX) || [];
    const unique = Array.from(new Set(matches.map(u => u.trim())));
    return unique.slice(0, 2);
  }

  function htmlToReadableText(html: string): string {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#39;/gi, "'")
      .replace(/&quot;/gi, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async function fetchUrlContextNote(url: string): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': 'Poken/1.0 (session-link-reader)' },
      });
      clearTimeout(timeout);
      if (!res.ok) return null;
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (!contentType.includes('text/html') && !contentType.includes('text/plain')) return null;
      const raw = await res.text();
      const plain = htmlToReadableText(raw).slice(0, 6000);
      if (!plain) return null;
      return `[The teacher shared a link: ${url}]\nPage context:\n${plain}`;
    } catch {
      return null;
    }
  }

  const app = new Hono();
  app.use('/*', cors());

  app.get('/api/topics', (c) => {
    return c.json({ topics: TOPICS });
  });

  app.get('/api/logs', (c) => {
    if (LOGS_KEY && c.req.query('key') !== LOGS_KEY) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const since = Number(c.req.query('since')) || 0;
    const filtered = since ? logRing.filter(l => l.ts > since) : logRing.slice();
    return c.json({ logs: filtered });
  });

  registerLearnRoutes(app, ai, normalizeSessionLanguage);

  app.post('/api/cleanup-transcript', async (c) => {
    let text = '';
    let fallback = '';
    let language = 'English';
    try {
      const body = await c.req.json<{ text: string; topic: string; language?: string; mode?: 'live' | 'final'; speaker?: string; context?: string }>();
      fallback = body?.text || '';
      text = (body?.text || '').trim();
      const topic = body?.topic || '';
      language = normalizeSessionLanguage(body?.language || 'English');
      const mode = body?.mode === 'live' ? 'live' : 'final';
      const speaker = (body?.speaker || 'Speaker').trim() || 'Speaker';
      const context = (body?.context || '').trim().slice(0, 2000);
      if (!text) return c.json({ cleaned: body?.text || '' });
      const simplifiedChinese = language === 'Simplified Chinese'
        ? `- You MUST output simplified Chinese characters (简体字) exclusively. Convert any traditional Chinese characters (繁體字) to their simplified equivalents.\n`
        : '';
      const cleanupPrompt =
        `Raw speech-to-text (may have missing spaces, merged words, or wrong words). Topic: "${topic}". Language: "${language}".\n\n` +
        `Task: produce a single readable transcript that matches what ${speaker} likely said.\n` +
        `- Insert spaces between words where ASR merged them (e.g. "thewater" → "the water").\n` +
        `- Fix homophones and technical terms using topic context and ${language} spelling conventions.\n` +
        `- Use prior conversation context to disambiguate words, names, and phrasing.\n` +
        `- Keep the same order and meaning; do not summarize or add ideas.\n` +
        simplifiedChinese +
        (mode === 'live'
          ? `- This is a live partial stream. Make spacing and grammar readable immediately, but preserve unfinished wording.\n`
          : `- This is a final transcript. Use complete punctuation and capitalization.\n`) +
        `- Output ONLY the corrected transcription — never the instructions, the prior conversation, or any commentary. If nothing needs fixing, output the transcription unchanged.\n\n` +
        (context ? `Prior conversation (for context only, do not output):\n${context}\n\n` : '') +
        `Transcription to correct (between the markers):\n<<<\n${text}\n>>>`;
      const chosenModel = mode === 'live' ? FAST_MODEL : CLEANUP_MODEL;
      let result;
      try {
        result = await ai.models.generateContent({
          model: chosenModel,
          contents: [{ role: 'user', parts: [{ text: cleanupPrompt }] }],
        });
      } catch {
        if (chosenModel !== FAST_MODEL) {
          result = await ai.models.generateContent({
            model: FAST_MODEL,
            contents: [{ role: 'user', parts: [{ text: cleanupPrompt }] }],
          });
        } else {
          throw new Error('Cleanup failed');
        }
      }
      const cleanedRaw = (result.text?.trim() || text).replace(/^<<<\s*|\s*>>>$/g, '').replace(/\s+/g, ' ').trim();
      // Flash occasionally echoes the whole prompt back for very short inputs; never let that reach a bubble.
      if (cleanupLooksBroken(text, cleanedRaw)) {
        console.warn(`[Poken] cleanup rejected (${cleanedRaw.length} chars for ${text.length} in): "${cleanedRaw.slice(0, 80)}"`);
        return c.json({ cleaned: text });
      }
      const cleaned = enforceTranscriptLanguage(cleanedRaw, language);
      return c.json({ cleaned: cleaned || text });
    } catch {
      const fallbackCleaned = enforceTranscriptLanguage(text || fallback, language);
      return c.json({ cleaned: fallbackCleaned || text || fallback }, 500);
    }
  });

  // ── HTTP server + WebSocket upgrade ────────────────────────────────────────
  // main.ts calls .listen(); this module only builds the server.
  app.use('/*', serveStatic({ root: './public' }));

  const server = http.createServer(getRequestListener(app.fetch));
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (pathname !== '/ws/live') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  });

  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    const url = new URL(request.url || '/', 'http://localhost');

    const topic      = url.searchParams.get('topic')     || 'the topic the teacher will explain';
    let persona      = url.searchParams.get('persona')   || 'eager';  // live: set_persona switches it mid-lesson
    let language     = normalizeSessionLanguage(url.searchParams.get('language'));
    let rawTeacherWindow = '';   // last ~80 raw transcript chars: script detection across Gemini's one-character chunks
    let droppedRaw = '';         // raw text the language filter stripped this utterance; recovered if the language switches
    const video      = url.searchParams.get('video')     === '1';
    const model      = video ? VIDEO_MODEL : AUDIO_MODEL;
    const connectedAt = Date.now();

    console.log('[Poken] New connection | topic:', topic, '| persona:', persona, '| language:', language, '| video:', video);

    // ── Per-connection state ───────────────────────────────────────────────
    const sessionLog: SessionEntry[] = [];
    let teacherTranscriptBuf = '';
    let coachingCooldown     = 0;
    let reflectionRequested  = false;
    let teacherHasSpoken     = false;
    let sessionStartedAt     = Date.now();  // reset in onopen so the blackout starts when Live is actually ready
    let sessionReady         = false;
    let tearingDown          = false;
    let handoverStarted      = false;

    // Media toggles must live in connection scope — the original referenced an
    // undeclared `media` here, the ReferenceError was swallowed, and the
    // [MEDIA] cues the prompt depends on were never delivered.
    const mediaState = { camera: false, whiteboard: false, screen: false };

    const pendingMaterialFiles: { name: string; base64: string; mimeType: string }[] = [];
    const MAX_MATERIALS_CHARS = 30_000;
    let materialsContext = '';  // final assembled context, handed to the client for resume
    // Pasted notes arrive as a pre-session `materials_text` frame, never in the URL
    // (URLs land in Cloud Run request logs and have a length cap).
    let materials = '';
    // Learn Mode explanations covered by this session (pre-session `learn_index` frame).
    let learnIndex: LearnIndexEntry[] = [];
    // Set when this session was started from the Open Questions page to answer one specific
    // question. Only the question text travels — never the old transcript, which would cost far
    // more tokens than it is worth. The topic name alone re-establishes enough context.
    let seedQuestion = '';

    // Resume state (set by a `resume` frame before ready_to_start)
    let resumeInfo: ResumeToken | null = null;
    let elapsedBaseMs = 0;
    let handleIssuedAt = 0;
    let lastExchangeAt = 0;
    let rejoining = false;   // the Gemini session has been swapped behind this same socket at least once
    let resumeMaterialsContext = '';
    const resumeHandles = new Map<string, string>();  // Gemini session-resumption handle, keyed 'solo'
    let digestSummary = '';
    let teacherTurns = 0;

    // Blackout: buffer instead of discard, flush in order when the window lifts.
    const blackoutBuffer: string[] = [];
    let blackoutFlushTimer: ReturnType<typeof setTimeout> | null = null;
    let speechEndSettleTimer: ReturnType<typeof setTimeout> | null = null;

    // Transcription that arrives before teacherHasSpoken is held, not dropped.
    const pendingTeacherTranscript: { text: string; ts: number }[] = [];
    const PENDING_TRANSCRIPT_WINDOW_MS = 3000;

    // Token telemetry (estimates) — the diagnosis if a 1007 ever recurs.
    const tokenEstimate = { audioSec: 0, textChars: 0, frames: 0 };
    function estimatedTokens(): number {
      return Math.round(tokenEstimate.audioSec * 32 + tokenEstimate.textChars / 4 + tokenEstimate.frames * 258);
    }

    // Session ref
    let session: LiveSession | null = null;
    const sessionOpenedAt = new Map<string, number>();
    let studentTranscriptBuf = '';

    function sendJson(data: object) {
      try {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
      } catch (e) {
        console.error('[Poken] sendJson failed (socket may be closing):', e);
      }
    }
    function sendDebug(level: 'info' | 'warn' | 'error', message: string) {
      sendJson({ type: 'debug', level, message });
    }
    function fatal(message: string) {
      sendJson({ type: 'error', message });
      setTimeout(() => { if (socket.readyState === WebSocket.OPEN) socket.close(); }, ERROR_FLUSH_DELAY_MS);
    }

    function sendToSession(input: types.LiveSendRealtimeInputParameters) {
      try { session?.sendRealtimeInput(input); } catch (_) {}
    }
    function sendText(text: string) {
      tokenEstimate.textChars += text.length;
      sendToSession({ text });
    }
    function sendImage(base64: string) {
      tokenEstimate.frames += 1;
      sendToSession({ video: { data: base64, mimeType: 'image/jpeg' } });
    }
    function sendAudio(base64: string) {
      if (!session) {
        // The Gemini session is being swapped — hold audio; the next open flushes it in order.
        blackoutBuffer.push(base64);
        if (blackoutBuffer.length > 400) blackoutBuffer.shift();
        return;
      }
      tokenEstimate.audioSec += (base64.length * 0.75) / 32000; // PCM16 mono @16k = 32000 bytes/s
      sendToSession({ audio: { data: base64, mimeType: 'audio/pcm;rate=16000' } });
    }

    // Keep the connection alive through HTTP/1.1 proxies that drop idle sockets.
    const pingTimer = setInterval(() => {
      try { if (socket.readyState === WebSocket.OPEN) socket.ping(); } catch (_) {}
    }, 25_000);

    // ── Handover ───────────────────────────────────────────────────────────
    function buildDigest(): string {
      const tail = sessionLog
        .slice(-20)
        .map(e => `${e.role === 'teacher' ? 'Teacher' : e.name}: ${e.text}`)
        .join('\n')
        .slice(-2000);
      return [digestSummary ? `Covered so far: ${digestSummary}` : '', tail].filter(Boolean).join('\n\n');
    }

    function buildResumeToken(opts: { dropHandles?: boolean } = {}): ResumeToken {
      const handles: Record<string, string> = {};
      if (!opts.dropHandles) resumeHandles.forEach((h, id) => { handles[id] = h; });
      const elapsedMs = elapsedBaseMs + (Date.now() - connectedAt);
      return {
        v: 1,
        topic, persona, language, video,
        handles,
        handleAt: handleIssuedAt,
        lastExchangeAt,
        digest: buildDigest(),
        logTail: sessionLog.slice(-60).map(e => ({ ...e, text: e.text.slice(0, 400) })),
        elapsedMs,
        issuedAt: Date.now(),
      };
    }

    function pushSessionState() {
      sendJson({ type: 'session_state', resumeToken: buildResumeToken() });
    }

    /** Ask the client to reconnect with a resume token. Idempotent. */
    function beginHandover(reason: string, opts: { dropHandles?: boolean } = {}) {
      if (handoverStarted || tearingDown || socket.readyState !== WebSocket.OPEN) return;
      handoverStarted = true;
      console.log(`[Poken] Handover (${reason}) | est tokens=${estimatedTokens()} | handles=${opts.dropHandles ? 0 : resumeHandles.size}`);
      sendDebug('warn', `Session handover: ${reason}`);
      sendJson({ type: 'session_handover', reason, resumeToken: buildResumeToken(opts) });
    }

    // Cloud Run closes the request — and this socket — at --timeout; hand the client over first.
    const handoverTimer = setTimeout(() => beginHandover('request timeout'), Math.max(5_000, SESSION_TIMEOUT_MS - HANDOVER_LEAD_MS));

    async function refreshDigestSummary() {
      const transcript = sessionLog.slice(-40).map(e => `${e.role === 'teacher' ? 'Teacher' : e.name}: ${e.text}`).join('\n');
      if (!transcript) return;
      try {
        const result = await ai.models.generateContent({
          model: FAST_MODEL,
          contents: [{ role: 'user', parts: [{ text:
            `A teacher is explaining "${topic}" to AI students. In at most 120 words, summarize what has been covered so far and any errors the students made that the teacher corrected. Plain text, no preamble.` +
            (digestSummary ? `\n\nPrevious summary:\n${digestSummary}\n\n` : '\n\n') +
            `Recent transcript:\n${transcript}`
          }] }],
        });
        const text = result.text?.trim();
        if (text) digestSummary = text.slice(0, 1200);
      } catch (_) {}
    }

    /** The Live session gets resumption + compression; the handle rides in on resume. */
    function liveConfig(voice: string, systemInstruction: string, handle?: string): types.LiveConnectConfig {
      return {
        responseModalities: [Modality.AUDIO],
        outputAudioTranscription: {},
        inputAudioTranscription: {},
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        systemInstruction,
        contextWindowCompression: { slidingWindow: {} },
        sessionResumption: handle ? { handle } : {},
      };
    }

    function resumeBlock(): string {
      const digest = buildDigest();
      return `[RESUME] You are rejoining a lesson already in progress on "${topic}". Do NOT greet again. Do NOT mention reconnecting or any interruption. ` +
        (digest ? `Here is what has happened so far:\n${digest}\n\n` : '') +
        `Continue exactly as before: stay silent and wait for the teacher to speak next.`;
    }

    const reopenTimes: number[] = [];
    /**
     * Called from the live session's onclose. Gemini closes sessions for its own reasons
     * (goAway, and an intermittent 1007 "audio content type not supported" that lands mid-reply
     * with no audio from us) — every close is recovered in place, bounded to 3 per minute so a
     * persistently rejected session still ends with a visible error instead of a loop.
     */
    function onGeminiClosed(id: string, code: number, reason: string) {
      if (tearingDown) return;
      if (!sessionReady) return; // startup failure is reported by the connect catch
      const now = Date.now();
      const age = now - (sessionOpenedAt.get(id) ?? now);
      while (reopenTimes.length && now - reopenTimes[0] > 60_000) reopenTimes.shift();
      if (reopenTimes.length >= 3) {
        fatal(`Live session ended (code ${code}${reason ? ': ' + reason : ''})`);
        return;
      }
      reopenTimes.push(now);
      // A session that died young was probably rejected as resumed; rebuild it from the digest.
      if (age < 10_000 && (resumeInfo || rejoining)) resumeHandles.delete(id);
      reopenGemini(`Gemini session closed after ${Math.round(age / 1000)}s (code ${code}${reason ? ': ' + reason.slice(0, 80) : ''})`);
    }

    let reopenInFlight = false;
    /**
     * Swap the Gemini session behind this same browser socket — on goAway (Gemini's ~10-minute
     * connection limit) or a mid-lesson close. With the resumption handle the model keeps its
     * memory and the teacher never notices; the client handover is reserved for the request timeout.
     */
    async function reopenGemini(reason: string) {
      if (reopenInFlight || tearingDown || handoverStarted || socket.readyState !== WebSocket.OPEN) return;
      reopenInFlight = true;
      rejoining = true;
      console.log(`[Poken] Reopening Gemini session in place (${reason}) | handle=${resumeHandles.has('solo')} | est tokens=${estimatedTokens()}`);
      sendDebug('warn', `Reopening Gemini session: ${reason}`);
      const old = session;
      session = null; // teacher audio queues in blackoutBuffer until the new session opens
      try { old?.close(); } catch (_) {}
      try {
        await startSolo(materialsContext);
      } finally {
        reopenInFlight = false;
      }
    }

    function handleSessionMeta(id: string, msg: types.LiveServerMessage) {
      const upd = msg.sessionResumptionUpdate;
      if (upd?.resumable && upd.newHandle && resumeHandles.get(id) !== upd.newHandle) {
        resumeHandles.set(id, upd.newHandle);
        handleIssuedAt = Date.now();
        // A token pushed only on teacher turns would carry a handle from before the model's
        // reply; refresh it whenever Gemini issues a newer one so resume never loses a turn.
        if (sessionReady) pushSessionState();
      }
      if (msg.goAway) reopenGemini(`Gemini goAway${msg.goAway.timeLeft ? ' (' + msg.goAway.timeLeft + ' left)' : ''}`);
    }

    // ── Teacher speech plumbing ────────────────────────────────────────────
    function markTeacherSpoken(source: string) {
      if (teacherHasSpoken) return;
      teacherHasSpoken = true;
      sendDebug('info', `Teacher speech detected (${source})`);
      const cutoff = Date.now() - PENDING_TRANSCRIPT_WINDOW_MS;
      const flush = pendingTeacherTranscript.filter(p => p.ts >= cutoff);
      pendingTeacherTranscript.length = 0;
      for (const p of flush) ingestTeacherTranscript(p.text);
    }

    /** Switch the live session language: model instruction, transcript filters, client, resume token. */
    function switchLanguage(next: string, source: 'request' | 'detected') {
      if (!ALLOWED_SESSION_LANGUAGES.has(next) || next === language) return;
      const prev = language;
      language = next;
      rawTeacherWindow = '';
      console.log(`[Poken] Language ${prev} → ${next} (${source})`);
      sendDebug('info', `Session language switched to ${next} (${source})`);
      const chars = next === 'Simplified Chinese' ? ' using simplified characters (简体字) exclusively' : '';
      sendText(source === 'request'
        ? `[SYSTEM] The teacher asked to switch languages. The session language is now ${next}. Reply with one short sentence in ${next}${chars} confirming, then continue the lesson entirely in ${next}.`
        : `[SYSTEM] The teacher is now speaking ${next}. The session language is now ${next}. From this point on speak ONLY ${next}${chars}. Do not comment on the change — just continue naturally.`);
      sendJson({ type: 'language_changed', language: next, source });
      pushSessionState();
      // Characters stripped before the switch was recognised belong to the teacher's sentence — put them back.
      const recovered = transcriptChunk(droppedRaw, next).trimStart();
      droppedRaw = '';
      if (recovered) {
        teacherTranscriptBuf = joinChunk(teacherTranscriptBuf, recovered);
        sendJson({ type: 'teacher_transcript', text: recovered });
      }
    }

    /** Script-level auto-detection over a rolling window of raw (unfiltered) transcript text. */
    function autoDetectLanguage(rawChunk: string) {
      rawTeacherWindow = (rawTeacherWindow + rawChunk).slice(-80);
      const script = dominantScript(rawTeacherWindow);
      if (!script || script === scriptOfLanguage(language)) return;
      // A romanized word or two inside a CJK/Arabic/Hindi session is not a switch; a dozen Latin letters is.
      if (script === 'Latin' && (rawTeacherWindow.match(/\p{Script=Latin}/gu) || []).length < 12) return;
      switchLanguage(SCRIPT_LANGUAGE[script], 'detected');
    }

    /** Teacher ASR chunk: language-enforced, logged, relayed. */
    function ingestTeacherTranscript(rawChunk: string) {
      if (!teacherHasSpoken) {
        pendingTeacherTranscript.push({ text: rawChunk, ts: Date.now() });
        if (pendingTeacherTranscript.length > 20) pendingTeacherTranscript.shift();
        return;
      }
      autoDetectLanguage(rawChunk); // before enforcement, which would strip a new script entirely
      const chunk = transcriptChunk(rawChunk, language);
      if (!chunk) { if (rawChunk.trim()) droppedRaw += rawChunk; return; }
      teacherTranscriptBuf = joinChunk(teacherTranscriptBuf, chunk);
      sendJson({ type: 'teacher_transcript', text: chunk });
    }

    function flushBlackout() {
      blackoutFlushTimer = null;
      if (!blackoutBuffer.length) return;
      const chunks = blackoutBuffer.splice(0, blackoutBuffer.length);
      sendDebug('info', `Blackout lifted — flushing ${chunks.length} buffered audio chunks`);
      for (const b64 of chunks) sendAudio(b64);
    }

    function onTeacherAudio(data: Buffer) {
      markTeacherSpoken('first audio');
      const b64 = data.toString('base64');
      const sinceOpen = Date.now() - sessionStartedAt;
      if (sinceOpen < AUDIO_BLACKOUT_MS) {
        blackoutBuffer.push(b64);
        if (!blackoutFlushTimer) blackoutFlushTimer = setTimeout(flushBlackout, AUDIO_BLACKOUT_MS - sinceOpen);
        sendDebug('info', `Audio buffered (blackout: ${AUDIO_BLACKOUT_MS - sinceOpen}ms left)`);
        return;
      }
      if (blackoutBuffer.length) flushBlackout();
      sendAudio(b64);
    }

    /** Process material_file: vision-analyze, then hand the text to the Live session. */
    async function processMaterialFile(name: string, base64: string, mimeType: string): Promise<string> {
      const maxChars = 20_000;
      sendJson({ type: 'material_processing', filename: name });
      try {
        const { content, error } = await extractMaterialTextWithFallback(name, base64, mimeType, maxChars);
        sendJson({ type: 'material_processed', filename: name });
        if (content) return `[The teacher has shared a study material: "${name}".]\n\nContent:\n${content}`;
        return `[The teacher has shared a file: "${name}".]${error ? ` (${error})` : ''}`;
      } catch (e: any) {
        sendJson({ type: 'material_processed', filename: name });
        return `[The teacher has shared a file: "${name}".] (analysis failed: ${e.message})`;
      }
    }

    async function onTeacherSpeechEnd(media?: { camera?: boolean; whiteboard?: boolean; screen?: boolean }) {
      const text = teacherTranscriptBuf.trim();
      teacherTranscriptBuf = '';
      droppedRaw = '';
      if (!text) return;
      console.log(`[Poken][SpeechEnd] Teacher said: "${text.slice(0, 200)}"`);
      console.log(`[Poken][Tokens] est≈${estimatedTokens()} (audio ${tokenEstimate.audioSec.toFixed(1)}s, text ${tokenEstimate.textChars} chars, frames ${tokenEstimate.frames}) | handles=${resumeHandles.size}`);

      sessionLog.push({ role: 'teacher', name: 'Teacher', text, time: Date.now() });
      lastExchangeAt = Date.now();
      teacherTurns++;
      const requested = detectLanguageSwitchRequest(text);
      if (requested) switchLanguage(requested, 'request');
      if (teacherTurns % 10 === 0) refreshDigestSummary().catch(() => {});
      pushSessionState();

      if (isVisionRefreshRequest(text)) {
        console.log('[Poken] Vision refresh requested via speech:', text.slice(0, 80));
        sendJson({ type: 'request_screenshot' });
      }

      maybeCoach(text, media);
    }

    /** One coaching tip per COACHING_COOLDOWN_MS, for spoken and typed teacher turns alike. */
    function maybeCoach(text: string, media?: { camera?: boolean; whiteboard?: boolean; screen?: boolean }) {
      const now = Date.now();
      if (now <= coachingCooldown) return;
      if (text.split(/\s+/).length < 12) return;   // too short to coach — and must not consume the cooldown
      coachingCooldown = now + COACHING_COOLDOWN_MS;
      generateCoachingTip(ai, topic, text, media ?? mediaState).then(tip => {
        if (tip) sendJson({ type: 'coaching_tip', tip });
      });
    }

    async function onStudentSpeech(name: string, text: string) {
      if (!text) return;
      sessionLog.push({ role: 'student', name, text, time: Date.now() });
      lastExchangeAt = Date.now();
      const emotion = await classifyEmotion(ai, text);
      if (emotion) sendJson({ type: 'emotion', state: emotion });
    }

    /** Typed teacher input. */
    function onTextInput(userText: string) {
      markTeacherSpoken('text input');
      const requested = detectLanguageSwitchRequest(userText);
      if (requested) switchLanguage(requested, 'request');
      sendText(userText);
      sessionLog.push({ role: 'teacher', name: 'Teacher', text: userText, time: Date.now() });
      lastExchangeAt = Date.now();
      pushSessionState();
      if (isVisionRefreshRequest(userText)) {
        console.log('[Poken] Vision refresh requested via text_input');
        sendJson({ type: 'request_screenshot' });
      }
      const urls = extractSharedUrls(userText);
      if (urls.length) {
        (async () => {
          for (const u of urls) {
            const note = await fetchUrlContextNote(u);
            if (note) sendText(note);
          }
        })();
      }
      maybeCoach(userText);
    }

    // ── Session creation ───────────────────────────────────────────────────
    /** Build the materials string (pasted notes + analyzed files, or the resumed context), then create the Live session. */
    async function startSessionWithMaterials() {
      let fullMaterials = resumeInfo ? resumeMaterialsContext : materials;
      const total = pendingMaterialFiles.length;

      if (total > 0) {
        sendJson({ type: 'info', message: `Analyzing ${total} file${total > 1 ? 's' : ''} with AI vision...` });
        const results = await Promise.allSettled(
          pendingMaterialFiles.map(async (f, idx) => {
            sendJson({ type: 'material_progress', filename: f.name, status: 'processing', current: idx + 1, total });
            const { content } = await extractMaterialTextWithFallback(f.name, f.base64, f.mimeType, MAX_MATERIALS_CHARS);
            sendJson({ type: 'material_progress', filename: f.name, status: 'done', current: idx + 1, total });
            return { name: f.name, content };
          })
        );
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value.content) {
            fullMaterials += '\n\n---\n[From file: ' + r.value.name + ']\n' + r.value.content.slice(0, MAX_MATERIALS_CHARS);
          }
        }
      }
      if (fullMaterials.length > MAX_MATERIALS_CHARS * 2) {
        fullMaterials = fullMaterials.slice(0, MAX_MATERIALS_CHARS * 2) + '\n\n[… truncated …]';
      }
      materialsContext = fullMaterials;
      // The client holds this so a handover never re-runs vision analysis.
      sendJson({ type: 'session_context', materialsContext });

      if (socket.readyState !== WebSocket.OPEN) return;

      await startSolo(fullMaterials);
    }

    /** ai.live.connect with the resumption handle; if the handle is refused, fall back to a fresh session + [RESUME] digest. */
    async function connectLive(id: string, cfg: (handle?: string) => types.LiveConnectConfig, callbacks: any): Promise<LiveSession> {
      const handle = resumeHandles.get(id);
      if (handle) {
        try {
          return await ai.live.connect({ model, config: cfg(handle), callbacks });
        } catch (e: any) {
          console.warn(`[Poken] Resume handle rejected for ${id}, starting fresh: ${e.message ?? e}`);
          resumeHandles.delete(id);
        }
      }
      return await ai.live.connect({ model, config: cfg(), callbacks });
    }

    /**
     * After onopen: either greet (fresh) or silently resume. Takes a getter because
     * onopen fires synchronously inside ai.live.connect(), before the awaited
     * session binding exists — the 400ms delay is what makes the read safe.
     */
    function afterOpen(getSess: () => LiveSession | null, id: string, greeting: string) {
      sessionOpenedAt.set(id, Date.now());
      // Always send the digest on a resume, even with a handle: Gemini's resumption handle lags
      // its own state by a few seconds, so a handle issued right after an exchange can resume a
      // model that is missing that exchange (seen: the student forgot a word taught 4s earlier).
      // A redundant reminder to a model that does remember is harmless; a lost turn is not.
      const text = (resumeInfo || rejoining) ? resumeBlock() : greeting;
      setTimeout(() => { try { getSess()?.sendRealtimeInput({ text }); } catch (_) {} }, GREETING_KICK_DELAY_MS);
    }

    async function startSolo(fullMaterials: string) {
      const instruction = getStudentInstruction(topic, persona, fullMaterials, video, language);
      let sess: LiveSession | null = null;
      try {
        sess = await connectLive('solo', (h) => liveConfig('Zephyr', instruction, h), {
          onopen: () => {
            console.log(`[Poken] Live session opened${resumeHandles.has('solo') ? ' (resumed)' : ''}, topic:`, topic);
            sendDebug('info', `Gemini Live session opened${resumeHandles.has('solo') ? ' (resumed)' : ''}`);
            sessionStartedAt = Date.now();
            if (rejoining) {
              sendJson({ type: 'info', message: `Reconnected — keep going: ${topic}` });
            } else {
              sendJson({ type: 'session_ready' });
              sendJson({ type: 'info', message: resumeInfo ? `Reconnected. Keep going: ${topic}` : `Your student is ready. Start explaining: ${topic}` });
            }
            afterOpen(() => sess, 'solo', seedQuestion
              ? `The teacher came back specifically to answer a question you asked them last time. Greet them in one short sentence in ${language}, then immediately ask this question again, in your own words, as the same curious student: "${seedQuestion}". Ask ONLY that one question and then wait silently for their answer. Do not preface it with a summary of last time, and do not ask anything else.`
              : `Say a short greeting out loud in ${language} right now (e.g. "Hi, ready when you are!" or "Hey there!"). Say ONLY this greeting — nothing else. Do NOT ask a question. Do NOT mention the topic. Just greet and wait silently.`);
          },
          onmessage: (message: types.LiveServerMessage) => {
            handleSessionMeta('solo', message);
            if (message.serverContent?.inputTranscription?.text) {
              ingestTeacherTranscript(message.serverContent.inputTranscription.text);
            }
            if (message.serverContent?.outputTranscription?.text) {
              const chunk = transcriptChunk(message.serverContent.outputTranscription.text, language);
              if (chunk) {
                studentTranscriptBuf = joinChunk(studentTranscriptBuf, chunk);
                sendJson({ type: 'transcript', text: chunk });
              }
            }
            if (message.serverContent?.modelTurn?.parts) {
              for (const part of message.serverContent.modelTurn.parts) {
                if (part.inlineData?.data) sendJson({ type: 'audio', base64: part.inlineData.data });
              }
            }
            if (message.serverContent?.turnComplete) {
              sendJson({ type: 'turn_complete' });
              const full = studentTranscriptBuf.trim();
              studentTranscriptBuf = '';
              if (full) onStudentSpeech('Student', full);
            }
          },
          onerror: (e: any) => {
            console.error('[Poken] Session error:', e?.message ?? JSON.stringify(e));
            sendDebug('error', `Gemini session error: ${e?.message ?? JSON.stringify(e)}`);
          },
          onclose: (e: any) => {
            if (!sess || sess !== session) return; // a session we already replaced
            console.log('[Poken] Live session closed:', e?.code, e?.reason || '');
            sendDebug('error', `Gemini session closed: code ${e?.code}${e?.reason ? ', reason: ' + e.reason : ''}`);
            onGeminiClosed('solo', e?.code, e?.reason || '');
          },
        });
        session = sess;
        sessionReady = true;
        // Audio held during a swap goes out once the new session's blackout window lifts.
        if (blackoutBuffer.length && !blackoutFlushTimer) blackoutFlushTimer = setTimeout(flushBlackout, AUDIO_BLACKOUT_MS);
      } catch (e: any) {
        console.error('[Poken] Failed to connect to Live API:', e);
        sendDebug('error', `Failed to connect to Gemini Live API: ${e.message}`);
        if (rejoining) beginHandover(`Gemini reopen failed: ${e.message}`);
        else fatal(`Failed to connect: ${e.message}`);
      }
    }

    // ── Message handler ────────────────────────────────────────────────────
    socket.on('message', (data: Buffer, isBinary: boolean) => { try {
      // Pre-session: only materials_text / material_file / learn_index / resume / ready_to_start; everything else (binary included) is dropped.
      if (!sessionReady) {
        if (isBinary) return;
        let parsed: any;
        try { parsed = JSON.parse(data.toString()); } catch (_) { return; }
        if (parsed.type === 'materials_text' && typeof parsed.text === 'string') {
          materials = parsed.text.slice(0, MAX_MATERIALS_CHARS * 2);
          return;
        }
        if (parsed.type === 'learn_index') {
          learnIndex = parseLearnIndex(parsed.nodes);
          return;
        }
        if (parsed.type === 'seed_question' && typeof parsed.question === 'string') {
          seedQuestion = parsed.question.trim().slice(0, 1000);
          return;
        }
        if (parsed.type === 'material_file' && parsed.base64 && parsed.name) {
          pendingMaterialFiles.push({ name: parsed.name, base64: parsed.base64, mimeType: parsed.mimeType || 'application/octet-stream' });
          return;
        }
        if (parsed.type === 'resume' && parsed.token && parsed.token.v === 1) {
          const t = parsed.token as ResumeToken;
          resumeInfo = t;
          elapsedBaseMs = Number(t.elapsedMs) || 0;
          handleIssuedAt = Number(t.handleAt) || 0;
          lastExchangeAt = Number(t.lastExchangeAt) || 0;
          resumeMaterialsContext = String(parsed.materialsContext || '').slice(0, MAX_MATERIALS_CHARS * 2);
          resumeHandles.clear();
          for (const [id, h] of Object.entries(t.handles || {})) if (typeof h === 'string' && h) resumeHandles.set(id, h);
          digestSummary = typeof t.digest === 'string' ? t.digest.slice(0, 4000) : '';
          for (const e of (Array.isArray(t.logTail) ? t.logTail : []).slice(-60)) {
            if (e && typeof e.text === 'string') sessionLog.push({ role: e.role === 'teacher' ? 'teacher' : 'student', name: String(e.name || ''), text: e.text, time: Number(e.time) || Date.now() });
          }
          teacherHasSpoken = true; // mid-lesson: never gate transcription on resume
          console.log(`[Poken] Resume requested | handles=${resumeHandles.size} | log=${sessionLog.length} | elapsed=${Math.round((t.elapsedMs || 0) / 1000)}s`);
          sendDebug('info', `Resuming session (${resumeHandles.size} Gemini handle${resumeHandles.size === 1 ? '' : 's'})`);
          return;
        }
        if (parsed.type === 'ready_to_start') {
          startSessionWithMaterials().catch(err => {
            console.error('[Poken] startSessionWithMaterials failed:', err);
            fatal(`Failed to start: ${err?.message ?? err}`);
          });
          return;
        }
        return;
      }

      if (isBinary) { onTeacherAudio(data); return; }

      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch (_) { return; }

      switch (msg.type) {
        case 'speech_start':
          markTeacherSpoken('speech_start');
          // Resumed within the settle window: the next speech_end processes the combined buffer.
          if (speechEndSettleTimer) { clearTimeout(speechEndSettleTimer); speechEndSettleTimer = null; }
          // Interruption is NOT triggered here — speech_start fires on any noise.
          return;
        case 'speech_end': {
          // Goes through onTeacherAudio so a session still in its blackout queues the silence like any audio.
          onTeacherAudio(Buffer.from(silencePcmBase64(AUDIO_TAIL_SILENCE_MS), 'base64'));
          // gemini-3.1-flash-live-preview only closes the teacher's turn on an explicit stream end; 2.5 tolerates it.
          sendToSession({ audioStreamEnd: true });
          if (speechEndSettleTimer) clearTimeout(speechEndSettleTimer);
          const media = msg.media;
          speechEndSettleTimer = setTimeout(() => {
            speechEndSettleTimer = null;
            onTeacherSpeechEnd(media);
          }, SPEECH_END_SETTLE_MS);
          return;
        }
        case 'request_reflection':
          if (reflectionRequested) return;
          reflectionRequested = true;
          generateReflection(ai, topic, sessionLog, language, learnIndex, seedQuestion).then(reflData => { sendJson({ type: 'reflection', data: reflData }); });
          return;
        case 'text_input':
          if (typeof msg.text === 'string' && msg.text.trim()) onTextInput(msg.text.trim());
          return;
        case 'set_persona': {
          // Mid-lesson persona switch, same mechanism as switchLanguage: a [SYSTEM] note, no reopen.
          // The resume token carries `persona`, so a handover rebuilds with the new one.
          const next = typeof msg.persona === 'string' ? msg.persona : '';
          if (!PERSONA_TRAITS[next] || next === persona) return;
          console.log(`[Poken] Persona ${persona} → ${next}`);
          persona = next;
          sendText(`[SYSTEM] The teacher changed which student you are. From now on, drop your previous persona entirely and take on this one:\n${PERSONA_TRAITS[next]}\nDo not announce or comment on the change — just continue the lesson as this student, keeping everything you have learned so far.`);
          sendDebug('info', `Persona switched to ${next}`);
          sendJson({ type: 'persona_changed', persona: next });
          pushSessionState();
          return;
        }
        case 'media_state': {
          const parts: string[] = [];
          if (typeof msg.camera === 'boolean')     { mediaState.camera = msg.camera;         parts.push(`[MEDIA] Camera ${msg.camera ? 'ON' : 'OFF'}`); }
          if (typeof msg.whiteboard === 'boolean') { mediaState.whiteboard = msg.whiteboard; parts.push(`[MEDIA] Whiteboard ${msg.whiteboard ? 'ON' : 'OFF'}`); }
          if (typeof msg.screen === 'boolean')     { mediaState.screen = msg.screen;         parts.push(`[MEDIA] Screen share ${msg.screen ? 'ON' : 'OFF'}`); }
          if (parts.length) sendText(parts.join('. ') + '. Only claim to see content from sources that are ON.');
          return;
        }
        case 'video_frame':
          if (typeof msg.base64 === 'string') sendImage(msg.base64);
          return;
        case 'vision_screenshot':
          if (typeof msg.base64 === 'string') {
            sendImage(msg.base64);
            sendText(VISION_SCREENSHOT_NOTE);
          }
          return;
        case 'debug_reopen':
          // Test hook (never in production): exercise the in-place Gemini reopen on demand.
          if (process.env.NODE_ENV !== 'production') reopenGemini('debug_reopen');
          return;
        case 'material_file':
          if (msg.base64 && msg.name) {
            const name = String(msg.name || 'file');
            const mimeType = String(msg.mimeType || 'application/octet-stream');
            console.log(`[Poken] Received study material: ${name} (${mimeType})`);
            processMaterialFile(name, msg.base64, mimeType)
              .then(message => { sendText(message); sendJson({ type: 'material_ready', name }); })
              .catch(e => {
                console.error('[Poken] material_file extract failed', e);
                sendText(`[The teacher has shared a file: "${name}".]`);
                sendJson({ type: 'material_ready', name, failed: true });
              });
          }
          return;
        default:
          return;
      }
    } catch (err: any) {
      // A malformed frame must never kill a session.
      console.error('[Poken] Message handler error (connection kept alive):', err);
      sendDebug('error', `Server message handler error: ${err?.message ?? err}`);
    } });

    function teardown() {
      tearingDown = true;
      clearTimeout(handoverTimer);
      clearInterval(pingTimer);
      if (blackoutFlushTimer) { clearTimeout(blackoutFlushTimer); blackoutFlushTimer = null; }
      if (speechEndSettleTimer) { clearTimeout(speechEndSettleTimer); speechEndSettleTimer = null; }
      try { session?.close(); } catch (_) {}
    }

    socket.on('close', () => {
      console.log(`[Poken] Client disconnected${handoverStarted ? ' (after handover)' : ''}`);
      teardown();
    });

    socket.on('error', (e) => {
      console.error('[Poken] WebSocket error:', e);
      teardown();
    });
  });

  return server;
}

const server = buildServer();
export default server;
