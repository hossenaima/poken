// ElevenLabs Scribe v2 Realtime — teacher speech-to-text.
//
// Gemini Live's input transcription fragments words ("gene ra te me a dia gram") and can only
// tell languages apart by script. Scribe returns whole words with spaces and its own detected
// language code, so the same PCM16/16 kHz frames the browser already sends are forked here.
// Everything about it is best-effort: a missing key, a refused socket or a mid-lesson close
// falls the connection back to Gemini's transcription (`onFallback`), never ends the session.
import { WebSocket } from 'ws';

const SCRIBE_MODEL = 'scribe_v2_realtime';
const SCRIBE_URL = process.env.ELEVENLABS_STT_URL || 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';

const MAX_QUEUED_CHUNKS = 400;      // ~50s of 128ms frames held while the socket opens
// Under commit_strategy=manual nothing but partials comes back until a commit lands. Commit only
// at the browser's speech_end: committing on a timer mid-utterance makes the API throttle
// (`commit_throttled` close) and cuts words in half ("sunlight-Mm-hmm", "叶绿-叶绿素"), whereas one
// commit per utterance returns the whole sentence, correctly punctuated.
const MAX_CONSECUTIVE_FAILURES = 3; // reset by every `session_started`
const RECONNECT_DELAYS_MS = [500, 1000, 2000];

/** ElevenLabs returns ISO-639-1 or -3; the session set is the 8 ALLOWED_SESSION_LANGUAGES. */
const SCRIBE_LANGUAGES: Record<string, string> = {
  en: 'English', eng: 'English',
  es: 'Spanish', spa: 'Spanish',
  fr: 'French', fra: 'French', fre: 'French',
  de: 'German', deu: 'German', ger: 'German',
  pt: 'Portuguese', por: 'Portuguese',
  hi: 'Hindi', hin: 'Hindi',
  ar: 'Arabic', ara: 'Arabic',
  zh: 'Simplified Chinese', zho: 'Simplified Chinese', chi: 'Simplified Chinese', cmn: 'Simplified Chinese',
};

/** A session language for a Scribe language code, or null for the other 80-odd languages. */
export function mapScribeLanguage(code: string | null | undefined): string | null {
  if (!code) return null;
  const base = code.trim().toLowerCase().replace(/_/g, '-').split('-')[0];
  return SCRIBE_LANGUAGES[base] ?? null;
}

/** The part of `text` not yet handed to the caller, given what was already emitted for this segment. */
export function segmentDelta(emitted: string, text: string): string {
  if (!text) return '';
  if (!emitted) return text;
  if (text.startsWith(emitted)) return text.slice(emitted.length);
  // A revision that is not a forward extension cannot be applied: the transcript downstream is
  // append-only, so re-sending it would duplicate the words instead of replacing them.
  return '';
}

/** Errors that will not fix themselves on a retry. */
const PERMANENT_ERRORS = new Set(['auth_error', 'quota_exceeded', 'unaccepted_terms', 'session_time_limit_exceeded']);

export type ScribeEvent =
  | { kind: 'started' }
  | { kind: 'transcript'; text: string; committed: boolean }
  | { kind: 'language'; language: string }
  | { kind: 'error'; code: string; permanent: boolean }
  | { kind: 'ignore' };

/** One Scribe frame as the connection cares about it. Partial transcripts are ignored: only
 *  final/committed segments reach the transcript path, so nothing is ingested twice. */
export function parseScribeEvent(raw: string): ScribeEvent {
  let msg: any;
  try { msg = JSON.parse(raw); } catch (_) { return { kind: 'ignore' }; }
  switch (msg?.message_type) {
    case 'session_started':
      return { kind: 'started' };
    case 'final_transcript':
      return { kind: 'transcript', text: String(msg.text || ''), committed: false };
    case 'committed_transcript':
      return { kind: 'transcript', text: String(msg.text || ''), committed: true };
    // Delivered late and only useful for the language code — the text repeats the segment above.
    case 'final_transcript_with_timestamps':
    case 'committed_transcript_with_timestamps': {
      const language = mapScribeLanguage(msg.language_code);
      return language ? { kind: 'language', language } : { kind: 'ignore' };
    }
    // `input_error` rejects a frame we sent; `error` is the session-level form.
    case 'input_error':
    case 'error': {
      const code = String(msg.error || msg.message || 'error');
      return { kind: 'error', code, permanent: PERMANENT_ERRORS.has(code) };
    }
    default:
      return { kind: 'ignore' };
  }
}

export type ScribeCallbacks = {
  /** A new stretch of teacher transcript, whole words, in order. */
  onTranscript: (text: string) => void;
  /** Scribe detected one of the session languages and it is not the current one. */
  onLanguage: (language: string) => void;
  /** Scribe is gone for this connection — the caller must use Gemini's transcription. Fires once. */
  onFallback: (reason: string) => void;
  onDebug: (level: 'info' | 'warn' | 'error', message: string) => void;
};

export class ScribeTranscriber {
  private socket: WebSocket | null = null;
  private queue: string[] = [];
  private emitted = '';                     // transcript already emitted for the open segment
  private stopped = false;                  // teardown
  private failed = false;                   // fell back to Gemini for good
  private failures = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private commitWaiters: (() => void)[] = [];
  private uncommittedSince = 0;             // 0 = nothing to commit
  private commitOutstanding = false;

  constructor(private apiKey: string, private cb: ScribeCallbacks) {}

  /** Whether Scribe owns teacher transcription; false means the Gemini path must take over. */
  get active(): boolean {
    return !this.stopped && !this.failed;
  }

  start() {
    if (this.stopped || this.failed || this.socket) return;
    const url = `${SCRIBE_URL}?model_id=${SCRIBE_MODEL}&audio_format=pcm_16000&commit_strategy=manual&include_language_detection=true`;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, { headers: { 'xi-api-key': this.apiKey } });
    } catch (e: any) {
      this.giveUp(`connect threw: ${e?.message ?? e}`);
      return;
    }
    this.socket = socket;
    socket.on('open', () => {
      this.cb.onDebug('info', 'ElevenLabs Scribe transcription connected');
      const queued = this.queue.splice(0, this.queue.length);
      if (queued.length) this.uncommittedSince = Date.now();
      for (const b64 of queued) this.publishAudio(b64, false);
    });
    socket.on('message', (data: Buffer) => this.onMessage(data));
    socket.on('error', (e: any) => {
      console.warn('[Poken][Scribe] socket error:', e?.message ?? e);
    });
    socket.on('close', (code: number, reason: Buffer) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.resolveCommitWaiters();
      if (this.stopped || this.failed) return;
      this.scheduleReconnect(`socket closed (code ${code}${reason?.length ? ': ' + reason.toString().slice(0, 60) : ''})`);
    });
  }

  /** Forward one browser audio frame (base64 PCM16 mono 16 kHz). */
  sendAudio(base64: string) {
    if (!this.active) return;
    if (this.socket?.readyState === WebSocket.OPEN) {
      if (!this.uncommittedSince) this.uncommittedSince = Date.now();
      this.publishAudio(base64, false);
      return;
    }
    this.queue.push(base64);
    if (this.queue.length > MAX_QUEUED_CHUNKS) this.queue.shift();
    if (!this.socket && !this.reconnectTimer) this.start();
  }

  /** End of a teacher utterance (the browser's VAD): finalize the open segment. */
  commit() {
    if (!this.active || this.socket?.readyState !== WebSocket.OPEN || !this.uncommittedSince) return;
    this.publishAudio('', true);
  }

  /** Resolves on the next committed transcript, or after `timeoutMs` — the tail of an utterance
   *  arrives with the commit, so the caller's turn handling waits briefly for it. */
  waitForCommit(timeoutMs: number): Promise<void> {
    if (!this.active || this.socket?.readyState !== WebSocket.OPEN || !this.commitOutstanding) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
      const timer = setTimeout(finish, timeoutMs);
      this.commitWaiters.push(finish);
    });
  }

  close() {
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.resolveCommitWaiters();
    const socket = this.socket;
    this.socket = null;
    try { socket?.close(); } catch (_) {}
  }

  // ── internals ────────────────────────────────────────────────────────────
  /** The API has no `commit` message type: a commit is an audio frame (possibly empty) flagged as one. */
  private publishAudio(base64: string, commit: boolean) {
    try {
      this.socket?.send(JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: base64,
        commit,
        sample_rate: 16000,
      }));
    } catch (_) {}
    if (commit) {
      this.uncommittedSince = 0;
      this.commitOutstanding = true;
    }
  }

  private onMessage(data: Buffer) {
    const event = parseScribeEvent(data.toString());
    switch (event.kind) {
      case 'started':
        this.failures = 0;
        return;
      case 'transcript':
        this.emitSegment(event.text, event.committed);
        return;
      case 'language':
        this.cb.onLanguage(event.language);
        return;
      case 'error':
        console.warn('[Poken][Scribe] error event:', event.code);
        if (event.permanent) this.giveUp(event.code);
        else this.cb.onDebug('warn', `Scribe error: ${event.code}`);
        return;
      default:
        return;
    }
  }

  /** Scribe re-sends the whole segment as it settles; emit only what is new. */
  private emitSegment(text: string, committed: boolean) {
    const delta = segmentDelta(this.emitted, text);
    if (text) this.emitted = text;
    if (delta.trim()) this.cb.onTranscript(delta);
    if (committed) {
      this.emitted = '';
      this.resolveCommitWaiters();
    }
  }

  private resolveCommitWaiters() {
    this.commitOutstanding = false;
    const waiters = this.commitWaiters.splice(0, this.commitWaiters.length);
    for (const w of waiters) w();
  }

  private scheduleReconnect(reason: string) {
    this.emitted = '';
    this.uncommittedSince = 0;
    this.failures += 1;
    if (this.failures > MAX_CONSECUTIVE_FAILURES) { this.giveUp(reason); return; }
    const delay = RECONNECT_DELAYS_MS[Math.min(this.failures - 1, RECONNECT_DELAYS_MS.length - 1)];
    this.cb.onDebug('warn', `Scribe ${reason} — reconnecting`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start();
    }, delay);
  }

  private giveUp(reason: string) {
    if (this.failed) return;
    this.failed = true;
    this.queue.length = 0;
    this.resolveCommitWaiters();
    const socket = this.socket;
    this.socket = null;
    try { socket?.close(); } catch (_) {}
    this.cb.onFallback(reason);
  }
}
