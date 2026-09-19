/**
 * Poken — Frontend: mic/camera, WebSocket, whiteboard, transcript, coaching, playback.
 */

// ── DOM refs ─────────────────────────────────────────────────────────────────
const landingScreen   = document.getElementById("landing-screen");
const setupScreen     = document.getElementById("setup-screen");
const sessionScreen   = document.getElementById("session-screen");
const reflectionScreen = document.getElementById("reflection-screen");
const getStartedBtn   = document.getElementById("getStartedBtn");
const customTopic     = document.getElementById("customTopic");
const sessionLanguageEl = document.getElementById("sessionLanguage");
const materialsEl     = document.getElementById("materials");
const useCameraEl     = document.getElementById("useCamera");
const useWhiteboardEl = document.getElementById("useWhiteboard");
const startBtn        = document.getElementById("startBtn");
const stopBtn         = document.getElementById("stopBtn");
const muteBtn         = document.getElementById("muteBtn");
const camToggleBtn    = document.getElementById("camToggleBtn");
const wbToggleBtn     = document.getElementById("wbToggleBtn");
const sessionTopicLabel = document.getElementById("sessionTopicLabel");
const sessionTimer    = document.getElementById("sessionTimer");
const statusDot       = document.getElementById("statusDot");
const statusText      = document.getElementById("statusText");
const sessionHomeBtn  = document.getElementById("sessionHomeBtn");
const orb             = document.getElementById("orb");
const orbWrap         = document.getElementById("orbWrap");
const orbLabel        = document.getElementById("orbLabel");
const speakerLabel    = document.getElementById("speakerLabel");
const orbArea         = document.getElementById("orbArea");
const orbPill         = document.getElementById("orbPill");
const orbPillDot      = document.getElementById("orbPillDot");
const orbPillLabel    = document.getElementById("orbPillLabel");
const micDot          = document.getElementById("micDot");
const micLabel        = document.getElementById("micLabel");
const chatInput       = document.getElementById("chatInput");
const chatSendBtn     = document.getElementById("chatSendBtn");
const mediaContainer  = document.getElementById("mediaContainer");
const whiteboardCanvas = document.getElementById("whiteboardCanvas");
const cameraFeed      = document.getElementById("cameraFeed");
const cameraContainer = document.getElementById("cameraContainer");
const cameraPipFeed   = document.getElementById("cameraPipFeed");
const screenContainer = document.getElementById("screenContainer");
const screenFeed      = document.getElementById("screenFeed");
const screenToggleBtn = document.getElementById("screenToggleBtn");
const wbToolbar       = document.getElementById("wbToolbar");
const wbFullscreenBtn = document.getElementById("wbFullscreenBtn");
const wbResetViewBtn  = document.getElementById("wbResetViewBtn");
const transcriptBody  = document.getElementById("transcriptBody");
const coachingBody    = document.getElementById("coachingBody");
const reflectionSummary    = document.getElementById("reflectionSummary");
const reflectionStrengths  = document.getElementById("reflectionStrengths");
const reflectionGaps       = document.getElementById("reflectionGaps");
const reflectionQuestions  = document.getElementById("reflectionQuestions");
const reflectionImprovements = document.getElementById("reflectionImprovements");
const reflectionVisualsGestures = document.getElementById("reflectionVisualsGestures");
const reflectionExplanations = document.getElementById("reflectionExplanations");
const reflectionMediaUsage  = document.getElementById("reflectionMediaUsage");
const teachAgainBtn   = document.getElementById("teachAgainBtn");
const continueTeachingBtn = document.getElementById("continueTeachingBtn");
const changeTopicBtn  = document.getElementById("changeTopicBtn");
const reflectionLoadingScreen = document.getElementById("reflection-loading-screen");
const transcriptPanel  = document.getElementById("transcriptPanel");
const coachingPanel    = document.getElementById("coachingPanel");
const resizerLeft      = document.getElementById("resizerLeft");
const resizerRight     = document.getElementById("resizerRight");
const toggleTranscriptBtn = document.getElementById("toggleTranscriptBtn");
const toggleCoachingBtn   = document.getElementById("toggleCoachingBtn");
const cameraDragHandle    = document.getElementById("cameraDragHandle");
const uploadMaterialBtn   = document.getElementById("uploadMaterialBtn");
const sessionFileInput    = document.getElementById("sessionFileInput");
const sessionToast        = document.getElementById("sessionToast");

// ── Ambient Visualizer ──────────────────────────────────────────────────────
let ambientViz = null;

class AmbientVisualizer {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext("2d");
    this.rafId = null;
    this.waves = [];
    this.time = 0;
  }

  initWaves() {
    this.waves = [
      { amplitude: 45, frequency: 0.008, speed: 0.015, phase: 0,   opacity: 0.18, yOffset: 0.30 },
      { amplitude: 55, frequency: 0.006, speed: 0.012, phase: 1.2, opacity: 0.14, yOffset: 0.42 },
      { amplitude: 35, frequency: 0.010, speed: 0.018, phase: 2.5, opacity: 0.12, yOffset: 0.55 },
      { amplitude: 50, frequency: 0.007, speed: 0.010, phase: 3.8, opacity: 0.16, yOffset: 0.68 },
      { amplitude: 30, frequency: 0.012, speed: 0.014, phase: 5.0, opacity: 0.10, yOffset: 0.80 },
    ];
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = rect.width;
    this.h = rect.height;
  }

  draw() {
    this.ctx.clearRect(0, 0, this.w, this.h);
    const breathe = 1 + Math.sin(this.time * 0.002) * 0.15;

    for (const wave of this.waves) {
      this.ctx.beginPath();
      this.ctx.strokeStyle = `rgba(255, 115, 85, ${wave.opacity})`;
      this.ctx.lineWidth = 2;
      const baseY = this.h * wave.yOffset;
      const amp = wave.amplitude * breathe;

      for (let x = 0; x <= this.w; x += 4) {
        const y = baseY
          + Math.sin(x * wave.frequency + this.time * wave.speed + wave.phase) * amp
          + Math.sin(x * wave.frequency * 0.5 + this.time * wave.speed * 1.3) * amp * 0.3;
        if (x === 0) this.ctx.moveTo(x, y);
        else this.ctx.lineTo(x, y);
      }
      this.ctx.stroke();
    }

    this.time++;
    this.rafId = requestAnimationFrame(() => this.draw());
  }

  start() {
    this.initWaves();
    this.time = 0;
    this.resize();
    this.draw();
    this._resizeHandler = () => this.resize();
    window.addEventListener("resize", this._resizeHandler);
  }

  stop() {
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    if (this._resizeHandler) { window.removeEventListener("resize", this._resizeHandler); this._resizeHandler = null; }
  }
}

const ORB_STATES = {
  idle:      { color: "#9CA3AF", glow: "rgba(156,163,175,0.4)", speed: "3.5s",  rings: false, label: "" },
  listening: { color: "#93C5FD", glow: "rgba(147,197,253,0.45)", speed: "2.2s",  rings: false, label: "Listening\u2026" },
  thinking:  { color: "#C4B5FD", glow: "rgba(196,181,253,0.5)",  speed: "2.6s",  rings: false, label: "Thinking\u2026" },
  speaking:  { color: "#FF7355", glow: "rgba(255,115,85,0.5)",   speed: "0.85s", rings: true,  label: "Speaking\u2026" },
  curious:   { color: "#FBBF24", glow: "rgba(251,191,36,0.45)",  speed: "1.6s",  rings: false, label: "Curious!" },
  confused:  { color: "#FDA4AF", glow: "rgba(253,164,175,0.45)", speed: "2.9s",  rings: false, label: "Hmm\u2026" },
  excited:   { color: "#FF7355", glow: "rgba(255,115,85,0.65)",  speed: "0.65s", rings: true,  label: "Excited!" },
};

const SERVER_EMOTION_STATES = new Set(["curious", "confused", "excited", "listening", "thinking"]);

// ── State ────────────────────────────────────────────────────────────────────
let selectedPersona  = "eager";

let ws               = null;
let lastError        = null;
let micStream        = null;
let micContext       = null;
let micProcessor     = null;
let micMuted         = false;
let cameraStream     = null;
let cameraEnabled    = false;
let screenStream     = null;
let screenEnabled    = false;
let whiteboardEnabled = false;
let whiteboardInited = false;
let sessionReady     = false;
let playbackContext  = null;
let playbackGainNode = null;
let nextPlayTime     = 0;
let activeSources    = [];    // track AudioBufferSourceNodes for interruption
let suppressAudio    = false; // suppress student audio when teacher is interrupting
let lastAudioChunkAt = 0;    // timestamp of last queued audio chunk (echo guard grace period)
let micStartedAt     = 0;    // timestamp when mic started (VAD warm-up grace period)
let audioChunksReceived = 0;
let currentOrbState  = "idle";
let awaitingReflection = false;

// ── Session handover / resume ────────────────────────────────────────────────
// Vercel closes the WebSocket at the function deadline (300s on Hobby). The
// server issues a resume token after every teacher turn; on handover or any
// unexpected close we reconnect with it and the students pick the lesson back
// up. Outgoing frames are queued while the replacement socket connects.
let resumeToken        = null;
let materialsContext   = "";   // server-analyzed materials, handed back on resume so vision never re-runs
let handoverInProgress = false;
let handoverQueue      = [];
let resumeFailures     = 0;
let resumeRetryTimer   = null;
let oldWs              = null; // socket being replaced; kept open until the new one is ready
const HANDOVER_QUEUE_MAX  = 400; // ≈50s of speech at 128ms chunks
const RESUME_MAX_FAILURES = 3;
const STORED_SESSION_KEY  = "poken_session";
const STORED_SESSION_TTL_MS = 15 * 60 * 1000;

/** Send to the live socket, or queue it during a handover. */
function wsSend(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send(payload); } catch (_) {} return; }
  if (handoverInProgress) {
    handoverQueue.push(payload);
    if (handoverQueue.length > HANDOVER_QUEUE_MAX) handoverQueue.shift();
  }
}

function storeSessionForResume() {
  if (!resumeToken) return;
  try {
    sessionStorage.setItem(STORED_SESSION_KEY, JSON.stringify({
      token: resumeToken,
      materialsContext,
      settings: { topic: sessionTopic, language: sessionLanguage, persona: selectedPersona, materials: sessionMaterials },
      savedAt: Date.now(),
    }));
  } catch (_) {}
}

function loadStoredSession() {
  try {
    const raw = sessionStorage.getItem(STORED_SESSION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !data.token || Date.now() - (data.savedAt || 0) > STORED_SESSION_TTL_MS) return null;
    return data;
  } catch (_) { return null; }
}

function clearStoredSession() {
  try { sessionStorage.removeItem(STORED_SESSION_KEY); } catch (_) {}
}

// ── Debug event log (persists across screen transitions) ────────────────────
const debugEvents = [];
function debugLog(level, message) {
  debugEvents.push({ ts: Date.now(), level, message });
  // Cap at 200 entries
  if (debugEvents.length > 200) debugEvents.splice(0, debugEvents.length - 200);
}
function renderDebugPanel() {
  const panel = document.getElementById("debugPanel");
  const body = document.getElementById("debugPanelBody");
  if (!panel || !body) return;
  const hasErrors = debugEvents.some(e => e.level === "error");
  if (!hasErrors || debugEvents.length === 0) {
    panel.style.display = "none";
    return;
  }
  body.innerHTML = "";
  for (const ev of debugEvents) {
    const d = new Date(ev.ts);
    const ts = d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const ms = String(d.getMilliseconds()).padStart(3, "0");
    const line = document.createElement("div");
    line.className = "debug-line debug-" + ev.level;
    line.innerHTML = `<span class="debug-ts">${ts}.${ms}</span> ${escapeHtml(ev.message)}`;
    body.appendChild(line);
  }
  panel.style.display = "flex";
  body.scrollTop = body.scrollHeight;
}
function clearDebugPanel() {
  const panel = document.getElementById("debugPanel");
  if (panel) panel.style.display = "none";
}
function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// Audio config
const SEND_SAMPLE_RATE        = 16000;
const RECV_SAMPLE_RATE        = 24000;
const BUFFER_SIZE             = 2048;
const SILENCE_BUFFERS_BEFORE_END = 18;
const SPEECH_ENERGY_THRESHOLD = 0.006;
// When student audio is playing through speakers, the mic picks up echo.
// Use a higher threshold during playback so only real teacher speech triggers VAD,
// not speaker echo. This prevents both false interruptions and hallucinated teacher turns.
const ECHO_GUARD_MULTIPLIER   = 5; // 0.006 * 5 = 0.03 (echo ~0.01-0.02, real speech ~0.05+)

let vadInSpeech     = false;
let vadSilenceCount = 0;

// Whiteboard
let currentTool  = "pen";
let currentColor = "#000000";
let canvasDirty  = false;
let wbDrawing    = false;
let wbLastX = 0, wbLastY = 0;
let wbPenSize    = 3;
let wbEraserSize = 30;
let wbZoom       = 1;
let wbPanX       = 0;
let wbPanY       = 0;
let wbIsPanning  = false;
let wbPanClientStartX = 0;
let wbPanClientStartY = 0;
let wbPanOriginX = 0;
let wbPanOriginY = 0;
let wbEventsBound = false;

// Fullscreen and overlays
let wbCssFullscreen = false;

// Camera floating PiP
let cameraDragging = false;
let cameraDragStartX = 0;
let cameraDragStartY = 0;
let cameraStartLeft = 0;
let cameraStartTop = 0;
let cameraFloatLeft = 0;
let cameraFloatTop = 0;

// Frame sending
let frameInterval   = null;
let lastSpeechFrameTime = 0;
let lastSilentFrameTime = 0;
const SILENT_FRAME_INTERVAL_MS = 8000; // send one camera frame every 8s when silent (for visual context without triggering hallucination)
const FRAME_SPEECH_WINDOW_MS = 4000;
const compositeCanvas = document.createElement("canvas");
compositeCanvas.width = 1280;
compositeCanvas.height = 720;

// Diagram frame streaming (annotations → AI vision)
let diagramFrameInterval = null;
let diagramPopupOpen = false;
let lastDiagramDrawTime = 0;
const DIAGRAM_FRAME_INTERVAL_MS = 2000;
const DIAGRAM_DRAW_WINDOW_MS = 4000;

// Transcript
let transcriptEntryId = 0;
let currentTeacherEntry = null;
let currentStudentEntry = null;
let lastTeacherFinalizedAt = 0;
let lastStudentFinalizedAt = 0;
const STALE_CHUNK_WINDOW_MS = 600;
const liveCleanupTimers = new Map();
const liveCleanupInFlight = new Map();
const LIVE_CLEANUP_DEBOUNCE_MS = 250;
const transcriptContextHistory = [];
const MAX_TRANSCRIPT_CONTEXT_ITEMS = 10;

// Session state
let sessionTopic     = "";
let sessionLanguage  = "English";
let sessionMaterials = "";
let sessionStartTime = 0;
let sessionDuration  = 0;
let timerInterval    = null;

// Idle timeout: 60s no activity (voice, click, keypress, upload) → modal, then 30s countdown → end session
const IDLE_WARN_MS      = 60 * 1000;
const IDLE_CHECK_MS     = 5000;
const IDLE_COUNTDOWN_SEC = 30;
let lastActivityTimestamp = 0;
let idleCheckInterval   = null;
let idleCountdownInterval = null;
let idleCountdownSec = IDLE_COUNTDOWN_SEC;

// File uploads
const fileDropZone = document.getElementById("fileDropZone");
const fileInput    = document.getElementById("fileInput");
let uploadedFiles  = []; // { name, mimeType, base64, size }

// Panel resizing and toggles
const TRANSCRIPT_DEFAULT_WIDTH = 300;
const COACHING_DEFAULT_WIDTH   = 260;
const MIN_PANEL_WIDTH = 120;
const MAX_PANEL_WIDTH = 480;
let transcriptPanelWidth = TRANSCRIPT_DEFAULT_WIDTH;
let coachingPanelWidth   = COACHING_DEFAULT_WIDTH;
let transcriptCollapsed  = false;
let coachingCollapsed   = false;
let resizingLeft = false, resizingRight = false;

// Firebase
let db = null;

// ── Startup tone & sounds ────────────────────────────────────────────────────
let _audioCtx = null;
let _startupPlayed = false;

function getAudioCtx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return _audioCtx;
}

function playStartupTone() {
  if (_startupPlayed) return;
  const ctx = getAudioCtx();
  const run = () => {
    if (_startupPlayed) return;
    if (ctx.state !== "running") return;
    _startupPlayed = true;
    const dur = 1.7, freq = 196, t = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.38, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    g.connect(ctx.destination);
    [1, 1.006, 2.48].forEach((mult, i) => {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(freq * mult, t);
      if (i < 2) {
        o.frequency.linearRampToValueAtTime(freq * mult * 1.02, t + dur * 0.5);
        o.connect(g);
      } else {
        const g3 = ctx.createGain();
        g3.gain.setValueAtTime(0.22, t);
        g3.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.6);
        o.connect(g3); g3.connect(g);
      }
      o.start(t); o.stop(t + dur);
    });
  };
  if (ctx.state === "suspended") ctx.resume().then(run); else run();
}

function playButtonSound(type) {
  try {
    const ctx = getAudioCtx();
    if (ctx.state === "suspended") return;
    const t = ctx.currentTime;
    const g = ctx.createGain();
    g.connect(ctx.destination);
    if (type === "confirm") {
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.2, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
      [320, 324].forEach(f => {
        const o = ctx.createOscillator(); o.type = "sine";
        o.frequency.setValueAtTime(f, t);
        o.frequency.linearRampToValueAtTime(f + 80, t + 0.12);
        o.connect(g); o.start(t); o.stop(t + 0.28);
      });
    } else {
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.15, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
      const o = ctx.createOscillator(); o.type = "sine";
      o.frequency.setValueAtTime(220, t);
      o.frequency.exponentialRampToValueAtTime(180, t + 0.22);
      o.connect(g); o.start(t); o.stop(t + 0.22);
    }
  } catch (_) {}
}

["click", "touchstart", "keydown"].forEach(ev => {
  document.addEventListener(ev, () => { if (!_startupPlayed) playStartupTone(); }, { once: true, capture: true });
});

// ── Setup hardware (camera preview + mic level) ───────────────────────────────
let setupPreviewStream = null;
let setupMicContext = null;
let setupMicAnimationId = null;
let proTipInterval = null;

function stopSetupHardware() {
  if (setupMicAnimationId) {
    cancelAnimationFrame(setupMicAnimationId);
    setupMicAnimationId = null;
  }
  if (setupMicContext) {
    setupMicContext.close().catch(() => {});
    setupMicContext = null;
  }
  if (setupPreviewStream) {
    setupPreviewStream.getTracks().forEach(t => t.stop());
    setupPreviewStream = null;
  }
  const previewEl = document.getElementById("setupPreviewVideo");
  if (previewEl) {
    previewEl.innerHTML = '<span style="font-size:0.75rem;color:var(--poken-text-secondary);">Camera preview</span>';
  }
  const barEl = document.getElementById("setupMicBar");
  if (barEl) {
    barEl.style.width = "";
    barEl.style.animation = "";
  }
  if (proTipInterval) {
    clearInterval(proTipInterval);
    proTipInterval = null;
  }
}

async function startSetupHardware() {
  stopSetupHardware();
  const previewEl = document.getElementById("setupPreviewVideo");
  const barEl = document.getElementById("setupMicBar");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    setupPreviewStream = stream;
    if (previewEl) {
      previewEl.innerHTML = "";
      const video = document.createElement("video");
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      video.style.width = "100%";
      video.style.height = "100%";
      video.style.objectFit = "cover";
      video.style.transform = "scaleX(-1)";
      previewEl.appendChild(video);
    }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    setupMicContext = ctx;
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    src.connect(analyser);
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    function tick() {
      setupMicAnimationId = requestAnimationFrame(tick);
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const avg = sum / dataArray.length;
      const pct = Math.min(100, (avg / 128) * 100);
      if (barEl) {
        barEl.style.width = pct + "%";
        barEl.style.animation = "none";
      }
    }
    tick();
  } catch (e) {
    console.warn("[Poken] Setup hardware:", e);
    if (previewEl) previewEl.innerHTML = '<span style="font-size:0.75rem;color:var(--poken-text-secondary);">Camera unavailable</span>';
  }
}

// ── Landing → Setup ──────────────────────────────────────────────────────────
getStartedBtn.addEventListener("click", () => {
  playButtonSound("confirm");
  landingScreen.classList.add("fade-out");
  setTimeout(() => {
    landingScreen.style.display = "none";
    landingScreen.classList.remove("fade-out");
    setupScreen.style.display = "block";
    setupScreen.classList.add("fade-in");
    setTimeout(() => setupScreen.classList.remove("fade-in"), 300);
    if (!ambientViz) ambientViz = new AmbientVisualizer("ambientCanvas");
    ambientViz.start();
    startSetupHardware();
    setProTip();
    proTipInterval = setInterval(setProTip, 10000);
    updateStartButton();
    updateResumeButton();
  }, 280);
});

// ── Persona selection ────────────────────────────────────────────────────────
document.querySelectorAll(".persona-card").forEach(card => {
  card.addEventListener("click", () => {
    document.querySelectorAll(".persona-card").forEach(c => c.classList.remove("selected"));
    card.classList.add("selected");
    selectedPersona = card.dataset.persona;
  });
});

if (customTopic) {
  customTopic.addEventListener("input", updateStartButton);
  customTopic.addEventListener("change", updateStartButton);
}

function updateStartButton() {
  const hasTopic = customTopic && customTopic.value.trim().length > 0;
  if (!hasTopic) {
    startBtn.disabled = true;
    startBtn.textContent = "Enter a topic";
    return;
  }
  startBtn.disabled = false;
  startBtn.textContent = "Start teaching";
}


function getSelectedTopic() {
  return customTopic.value.trim() || "the topic";
}

function getSessionLanguage() {
  const value = sessionLanguageEl?.value?.trim();
  return value || "English";
}

// ── File upload handling ──────────────────────────────────────────────────────
const ACCEPTED_TYPES = new Set([
  "application/pdf",
  "image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp",
  "text/plain", "text/markdown", "text/csv",
  "video/mp4", "video/quicktime", "video/webm", "video/x-msvideo", "video/mpeg",
]);
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB (increased for video support)

function getFileIcon(mimeType) {
  if (mimeType === "application/pdf") return "\u{1F4C4}";
  if (mimeType.startsWith("image/"))  return "\u{1F5BC}";
  if (mimeType.startsWith("video/"))  return "\u{1F3AC}";
  return "\u{1F4DD}";
}

function formatFileSize(bytes) {
  if (bytes < 1024)           return bytes + " B";
  if (bytes < 1024 * 1024)    return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function renderFileList() {
  const zone = fileDropZone;
  const existing = zone.querySelector(".file-list");
  if (existing) existing.remove();
  const existingIcon  = zone.querySelector(".file-drop-icon");
  const existingLabel = zone.querySelector(".file-drop-label");
  const existingAdd   = zone.querySelector(".file-drop-add-more");
  if (existingAdd) existingAdd.remove();

  if (uploadedFiles.length === 0) {
    zone.classList.remove("has-files");
    if (existingIcon)  existingIcon.style.display = "";
    if (existingLabel) existingLabel.style.display = "";
    return;
  }

  zone.classList.add("has-files");
  if (existingIcon)  existingIcon.style.display = "none";
  if (existingLabel) existingLabel.style.display = "none";

  const list = document.createElement("div");
  list.className = "file-list";

  uploadedFiles.forEach((file, idx) => {
    const item = document.createElement("div");
    item.className = "file-item";
    item.innerHTML = `
      <span class="file-item-icon">${getFileIcon(file.mimeType)}</span>
      <span class="file-item-name">${escapeHtml(file.name)}</span>
      <span class="file-item-size">${formatFileSize(file.size)}</span>
    `;
    const removeBtn = document.createElement("button");
    removeBtn.className = "file-item-remove";
    removeBtn.textContent = "\u2715";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      uploadedFiles.splice(idx, 1);
      renderFileList();
    });
    item.appendChild(removeBtn);
    list.appendChild(item);
  });

  zone.appendChild(list);

  const addMore = document.createElement("button");
  addMore.className = "file-drop-add-more";
  addMore.textContent = "+ Add more files";
  addMore.addEventListener("click", (e) => { e.stopPropagation(); fileInput.click(); });
  zone.appendChild(addMore);
}

async function processFiles(files) {
  for (const file of files) {
    // Determine mime type (handle common extensions for unknown types)
    let mimeType = file.type;
    if (!mimeType) {
      const ext = file.name.split(".").pop().toLowerCase();
      if (ext === "md") mimeType = "text/markdown";
      else if (ext === "txt") mimeType = "text/plain";
      else if (ext === "csv") mimeType = "text/csv";
      else if (ext === "pdf") mimeType = "application/pdf";
      else if (ext === "jpg" || ext === "jpeg") mimeType = "image/jpeg";
      else if (ext === "png") mimeType = "image/png";
      else if (ext === "gif") mimeType = "image/gif";
      else if (ext === "webp") mimeType = "image/webp";
      else if (ext === "mp4") mimeType = "video/mp4";
      else if (ext === "mov") mimeType = "video/quicktime";
      else if (ext === "webm") mimeType = "video/webm";
      else if (ext === "avi") mimeType = "video/x-msvideo";
    }

    if (!ACCEPTED_TYPES.has(mimeType)) {
      // Try to handle docx/doc as text extraction
      if (file.name.match(/\.(doc|docx)$/i)) {
        // Read as text best-effort
        try {
          const text = await file.text();
          uploadedFiles.push({ name: file.name, mimeType: "text/plain", base64: btoa(unescape(encodeURIComponent(text))), size: file.size });
        } catch (_) {}
        continue;
      }
      continue; // Skip unsupported types
    }

    if (file.size > MAX_FILE_SIZE) continue;

    // Prevent duplicates
    if (uploadedFiles.some(f => f.name === file.name && f.size === file.size)) continue;

    const base64 = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.readAsDataURL(file);
    });

    uploadedFiles.push({ name: file.name, mimeType, base64, size: file.size });
  }
  renderFileList();
}

// Drop zone events
fileDropZone.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
  if (fileInput.files.length) processFiles(Array.from(fileInput.files));
  fileInput.value = ""; // Reset so same file can be re-added
});

fileDropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.stopPropagation();
  fileDropZone.classList.add("drag-over");
});

fileDropZone.addEventListener("dragleave", (e) => {
  e.preventDefault();
  e.stopPropagation();
  fileDropZone.classList.remove("drag-over");
});

fileDropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  e.stopPropagation();
  fileDropZone.classList.remove("drag-over");
  if (e.dataTransfer.files.length) processFiles(Array.from(e.dataTransfer.files));
});

// ── Orb state machine ────────────────────────────────────────────────────────
function applyOrbColor(color, glow) {
  orb.style.setProperty("--orb-color", color);
  orb.style.setProperty("--orb-glow",  glow);
  orbWrap.style.setProperty("--orb-color", color);
  orbPillDot.style.setProperty("--orb-color", color);
  orbPillDot.style.setProperty("--orb-glow",  glow);
}

function setOrbState(name) {
  if (name === currentOrbState) return;
  currentOrbState = name;
  const s = ORB_STATES[name] || ORB_STATES.idle;
  applyOrbColor(s.color, s.glow);
  orb.style.setProperty("--orb-speed", s.speed);
  orbPillDot.style.setProperty("--orb-speed", s.speed);
  orb.style.animation = "none"; void orb.offsetWidth; orb.style.animation = "";
  orbWrap.classList.toggle("rings-on", s.rings);
  orbLabel.textContent = s.label;
  orbPillLabel.textContent = s.label;
}

// ── Mic & status ─────────────────────────────────────────────────────────────
function setMicActive(active) {
  micDot.classList.toggle("active", active);
  micLabel.classList.toggle("active", active);
  micLabel.textContent = active ? "mic on" : "mic off";
}

function setStatus(msg, type) {
  statusText.textContent = msg;
  statusDot.className = "status-dot" + (type === "connected" ? " connected" : type === "error" ? " error" : "");
}

// ── PCM helpers ──────────────────────────────────────────────────────────────
function float32ToPcm16(f32) {
  const pcm = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcm.buffer;
}

function pcm16ToFloat32(pcm16) {
  const f32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) f32[i] = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7fff);
  return f32;
}

// ── Audio playback ───────────────────────────────────────────────────────────
async function playPcm24k(arrayBuffer) {
  if (!arrayBuffer || arrayBuffer.byteLength === 0) return;
  if (awaitingReflection) return;
  if (suppressAudio) return; // teacher is interrupting — discard incoming student audio
  try {
    audioChunksReceived++;
    if (audioChunksReceived === 1) setOrbState("speaking");
    if (!playbackContext) playbackContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: RECV_SAMPLE_RATE });
    if (playbackContext.state === "suspended") await playbackContext.resume();

    const pcm16 = new Int16Array(arrayBuffer);
    const f32 = pcm16ToFloat32(pcm16);
    const buf = playbackContext.createBuffer(1, f32.length, RECV_SAMPLE_RATE);
    buf.getChannelData(0).set(f32);

    const src = playbackContext.createBufferSource();
    src.buffer = buf;
    if (!playbackGainNode) {
      playbackGainNode = playbackContext.createGain();
      playbackGainNode.gain.value = 2.5;
      playbackGainNode.connect(playbackContext.destination);
    }
    src.connect(playbackGainNode);
    const now = playbackContext.currentTime;
    if (nextPlayTime < now) nextPlayTime = now + 0.08; // 80ms jitter buffer to prevent audio pops from chunk gaps
    src.start(nextPlayTime);
    nextPlayTime += buf.duration;
    // Track source for interruption
    activeSources.push(src);
    lastAudioChunkAt = Date.now();
    src.onended = () => {
      const idx = activeSources.indexOf(src);
      if (idx !== -1) activeSources.splice(idx, 1);
    };
  } catch (err) { console.error("playPcm24k:", err); }
}

/** Immediately stop all queued audio playback (for teacher interruption) */
function interruptPlayback() {
  for (const src of activeSources) {
    try { src.stop(); } catch (_) {}
  }
  activeSources = [];
  nextPlayTime = 0;
  audioChunksReceived = 0;
  lastAudioChunkAt = 0; // genuine interruption — clear grace period
}

function stopPlayback() {
  for (const src of activeSources) { try { src.stop(); } catch (_) {} }
  activeSources = [];
  playbackGainNode = null;
  if (playbackContext) { try { playbackContext.close(); } catch (_) {} playbackContext = null; }
  nextPlayTime = 0;
  suppressAudio = false;
}

// ── Transcript management ────────────────────────────────────────────────────
function addTranscriptEntry(speaker, type) {
  const id = ++transcriptEntryId;
  const div = document.createElement("div");
  div.className = "t-entry";

  const sp = document.createElement("div");
  sp.className = `t-speaker ${type}`;
  sp.textContent = speaker;

  const txt = document.createElement("div");
  txt.className = "t-text";

  div.appendChild(sp);
  div.appendChild(txt);
  transcriptBody.appendChild(div);
  transcriptBody.scrollTop = transcriptBody.scrollHeight;

  return { id, el: div, textEl: txt, rawText: "", speaker, type };
}

function rememberTranscriptContext(speaker, text) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return;
  transcriptContextHistory.push({ speaker: speaker || "Speaker", text: clean });
  if (transcriptContextHistory.length > MAX_TRANSCRIPT_CONTEXT_ITEMS) {
    transcriptContextHistory.splice(0, transcriptContextHistory.length - MAX_TRANSCRIPT_CONTEXT_ITEMS);
  }
}

function buildTranscriptContext(currentEntry) {
  const items = transcriptContextHistory.slice(-6).map(item => `${item.speaker}: ${item.text}`);
  if (currentEntry && currentEntry.speaker && currentEntry.rawText) {
    items.push(`${currentEntry.speaker}: ${currentEntry.rawText.replace(/\s+/g, " ").trim()}`);
  }
  return items.join("\n");
}

function appendToEntry(entry, chunk, options) {
  if (!entry) return;
  const live = options && options.live !== false;
  const predict = options && options.predict === true;
  entry.rawText += chunk;
  entry.textEl.textContent = live ? entry.rawText : "\u2026";
  if (predict && live) scheduleLiveCleanup(entry);
  transcriptBody.scrollTop = transcriptBody.scrollHeight;
}

function scheduleLiveCleanup(entry) {
  if (!entry || !entry.rawText.trim()) return;
  const prev = liveCleanupTimers.get(entry.id);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    liveCleanupTimers.delete(entry.id);
    refineLiveTranscript(entry).catch(() => {});
  }, LIVE_CLEANUP_DEBOUNCE_MS);
  liveCleanupTimers.set(entry.id, timer);
}

async function refineLiveTranscript(entry) {
  if (!entry || !entry.rawText.trim()) return;
  if (liveCleanupInFlight.get(entry.id)) return;
  liveCleanupInFlight.set(entry.id, true);
  const sourceText = entry.rawText;
  try {
    const res = await fetch("/api/cleanup-transcript", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: sourceText,
        topic: sessionTopic,
        language: sessionLanguage,
        mode: "live",
        speaker: entry.speaker || "Speaker",
        context: buildTranscriptContext(),
      }),
    });
    const { cleaned } = await res.json();
    if (!cleaned || !cleaned.trim()) return;
    // If newer chunks arrived, preserve the newer suffix while applying corrected prefix.
    if (entry.rawText !== sourceText) {
      const latest = entry.rawText;
      const suffix = latest.startsWith(sourceText) ? latest.slice(sourceText.length) : "";
      entry.rawText = `${cleaned}${suffix}`;
      entry.textEl.textContent = entry.rawText;
      scheduleLiveCleanup(entry);
      return;
    }
    entry.rawText = cleaned;
    entry.textEl.textContent = cleaned;
  } catch (_) {
    // Ignore transient cleanup failures during streaming.
  } finally {
    liveCleanupInFlight.delete(entry.id);
  }
}

async function cleanupEntry(entry, showCleaningState = true) {
  if (!entry || !entry.rawText.trim()) return;
  const t = liveCleanupTimers.get(entry.id);
  if (t) {
    clearTimeout(t);
    liveCleanupTimers.delete(entry.id);
  }
  if (showCleaningState) entry.textEl.classList.add("cleaning");
  try {
    const res = await fetch("/api/cleanup-transcript", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: entry.rawText,
        topic: sessionTopic,
        language: sessionLanguage,
        mode: "final",
        speaker: entry.speaker || "Speaker",
        context: buildTranscriptContext(entry),
        materials: (sessionMaterials || "").substring(0, 2000),
      }),
    });
    const { cleaned } = await res.json();
    const text = (cleaned && cleaned.trim()) ? cleaned : entry.rawText;
    entry.rawText = text;
    entry.textEl.textContent = text;
    rememberTranscriptContext(entry.speaker, text);
  } catch (_) {
    entry.textEl.textContent = entry.rawText;
    rememberTranscriptContext(entry.speaker, entry.rawText);
  } finally {
    entry.textEl.classList.remove("cleaning");
  }
}

// ── Coaching tips ────────────────────────────────────────────────────────────
let coachingFadeTimer = null;
const MAX_COACHING_TIPS = 6;

function addCoachingTip(tipText) {
  // Remove empty placeholder
  const empty = coachingBody.querySelector(".coaching-empty");
  if (empty) empty.remove();

  // Fade all existing tips to "old" state
  if (coachingFadeTimer) { clearTimeout(coachingFadeTimer); coachingFadeTimer = null; }
  coachingBody.querySelectorAll(".coaching-tip.active").forEach(el => {
    el.classList.remove("active");
    el.classList.add("past");
  });

  // Add new tip as active
  const div = document.createElement("div");
  div.className = "coaching-tip active";
  div.innerHTML = tipText.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
  coachingBody.appendChild(div);
  coachingBody.scrollTop = coachingBody.scrollHeight;

  // After 15s, fade the current tip to past
  coachingFadeTimer = setTimeout(() => {
    div.classList.remove("active");
    div.classList.add("past");
    coachingFadeTimer = null;
  }, 15_000);

  // Remove oldest tips if over limit
  while (coachingBody.querySelectorAll(".coaching-tip").length > MAX_COACHING_TIPS) {
    const oldest = coachingBody.querySelector(".coaching-tip");
    if (oldest) oldest.remove();
  }
}

// ── Whiteboard ───────────────────────────────────────────────────────────────
function initWhiteboard() {
  if (whiteboardInited) return;
  whiteboardInited = true;
  const ctx = whiteboardCanvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, whiteboardCanvas.width, whiteboardCanvas.height);
  applyWbTransform();
  setupWhiteboardEvents();
}

function setupWhiteboardEvents() {
  if (wbEventsBound) return;
  wbEventsBound = true;
  const canvas = whiteboardCanvas;
  const container = canvas.parentElement;
  if (!canvas || !container) return;

  function getClientPoint(e) {
    const touch = e.touches?.[0] || e.changedTouches?.[0];
    return {
      x: touch ? touch.clientX : e.clientX,
      y: touch ? touch.clientY : e.clientY,
    };
  }

  function getPosFromClient(clientX, clientY) {
    const rect = container.getBoundingClientRect();
    const baseScaleX = canvas.width / rect.width;
    const baseScaleY = canvas.height / rect.height;
    const localX = (clientX - rect.left - wbPanX) / wbZoom;
    const localY = (clientY - rect.top - wbPanY) / wbZoom;
    return { x: localX * baseScaleX, y: localY * baseScaleY };
  }

  function getPos(e) {
    const point = getClientPoint(e);
    return getPosFromClient(point.x, point.y);
  }

  function startPan(clientX, clientY) {
    if (!whiteboardEnabled) return;
    if (!wbIsPanning) {
      wbIsPanning = true;
      wbPanClientStartX = clientX;
      wbPanClientStartY = clientY;
      wbPanOriginX = wbPanX;
      wbPanOriginY = wbPanY;
      canvas.style.cursor = "grabbing";
    }
  }

  function onStart(e) {
    if (!whiteboardEnabled) return;
    const point = getClientPoint(e);
    const isRightMouse = e.type === "mousedown" && e.button === 2;
    const isPanTool = currentTool === "pan" && (e.type === "touchstart" || e.button === 0);

    if (isRightMouse || isPanTool) {
      e.preventDefault();
      startPan(point.x, point.y);
      return;
    }

    if (e.type === "mousedown" && e.button !== 0) return;

    if (currentTool === "text") {
      e.preventDefault();
      const pos = getPos(e);
      const text = prompt("Enter text:");
      if (text) {
        const ctx = canvas.getContext("2d");
        ctx.font = "bold 24px Inter, system-ui, sans-serif";
        ctx.fillStyle = currentColor;
        ctx.fillText(text, pos.x, pos.y);
        canvasDirty = true;
      }
      return;
    }

    e.preventDefault();
    wbDrawing = true;
    const pos = getPos(e);
    wbLastX = pos.x; wbLastY = pos.y;
  }

  function onMove(e) {
    if (!whiteboardEnabled) return;
    if (wbIsPanning) {
      e.preventDefault();
      const point = getClientPoint(e);
      wbPanX = wbPanOriginX + (point.x - wbPanClientStartX);
      wbPanY = wbPanOriginY + (point.y - wbPanClientStartY);
      applyWbTransform();
      return;
    }
    if (!wbDrawing) return;
    e.preventDefault();
    const pos = getPos(e);
    const ctx = canvas.getContext("2d");
    ctx.lineWidth = currentTool === "eraser" ? wbEraserSize : wbPenSize;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = currentTool === "eraser" ? "#ffffff" : currentColor;
    ctx.beginPath();
    ctx.moveTo(wbLastX, wbLastY);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    wbLastX = pos.x; wbLastY = pos.y;
    canvasDirty = true;
  }

  function onEnd() {
    wbDrawing = false;
    if (wbIsPanning) {
      wbIsPanning = false;
      canvas.style.cursor = currentTool === "pan" ? "grab" : "crosshair";
    }
  }

  canvas.addEventListener("mousedown", onStart);
  canvas.addEventListener("mousemove", onMove);
  canvas.addEventListener("mouseup", onEnd);
  canvas.addEventListener("mouseleave", onEnd);
  canvas.addEventListener("contextmenu", (e) => {
    if (whiteboardEnabled) e.preventDefault();
  });
  document.addEventListener("mouseup", onEnd);
  canvas.addEventListener("touchstart", onStart, { passive: false });
  canvas.addEventListener("touchmove", onMove, { passive: false });
  canvas.addEventListener("touchend", onEnd);

  // Zoom with wheel, anchored at pointer position.
  container.addEventListener("wheel", (e) => {
    if (!whiteboardEnabled) return;
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    const logicalX = (localX - wbPanX) / wbZoom;
    const logicalY = (localY - wbPanY) / wbZoom;
    const scaleDelta = e.deltaY > 0 ? 0.92 : 1.08;
    wbZoom = Math.max(0.25, Math.min(5, wbZoom * scaleDelta));
    wbPanX = localX - logicalX * wbZoom;
    wbPanY = localY - logicalY * wbZoom;
    applyWbTransform();
  }, { passive: false });
}

function applyWbTransform() {
  if (!whiteboardCanvas) return;
  whiteboardCanvas.style.transformOrigin = "0 0";
  whiteboardCanvas.style.transform = `translate(${wbPanX}px, ${wbPanY}px) scale(${wbZoom})`;
}

function resetWhiteboardView() {
  wbZoom = 1;
  wbPanX = 0;
  wbPanY = 0;
  applyWbTransform();
}

function clearWhiteboard() {
  const ctx = whiteboardCanvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, whiteboardCanvas.width, whiteboardCanvas.height);
  canvasDirty = true;
}

// Whiteboard toolbar events
function updateWbSizeSliders() {
  const isPen = currentTool === "pen";
  const isEraser = currentTool === "eraser";
  const penWrap = document.getElementById("wbPenSizeWrap");
  const eraserWrap = document.getElementById("wbEraserSizeWrap");
  const sep = document.getElementById("wbSizeSep");
  if (penWrap) penWrap.classList.toggle("visible", isPen);
  if (eraserWrap) eraserWrap.classList.toggle("visible", isEraser);
  if (sep) sep.style.display = (isPen || isEraser) ? "" : "none";
  // Update cursor for pan tool
  if (whiteboardCanvas) {
    whiteboardCanvas.style.cursor = currentTool === "pan" ? "grab" : "crosshair";
  }
}

document.querySelectorAll(".wb-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const tool = btn.dataset.tool;
    if (!tool) return;
    if (tool === "clear") { clearWhiteboard(); return; }
    currentTool = tool;
    document.querySelectorAll(".wb-btn").forEach(b => b.classList.toggle("active", b.dataset.tool === tool));
    updateWbSizeSliders();
  });
});

document.querySelectorAll(".wb-color").forEach(swatch => {
  swatch.addEventListener("click", () => {
    currentColor = swatch.dataset.color;
    document.querySelectorAll(".wb-color").forEach(s => s.classList.toggle("active", s === swatch));
    // Deactivate custom color picker border
    const customWrap = document.querySelector(".wb-color-custom");
    if (customWrap) customWrap.style.borderColor = "transparent";
    if (currentTool === "eraser" || currentTool === "pan") {
      currentTool = "pen";
      document.querySelectorAll(".wb-btn").forEach(b => b.classList.toggle("active", b.dataset.tool === "pen"));
      updateWbSizeSliders();
    }
  });
});

// Custom color picker (null-guarded)
(function() {
  const picker = document.getElementById("wbColorPicker");
  if (!picker) return;
  picker.addEventListener("input", (e) => {
    currentColor = e.target.value;
    document.querySelectorAll(".wb-color").forEach(s => s.classList.remove("active"));
    const customWrap = document.querySelector(".wb-color-custom");
    if (customWrap) customWrap.style.borderColor = "#111827";
    if (currentTool === "eraser" || currentTool === "pan") {
      currentTool = "pen";
      document.querySelectorAll(".wb-btn").forEach(b => b.classList.toggle("active", b.dataset.tool === "pen"));
      updateWbSizeSliders();
    }
  });
})();

// Pen size slider (null-guarded)
(function() {
  const slider = document.getElementById("wbPenSize");
  const label = document.getElementById("wbPenSizeLabel");
  if (!slider) return;
  slider.addEventListener("input", (e) => {
    wbPenSize = Number(e.target.value);
    if (label) label.textContent = wbPenSize;
  });
})();

// Eraser size slider (null-guarded)
(function() {
  const slider = document.getElementById("wbEraserSize");
  const label = document.getElementById("wbEraserSizeLabel");
  if (!slider) return;
  slider.addEventListener("input", (e) => {
    wbEraserSize = Number(e.target.value);
    if (label) label.textContent = wbEraserSize;
  });
})();

function isWbFullscreenActive() {
  return !!(document.fullscreenElement === sessionScreen || wbCssFullscreen);
}

function syncWbFullscreenUi() {
  const active = isWbFullscreenActive();
  mediaContainer.classList.toggle("wb-fullscreen", active);
  sessionScreen.classList.toggle("wb-overlay-active", active);
  if (active) {
    transcriptCollapsed = false;
    coachingCollapsed = false;
  }
  applyPanelWidths();
  if (wbFullscreenBtn) wbFullscreenBtn.textContent = active ? "\u2716" : "\u26F6";
  updateMediaLayout();
}

async function setWbFullscreen(enabled) {
  if (!mediaContainer) return;
  if (enabled) {
    wbCssFullscreen = false;
    if (!document.fullscreenElement && sessionScreen?.requestFullscreen) {
      try {
        // Fullscreen the whole session so transcript/tips overlays stay visible.
        await sessionScreen.requestFullscreen();
      } catch (_) {
        wbCssFullscreen = true;
      }
    } else if (!document.fullscreenElement) {
      wbCssFullscreen = true;
    }
  } else {
    wbCssFullscreen = false;
    if (document.fullscreenElement && document.exitFullscreen) {
      try { await document.exitFullscreen(); } catch (_) {}
    }
  }
  syncWbFullscreenUi();
}

if (wbFullscreenBtn) {
  wbFullscreenBtn.addEventListener("click", () => {
    setWbFullscreen(!isWbFullscreenActive());
  });
}
if (wbResetViewBtn) {
  wbResetViewBtn.addEventListener("click", resetWhiteboardView);
}
document.addEventListener("fullscreenchange", syncWbFullscreenUi);
window.addEventListener("resize", () => {
  applyCameraPosition();
});

// ── Camera management ────────────────────────────────────────────────────────
async function startCamera(withAudio = false) {
  cameraStream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 360, frameRate: 30 },
    audio: withAudio,
  });
  cameraFeed.srcObject = cameraStream;
  cameraPipFeed.srcObject = cameraStream;
  await cameraFeed.play().catch(() => {});
  await cameraPipFeed.play().catch(() => {});
}

function stopCamera() {
  if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
  cameraFeed.srcObject = null;
  cameraPipFeed.srcObject = null;
}

// ── Screen share management ─────────────────────────────────────────────────
async function startScreenShare() {
  screenStream = await navigator.mediaDevices.getDisplayMedia({
    video: { cursor: "always" },
  });
  screenFeed.srcObject = screenStream;
  await screenFeed.play().catch(() => {});

  // Handle browser's "Stop sharing" button
  screenStream.getVideoTracks()[0].onended = () => {
    screenEnabled = false;
    stopScreenShare();
    updateMediaLayout();
  };
}

function stopScreenShare() {
  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
  screenFeed.srcObject = null;
}

function getCameraBounds() {
  if (isWbFullscreenActive()) {
    const margin = 12;
    return {
      minX: margin,
      minY: 72,
      maxX: window.innerWidth - cameraContainer.offsetWidth - margin,
      maxY: window.innerHeight - cameraContainer.offsetHeight - 84,
    };
  }
  const hostRect = sessionCenter.getBoundingClientRect();
  const margin = 10;
  return {
    minX: margin,
    minY: margin,
    maxX: Math.max(margin, hostRect.width - cameraContainer.offsetWidth - margin),
    maxY: Math.max(margin, hostRect.height - cameraContainer.offsetHeight - margin),
  };
}

function applyCameraPosition() {
  if (!cameraContainer.classList.contains("floating")) return;
  const b = getCameraBounds();
  cameraFloatLeft = Math.min(b.maxX, Math.max(b.minX, cameraFloatLeft));
  cameraFloatTop = Math.min(b.maxY, Math.max(b.minY, cameraFloatTop));
  cameraContainer.style.left = `${cameraFloatLeft}px`;
  cameraContainer.style.top = `${cameraFloatTop}px`;
}

function enableCameraFloating() {
  if (!cameraContainer.classList.contains("floating")) {
    cameraContainer.classList.add("floating");
    sessionCenter.classList.add("camera-floating-host");
    if (!cameraFloatLeft && !cameraFloatTop) {
      cameraFloatLeft = 20;
      cameraFloatTop = 20;
    }
  }
  cameraContainer.classList.toggle("fullscreen-floating", isWbFullscreenActive());
  applyCameraPosition();
}

function disableCameraFloating() {
  cameraContainer.classList.remove("floating", "fullscreen-floating");
  sessionCenter.classList.remove("camera-floating-host");
  cameraContainer.style.left = "";
  cameraContainer.style.top = "";
  cameraDragging = false;
}

function setupCameraDrag() {
  if (!cameraContainer || !cameraDragHandle) return;

  const dragStart = (clientX, clientY) => {
    if (!cameraContainer.classList.contains("floating")) return;
    cameraDragging = true;
    cameraDragStartX = clientX;
    cameraDragStartY = clientY;
    cameraStartLeft = cameraFloatLeft;
    cameraStartTop = cameraFloatTop;
  };
  const dragMove = (clientX, clientY) => {
    if (!cameraDragging) return;
    cameraFloatLeft = cameraStartLeft + (clientX - cameraDragStartX);
    cameraFloatTop = cameraStartTop + (clientY - cameraDragStartY);
    applyCameraPosition();
  };
  const dragEnd = () => { cameraDragging = false; };

  cameraDragHandle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragStart(e.clientX, e.clientY);
  });
  cameraDragHandle.addEventListener("touchstart", (e) => {
    const touch = e.touches?.[0];
    if (!touch) return;
    e.preventDefault();
    dragStart(touch.clientX, touch.clientY);
  }, { passive: false });

  document.addEventListener("mousemove", (e) => dragMove(e.clientX, e.clientY));
  document.addEventListener("mouseup", dragEnd);
  document.addEventListener("touchmove", (e) => {
    const touch = e.touches?.[0];
    if (!touch) return;
    if (!cameraDragging) return;
    e.preventDefault();
    dragMove(touch.clientX, touch.clientY);
  }, { passive: false });
  document.addEventListener("touchend", dragEnd);
}

// ── Media layout ─────────────────────────────────────────────────────────────
const sessionCenter = document.querySelector(".session-center");

function updateMediaLayout() {
  const activeSources = [cameraEnabled, whiteboardEnabled, screenEnabled].filter(Boolean).length;
  const dualMedia   = activeSources === 2;
  const tripleMedia = activeSources === 3;

  // Whiteboard in media container (only show after session is ready)
  mediaContainer.classList.toggle("hidden", !sessionReady || !whiteboardEnabled);
  whiteboardCanvas.style.display = whiteboardEnabled ? "block" : "none";
  cameraFeed.style.display = "none"; // Hidden — only used internally
  wbToolbar.classList.toggle("visible", whiteboardEnabled);
  orbPill.classList.toggle("visible", whiteboardEnabled);

  // Screen share container (only show after session is ready to avoid empty box during loading)
  screenContainer.classList.toggle("visible", sessionReady && screenEnabled);

  // Camera self-view in center column (only show after session is ready)
  cameraContainer.classList.toggle("visible", sessionReady && cameraEnabled);
  const shouldFloatCamera = sessionReady && cameraEnabled && (whiteboardEnabled || screenEnabled || isWbFullscreenActive());
  if (shouldFloatCamera) enableCameraFloating();
  else disableCameraFloating();

  // Layout modes: dual-media when 2 sources, triple-media when all 3
  sessionCenter.classList.toggle("dual-media", dualMedia);
  sessionCenter.classList.toggle("triple-media", tripleMedia);

  // Orb: hide when any media is active
  const hasMedia = cameraEnabled || whiteboardEnabled || screenEnabled;
  orbArea.classList.toggle("hidden", hasMedia);

  camToggleBtn.classList.toggle("active", cameraEnabled);
  wbToggleBtn.classList.toggle("active", whiteboardEnabled);
  screenToggleBtn.classList.toggle("active", screenEnabled);
}

// ── Panel resizers and toggles ──────────────────────────────────────────────
function applyPanelWidths() {
  transcriptPanel.style.width = transcriptCollapsed ? "0" : `${transcriptPanelWidth}px`;
  transcriptPanel.style.minWidth = transcriptCollapsed ? "0" : `${MIN_PANEL_WIDTH}px`;
  transcriptPanel.classList.toggle("collapsed", transcriptCollapsed);
  if (resizerLeft) resizerLeft.classList.toggle("hidden", transcriptCollapsed);
  if (toggleTranscriptBtn) toggleTranscriptBtn.textContent = transcriptCollapsed ? "[>]" : "[<]";

  coachingPanel.style.width = coachingCollapsed ? "0" : `${coachingPanelWidth}px`;
  coachingPanel.style.minWidth = coachingCollapsed ? "0" : `${MIN_PANEL_WIDTH}px`;
  coachingPanel.classList.toggle("collapsed", coachingCollapsed);
  if (resizerRight) resizerRight.classList.toggle("hidden", coachingCollapsed);
  if (toggleCoachingBtn) toggleCoachingBtn.textContent = coachingCollapsed ? "[<]" : "[>]";
}

function setupPanelResizers() {
  if (!resizerLeft || !resizerRight) return;

  resizerLeft.addEventListener("mousedown", (e) => { e.preventDefault(); resizingLeft = true; });
  resizerRight.addEventListener("mousedown", (e) => { e.preventDefault(); resizingRight = true; });

  document.addEventListener("mousemove", (e) => {
    if (!resizingLeft && !resizingRight) return;
    const x = e.clientX;
    if (resizingLeft) {
      const w = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, x));
      transcriptPanelWidth = w;
      transcriptPanel.style.width = `${w}px`;
      transcriptPanel.style.minWidth = `${MIN_PANEL_WIDTH}px`;
    }
    if (resizingRight) {
      const w = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, document.documentElement.clientWidth - x));
      coachingPanelWidth = w;
      coachingPanel.style.width = `${w}px`;
      coachingPanel.style.minWidth = `${MIN_PANEL_WIDTH}px`;
    }
  });

  document.addEventListener("mouseup", () => { resizingLeft = false; resizingRight = false; });
}

if (toggleTranscriptBtn) {
  toggleTranscriptBtn.addEventListener("click", () => {
    transcriptCollapsed = !transcriptCollapsed;
    if (!transcriptCollapsed && transcriptPanelWidth === 0) transcriptPanelWidth = TRANSCRIPT_DEFAULT_WIDTH;
    applyPanelWidths();
  });
}
if (toggleCoachingBtn) {
  toggleCoachingBtn.addEventListener("click", () => {
    coachingCollapsed = !coachingCollapsed;
    if (!coachingCollapsed && coachingPanelWidth === 0) coachingPanelWidth = COACHING_DEFAULT_WIDTH;
    applyPanelWidths();
  });
}

// ── In-session file drop and upload ─────────────────────────────────────────
function showSessionToast(message, style) {
  if (!sessionToast) return;
  sessionToast.textContent = message;
  sessionToast.className = "session-toast visible" + (style ? " toast-" + style : "");
}
function hideSessionToast() {
  if (!sessionToast) return;
  sessionToast.classList.remove("visible");
}

async function sendSessionMaterialFile(file) {
  let mimeType = file.type || "";
  if (!mimeType) {
    const ext = file.name.split(".").pop().toLowerCase();
    if (ext === "md") mimeType = "text/markdown";
    else if (ext === "txt") mimeType = "text/plain";
    else if (ext === "csv") mimeType = "text/csv";
    else if (ext === "pdf") mimeType = "application/pdf";
  }
  if (!ACCEPTED_TYPES.has(mimeType) && !file.name.match(/\.(doc|docx)$/i)) return;

  const base64 = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1] || "");
    reader.readAsDataURL(file);
  });
  if (!base64) return;

  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: "material_file", name: file.name, mimeType: mimeType || "application/octet-stream", base64 }));
      showSessionToast(`Shared "${file.name}" with class`);
      setTimeout(() => hideSessionToast(), 2800);
      updateActivity();
    } catch (_) {}
  }
}

function setupSessionFileDrop() {
  if (!sessionScreen) return;
  sessionScreen.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("files")) return;
    e.preventDefault();
    e.stopPropagation();
    sessionScreen.classList.add("drag-over-session");
  });
  sessionScreen.addEventListener("dragleave", (e) => {
    if (!sessionScreen.contains(e.relatedTarget)) {
      sessionScreen.classList.remove("drag-over-session");
    }
  });
  sessionScreen.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    sessionScreen.classList.remove("drag-over-session");
    const files = e.dataTransfer.files;
    if (files && files.length) {
      for (const file of Array.from(files)) sendSessionMaterialFile(file);
    }
  });
  if (uploadMaterialBtn && sessionFileInput) {
    uploadMaterialBtn.addEventListener("click", () => sessionFileInput.click());
    sessionFileInput.addEventListener("change", () => {
      if (sessionFileInput.files && sessionFileInput.files.length) {
        for (const file of Array.from(sessionFileInput.files)) sendSessionMaterialFile(file);
        sessionFileInput.value = "";
      }
    });
  }
}
setupSessionFileDrop();
setupPanelResizers();
setupCameraDrag();

// ── Frame sending: composite camera/screen + whiteboard so AI sees board ────
function startFrameSending() {
  if (frameInterval) clearInterval(frameInterval);
  frameInterval = setInterval(() => {
    if (awaitingReflection) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!cameraEnabled && !whiteboardEnabled && !screenEnabled) return;

    // Only send frames when the teacher is speaking or recently spoke.
    // This is the PRIMARY fix for hallucination: the model interprets
    // incoming video frames as "the user is active" and generates
    // unprompted responses. By gating frames to the speech window,
    // we prevent the model from talking when the teacher is silent.
    const now = Date.now();
    const inSpeechWindow = vadInSpeech || (now - lastSpeechFrameTime < FRAME_SPEECH_WINDOW_MS);
    if (!inSpeechWindow) {
      // When camera is enabled, send a low-rate "silent" frame so Gemini
      // maintains visual awareness (e.g. teacher holding up fingers).
      // One frame every 8s is too infrequent to trigger hallucination.
      if (cameraEnabled && (now - lastSilentFrameTime >= SILENT_FRAME_INTERVAL_MS)) {
        lastSilentFrameTime = now;
        // fall through to capture & send
      } else {
        return;
      }
    }

    const W = 1280, H = 720;
    const ctx = compositeCanvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);

    const hasScreen = screenEnabled && screenFeed && screenFeed.srcObject;
    const hasWhiteboard = whiteboardEnabled && whiteboardCanvas.width;
    const hasCamera = cameraEnabled && cameraPipFeed && cameraPipFeed.srcObject;

    // Collect active sources into a list for smart tiling
    const sources = [];
    if (hasCamera)     sources.push({ type: "camera",     el: cameraPipFeed });
    if (hasScreen)     sources.push({ type: "screen",     el: screenFeed });
    if (hasWhiteboard) sources.push({ type: "whiteboard", el: whiteboardCanvas });

    if (sources.length === 1) {
      // Single source — full frame
      try { ctx.drawImage(sources[0].el, 0, 0, W, H); } catch (_) {}
    } else if (sources.length === 2) {
      // Two sources — side by side, each 640x720
      try { ctx.drawImage(sources[0].el, 0, 0, W / 2, H); } catch (_) {}
      try { ctx.drawImage(sources[1].el, W / 2, 0, W / 2, H); } catch (_) {}
    } else if (sources.length === 3) {
      // Three sources — camera top full width, other two bottom half each
      const camIdx = sources.findIndex(s => s.type === "camera");
      const cam = camIdx >= 0 ? sources.splice(camIdx, 1)[0] : sources.shift();
      try { ctx.drawImage(cam.el, 0, 0, W, H / 2); } catch (_) {}
      try { ctx.drawImage(sources[0].el, 0, H / 2, W / 2, H / 2); } catch (_) {}
      try { ctx.drawImage(sources[1].el, W / 2, H / 2, W / 2, H / 2); } catch (_) {}
    }

    const base64 = compositeCanvas.toDataURL("image/jpeg", 0.5).split(",")[1];
    try { ws.send(JSON.stringify({ type: "video_frame", base64 })); } catch (_) {}
    canvasDirty = false;
  }, 2000);
}

// ── Mic capture ──────────────────────────────────────────────────────────────
function resumeMicContextOnGesture() {
  if (micContext && micContext.state === "suspended") {
    micContext.resume().catch(() => {});
  }
}
// One-time listener: resume mic AudioContext when browser has suspended it (e.g. autoplay policy)
let micResumeListenerAttached = false;
function attachMicResumeOnGesture() {
  if (micResumeListenerAttached) return;
  micResumeListenerAttached = true;
  const resume = () => {
    resumeMicContextOnGesture();
    document.removeEventListener("click", resume);
    document.removeEventListener("keydown", resume);
    document.removeEventListener("touchstart", resume);
  };
  document.addEventListener("click", resume, { once: true });
  document.addEventListener("keydown", resume, { once: true });
  document.addEventListener("touchstart", resume, { once: true });
}

async function startMic(existingStream = null) {
  micStartedAt = Date.now();
  micStream = existingStream || await navigator.mediaDevices.getUserMedia({ audio: true });
  // Use only the audio tracks to avoid re-stopping video tracks on disconnect
  const audioOnlyStream = new MediaStream(micStream.getAudioTracks());
  micContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SEND_SAMPLE_RATE });
  if (micContext.state === "suspended") attachMicResumeOnGesture();
  micContext.addEventListener("statechange", () => {
    if (micContext && micContext.state === "suspended") attachMicResumeOnGesture();
  });
  const source = micContext.createMediaStreamSource(audioOnlyStream);

  // Pre-gain so quieter / far-away speech is audible to the AI (e.g. when teacher is far from device)
  const preGain = micContext.createGain();
  preGain.gain.value = 1.8;
  source.connect(preGain);

  micProcessor = micContext.createScriptProcessor(BUFFER_SIZE, 1, 1);
  micProcessor.onaudioprocess = e => {
    if (awaitingReflection) return;
    if (micMuted) return;
    // Keep the mic hot during a handover — frames queue until the new socket is ready.
    if (!handoverInProgress && (!ws || ws.readyState !== WebSocket.OPEN)) return;
    const input = e.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);

    // Dynamic threshold: when student audio is playing through speakers,
    // the mic picks up echo. Use a higher threshold so only real teacher
    // speech (not echo) triggers VAD. This prevents false interruptions
    // AND hallucinated teacher turns from echo being sent to Gemini.
    const studentIsPlaying = activeSources.length > 0 || (Date.now() - lastAudioChunkAt < 500);
    const effectiveThreshold = studentIsPlaying
      ? SPEECH_ENERGY_THRESHOLD * ECHO_GUARD_MULTIPLIER
      : SPEECH_ENERGY_THRESHOLD;

    if (rms > effectiveThreshold) {
      resetIdleTimer();
      lastSpeechFrameTime = Date.now();
      if (!vadInSpeech) {
        vadInSpeech = true;
        setMicActive(true);
        if (currentOrbState !== "speaking") setOrbState("listening");
        wsSend(JSON.stringify({ type: "speech_start" }));
        // Instantly kill student audio — mirrors Gemini Live Studio behavior.
        // The echo guard threshold above ensures this only fires on real
        // teacher speech, not speaker echo picked up by the mic.
        // Skip interruption during VAD warm-up: mic startup noise/pop can
        // falsely trigger this and kill the initial greeting audio.
        if (Date.now() - micStartedAt > 2000) {
          // Only suppress future audio if student audio was actively being
          // received (i.e., this is a real interruption). Without this guard,
          // suppressAudio stays true for ~2.3s (until speech_end fires) and
          // eats the beginning of the student's next response — causing the
          // intermittent "transcript shows but no audio" bug.
          const wasReceivingStudentAudio = audioChunksReceived > 0;
          interruptPlayback();
          if (wasReceivingStudentAudio) {
            suppressAudio = true;
          }
        }
      }
      vadSilenceCount = 0;
    } else if (vadInSpeech) {
      vadSilenceCount++;
      if (vadSilenceCount >= SILENCE_BUFFERS_BEFORE_END) {
        vadInSpeech = false;
        vadSilenceCount = 0;
        lastSpeechFrameTime = Date.now();
        setMicActive(!micMuted);
        if (currentOrbState !== "speaking") setOrbState("thinking");
        suppressAudio = false; // teacher stopped — allow next student response
        wsSend(JSON.stringify({ type: "speech_end", media: { camera: cameraEnabled, whiteboard: whiteboardEnabled, screen: screenEnabled } }));

        lastTeacherFinalizedAt = Date.now();
        const entryToClean = currentTeacherEntry;
        currentTeacherEntry = null;
        if (entryToClean && entryToClean.rawText.trim()) {
          cleanupEntry(entryToClean, false).catch(() => {});
        }
      }
    }
    // Send mic audio only while teacher speech is active to avoid
    // silence/noise being interpreted as new teacher turns.
    if (vadInSpeech) {
      wsSend(float32ToPcm16(input));
    }
  };

  preGain.connect(micProcessor);
  const gain = micContext.createGain();
  gain.gain.value = 0;
  micProcessor.connect(gain);
  gain.connect(micContext.destination);
  if (micContext.state === "suspended") await micContext.resume();

  // Reflect actual mic state: we have a stream and are not muted → show "mic on"
  setMicActive(!micMuted);
  const audioTracks = (micStream || existingStream)?.getAudioTracks?.();
  if (audioTracks?.length) {
    const track = audioTracks[0];
    const updateMicUI = () => setMicActive(!micMuted && track.enabled);
    track.addEventListener("enabled", updateMicUI);
    track.addEventListener("mute", () => setMicActive(false));
  }
}

// ── Session timer ────────────────────────────────────────────────────────────
function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, "0");
  const s = (sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function startTimer(elapsedMs = 0) {
  sessionStartTime = Date.now() - elapsedMs;
  sessionDuration = Math.floor(elapsedMs / 1000);
  sessionTimer.textContent = formatTime(sessionDuration);
  timerInterval = setInterval(() => {
    sessionDuration = Math.floor((Date.now() - sessionStartTime) / 1000);
    sessionTimer.textContent = formatTime(sessionDuration);
  }, 1000);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

// ── Idle timeout (60s no activity; check every 5s) ─────────────────────────────
function updateActivity() {
  lastActivityTimestamp = Date.now();
}

function startIdleCheck() {
  lastActivityTimestamp = Date.now();
  if (idleCheckInterval) return;
  idleCheckInterval = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const modal = document.getElementById("timeoutModal");
    if (modal && modal.classList.contains("visible")) return;
    if (Date.now() - lastActivityTimestamp >= IDLE_WARN_MS) showTimeoutModal();
  }, IDLE_CHECK_MS);
}

function stopIdleCheck() {
  if (idleCheckInterval) {
    clearInterval(idleCheckInterval);
    idleCheckInterval = null;
  }
}

function resetIdleTimer() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  updateActivity();
}

window.addEventListener("mousedown", updateActivity);
window.addEventListener("keypress", updateActivity);
window.addEventListener("touchstart", updateActivity);

function showTimeoutModal() {
  const modal = document.getElementById("timeoutModal");
  const countEl = document.getElementById("timeoutCountdown");
  if (!modal || !countEl) return;
  idleCountdownSec = IDLE_COUNTDOWN_SEC;
  countEl.textContent = String(idleCountdownSec);
  modal.classList.add("visible");
  if (idleCountdownInterval) clearInterval(idleCountdownInterval);
  idleCountdownInterval = setInterval(() => {
    idleCountdownSec--;
    if (countEl) countEl.textContent = String(idleCountdownSec);
    if (idleCountdownSec <= 0) {
      clearInterval(idleCountdownInterval);
      idleCountdownInterval = null;
      hideTimeoutModal();
      if (stopBtn && ws && ws.readyState === WebSocket.OPEN) {
        if (screenEnabled) {
          screenEnabled = false;
          stopScreenShare();
          updateMediaLayout();
        }
        awaitingReflection = true;
        stopPlayback();
        try { ws.send(JSON.stringify({ type: "request_reflection" })); } catch (_) {}
        stopBtn.disabled = true;
        sessionScreen.style.display = "none";
        const loading = document.getElementById("reflection-loading-screen");
        if (loading) loading.classList.add("visible");
      }
    }
  }, 1000);
}

function hideTimeoutModal() {
  const modal = document.getElementById("timeoutModal");
  if (modal) modal.classList.remove("visible");
  if (idleCountdownInterval) { clearInterval(idleCountdownInterval); idleCountdownInterval = null; }
  resetIdleTimer();
}

// ── Session lifecycle ────────────────────────────────────────────────────────
function showSession(topic) {
  setupScreen.style.display = "none";
  if (ambientViz) ambientViz.stop();
  reflectionScreen.style.display = "none";
  if (reflectionLoadingScreen) reflectionLoadingScreen.classList.remove("visible");
  sessionScreen.style.display = "flex";

  transcriptPanelWidth = TRANSCRIPT_DEFAULT_WIDTH;
  coachingPanelWidth   = COACHING_DEFAULT_WIDTH;
  transcriptCollapsed = false;
  coachingCollapsed   = false;
  applyPanelWidths();

  sessionTopicLabel.textContent = topic;
  speakerLabel.textContent = "";
  speakerLabel.style.color = "";
  setOrbState("idle");
  setStatus("Connecting\u2026", "");

  // Clear transcript & coaching
  transcriptBody.innerHTML = "";
  coachingBody.innerHTML = '<div class="coaching-empty">Tips will appear as you teach\u2026</div>';
  transcriptEntryId = 0;
  currentTeacherEntry = null;
  currentStudentEntry = null;
  transcriptContextHistory.length = 0;
  liveCleanupTimers.forEach((timer) => clearTimeout(timer));
  liveCleanupTimers.clear();
  liveCleanupInFlight.clear();

  sessionReady = false;
  updateMediaLayout();
}

const PRO_TIPS = [
  "Start with one concept and check for understanding before moving on.",
  "Use the whiteboard to draw a quick diagram—it helps visual learners.",
  "Pause after each key point and ask: \"Does that make sense so far?\"",
  "If your student seems stuck, try rephrasing with a real-world example.",
  "Let silence sit for a moment; it gives them time to formulate questions.",
];

function loadRecentSessions() {
  const list = document.getElementById("recentSessionsList");
  const empty = document.getElementById("recentSessionsEmpty");
  if (!list || !empty) return;
  try {
    const raw = localStorage.getItem("poken_recent_topics");
    const topics = raw ? JSON.parse(raw) : [];
    list.innerHTML = "";
    if (topics.length === 0) {
      empty.style.display = "block";
      return;
    }
    empty.style.display = "none";
    topics.slice(0, 3).forEach(t => {
      const li = document.createElement("li");
      li.textContent = t;
      list.appendChild(li);
    });
  } catch (_) {
    empty.style.display = "block";
  }
}

function pushRecentTopic(topic) {
  if (!topic || typeof topic !== "string") return;
  try {
    const raw = localStorage.getItem("poken_recent_topics");
    const topics = raw ? JSON.parse(raw) : [];
    const next = [topic.trim(), ...topics.filter(t => t !== topic.trim())].slice(0, 3);
    localStorage.setItem("poken_recent_topics", JSON.stringify(next));
  } catch (_) {}
}

function updateSetupStats() {
  const hoursEl = document.getElementById("statTotalHours");
  const masteryEl = document.getElementById("statMastery");
  if (hoursEl) {
    try {
      let totalSec = parseInt(localStorage.getItem("poken_total_seconds"), 10) || 0;
      if (totalSec === 0) {
        const oldVal = parseInt(localStorage.getItem("poken_total_minutes"), 10);
        if (oldVal > 0) {
          totalSec = oldVal;
          localStorage.setItem("poken_total_seconds", String(totalSec));
          localStorage.removeItem("poken_total_minutes");
        }
      }
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      hoursEl.textContent = h > 0 ? h + "h" : (m > 0 ? m + "m" : "0h");
    } catch (_) {
      hoursEl.textContent = "0h";
    }
  }
  if (masteryEl) masteryEl.textContent = "—";
}

function setProTip() {
  const el = document.getElementById("setupProTip");
  if (el && PRO_TIPS.length) el.textContent = PRO_TIPS[Math.floor(Math.random() * PRO_TIPS.length)];
}

function showSetup() {
  sessionScreen.style.display = "none";
  reflectionScreen.style.display = "none";
  landingScreen.style.display = "none";
  setupScreen.style.display = "block";
  renderDebugPanel(); // show debug log if session had errors
  if (!ambientViz) ambientViz = new AmbientVisualizer("ambientCanvas");
  ambientViz.start();
  loadRecentSessions();
  updateSetupStats();
  setProTip();
  proTipInterval = setInterval(setProTip, 10000);
  startSetupHardware();
  updateStartButton();
  updateResumeButton();
  setOrbState("idle");
  stopBtn.disabled = false;
}

// ── Resume a session after a tab reload ──────────────────────────────────────
const resumeSessionBtn = document.getElementById("resumeSessionBtn");

function updateResumeButton() {
  if (!resumeSessionBtn) return;
  const stored = loadStoredSession();
  resumeSessionBtn.style.display = stored ? "block" : "none";
  if (stored) resumeSessionBtn.textContent = `Resume last session — ${stored.settings?.topic || "untitled"}`;
}

if (resumeSessionBtn) {
  resumeSessionBtn.addEventListener("click", async () => {
    const stored = loadStoredSession();
    if (!stored) { updateResumeButton(); return; }
    playButtonSound("confirm");
    resumeSessionBtn.disabled = true;
    const s = stored.settings || {};
    // Restore the setup-screen state the URL builder reads from, through the existing UI handlers.
    const personaCard = document.querySelector(`.persona-card[data-persona="${s.persona || "eager"}"]`);
    if (personaCard) personaCard.click();
    if (customTopic) customTopic.value = s.topic || "";
    if (sessionLanguageEl && s.language) sessionLanguageEl.value = s.language;
    if (materialsEl) materialsEl.value = s.materials || "";
    resumeToken = stored.token;
    materialsContext = stored.materialsContext || "";
    await connect({ resume: true });
    resumeSessionBtn.disabled = false;
  });
}

function showLanding() {
  sessionScreen.style.display = "none";
  setupScreen.style.display = "none";
  if (ambientViz) ambientViz.stop();
  reflectionScreen.style.display = "none";
  if (reflectionLoadingScreen) reflectionLoadingScreen.classList.remove("visible");
  landingScreen.style.display = "flex";
  landingScreen.classList.remove("fade-out");
}

// Store last reflection data for PDF download
let lastReflectionData = null;

function showReflection(data) {
  lastReflectionData = data;
  if (reflectionLoadingScreen) reflectionLoadingScreen.classList.remove("visible");
  sessionScreen.style.display = "none";
  reflectionScreen.style.display = "block";

  // Apply localized labels if provided (non-English sessions)
  const labels = data.uiLabels || {};
  if (labels.title) {
    const titleEl = document.querySelector(".reflection-title");
    if (titleEl) titleEl.textContent = labels.title;
  }
  const labelMap = {
    reflectionCardStrength: labels.strengths,
    reflectionCardGap: labels.gaps,
    reflectionCardVocab: labels.vocabulary,
    reflectionCardImprovement: labels.nextSteps,
    reflectionCardQuestions: labels.questions,
    reflectionCardPresentation: labels.presentationFeedback,
    reflectionCardMechanics: labels.mechanics,
  };
  for (const [cardId, label] of Object.entries(labelMap)) {
    if (!label) continue;
    const h3 = document.querySelector(`#${cardId} h3`);
    if (!h3) continue;
    const icon = h3.querySelector(".rcard-icon");
    if (icon) {
      h3.textContent = "";
      h3.appendChild(icon);
      h3.append(" " + label);
    } else {
      h3.textContent = label;
    }
  }
  if (labels.teachAgain) teachAgainBtn.innerHTML = `&#x1F393; ${labels.teachAgain}`;
  if (labels.changeTopic) changeTopicBtn.textContent = labels.changeTopic;
  const dlBtn = document.getElementById("downloadSummaryBtn");
  if (labels.downloadSummary && dlBtn) dlBtn.innerHTML = `<span class="reflection-download-icon">&#x1F4E5;</span> ${labels.downloadSummary}`;

  reflectionSummary.textContent = data.summary || "";

  const recapTopic = document.getElementById("reflectionRecapTopic");
  const recapMode = document.getElementById("reflectionRecapMode");
  const recapDuration = document.getElementById("reflectionRecapDuration");
  if (recapTopic) recapTopic.textContent = sessionTopic || "—";
  if (recapMode) recapMode.textContent = "Solo";
  if (recapDuration) recapDuration.textContent = formatTime(sessionDuration) || "0:00";

  function wrapBold(s) {
    return s.replace(/\*\*(.*?)\*\*/g, (_, t) => `<span class="reflection-highlight">${escapeHtml(t)}</span>`);
  }

  // Strengths — card-style items with icons
  const strengthIcons = ["\u{1F60A}", "\u{1F465}", "\u{1F551}"];
  if (reflectionStrengths) {
    reflectionStrengths.innerHTML = "";
    (data.strengths || []).forEach((item, i) => {
      const raw = typeof item === "string" ? item : String(item);
      const div = document.createElement("div");
      div.className = "rcard-item";
      div.innerHTML = `<span class="rcard-item-icon">${strengthIcons[i % strengthIcons.length]}</span> <span>${wrapBold(raw)}</span>`;
      reflectionStrengths.appendChild(div);
    });
  }

  // Gaps — card-style items with icons
  const gapIcons = ["\u{1F504}", "\u{2757}", "\u{1F914}"];
  const gapsList = document.getElementById("reflectionGaps");
  const gapsEmpty = document.getElementById("reflectionGapsEmpty");
  if (gapsList && gapsEmpty) {
    gapsList.innerHTML = "";
    if (labels.gapsEmpty) gapsEmpty.textContent = labels.gapsEmpty;
    if (!data.gaps || data.gaps.length === 0) {
      gapsEmpty.style.display = "block";
    } else {
      gapsEmpty.style.display = "none";
      data.gaps.forEach((item, i) => {
        const raw = typeof item === "string" ? item : String(item);
        const div = document.createElement("div");
        div.className = "rcard-item";
        div.innerHTML = `<span class="rcard-item-icon">${gapIcons[i % gapIcons.length]}</span> <span>${wrapBold(raw)}</span>`;
        gapsList.appendChild(div);
      });
    }
  }

  // Key Vocabulary — pill tags
  const vocabEl = document.getElementById("reflectionVocabulary");
  if (vocabEl) {
    vocabEl.innerHTML = "";
    (data.keyVocabulary || []).forEach(term => {
      const span = document.createElement("span");
      span.className = "rcard-vocab-tag";
      span.textContent = typeof term === "string" ? term : String(term);
      vocabEl.appendChild(span);
    });
  }

  // Next steps — bullet list
  const checklistEl = document.getElementById("reflectionImprovementsChecklist");
  if (checklistEl) {
    checklistEl.innerHTML = "";
    (data.improvements || []).forEach(text => {
      const raw = typeof text === "string" ? text : String(text);
      const li = document.createElement("li");
      li.innerHTML = wrapBold(raw);
      checklistEl.appendChild(li);
    });
    if (!data.improvements || data.improvements.length === 0) {
      const li = document.createElement("li");
      li.textContent = "No steps suggested.";
      li.style.color = "#94a3b8";
      checklistEl.appendChild(li);
    }
  }

  // Student questions — quote cards
  if (reflectionQuestions) {
    reflectionQuestions.innerHTML = "";
    (data.topQuestions || []).forEach(q => {
      const raw = typeof q === "string" ? q : String(q);
      const div = document.createElement("div");
      div.className = "rcard-question";
      div.textContent = raw.startsWith('"') ? raw : `"${raw}"`;
      reflectionQuestions.appendChild(div);
    });
  }

  // Presentation skills feedback — combined text
  const ps = data.presentationSkills || {};
  const feedbackParts = [ps.visualsAndGestures, ps.explanations, ps.mediaUsage].filter(s => s && s.trim() && s !== "—");
  if (reflectionVisualsGestures) {
    reflectionVisualsGestures.textContent = feedbackParts.length > 0 ? feedbackParts.join(" ") : "No presentation feedback available.";
  }
  const visualsEmpty = document.getElementById("reflectionVisualsEmpty");
  if (visualsEmpty) {
    if (feedbackParts.length === 0) {
      visualsEmpty.textContent = "Tip: Next time, try using the whiteboard to illustrate " + (sessionTopic || "your topic") + ".";
      visualsEmpty.style.display = "block";
    } else {
      visualsEmpty.style.display = "none";
    }
  }

  // Presentation mechanics — 4-column ratings
  const mech = data.presentationMechanics || {};
  const mechClarity = document.getElementById("mechClarity");
  const mechVisuals = document.getElementById("mechVisuals");
  const mechPacing = document.getElementById("mechPacing");
  const mechTools = document.getElementById("mechTools");
  if (mechClarity) mechClarity.textContent = mech.clarity || "—";
  if (mechVisuals) mechVisuals.textContent = mech.visuals || "—";
  if (mechPacing) mechPacing.textContent = mech.pacing || "—";
  if (mechTools) mechTools.textContent = mech.tools || "—";

  pushRecentTopic(sessionTopic);
  try {
    const raw = localStorage.getItem("poken_total_seconds");
    const totalSec = (raw ? parseInt(raw, 10) : 0) + sessionDuration;
    localStorage.setItem("poken_total_seconds", String(totalSec));
  } catch (_) {}
  saveSession({ topic: sessionTopic, reflection: data, duration: sessionDuration });
}

function disconnect(keepScreen = false) {
  if (ws) {
    ws.onclose = null;
    try { ws.close(); } catch (_) {}
    ws = null;
  }
  if (oldWs) { oldWs.onclose = null; try { oldWs.close(); } catch (_) {} oldWs = null; }
  if (resumeRetryTimer) { clearTimeout(resumeRetryTimer); resumeRetryTimer = null; }
  handoverInProgress = false;
  handoverQueue = [];
  resumeFailures = 0;
  resumeToken = null;
  materialsContext = "";
  clearStoredSession();
  if (micProcessor) { try { micProcessor.disconnect(); } catch (_) {} micProcessor = null; }
  if (micStream) { micStream.getAudioTracks().forEach(t => t.stop()); micStream = null; }
  if (micContext) { try { micContext.close(); } catch (_) {} micContext = null; }
  stopCamera();
  stopScreenShare();
  screenEnabled = false;
  if (frameInterval) { clearInterval(frameInterval); frameInterval = null; }
  stopTimer();
  stopPlayback();
  // Close diagram popup if open
  const diagPopup = document.getElementById("diagramPopup");
  if (diagPopup) {
    diagPopup.classList.remove("visible", "diagram-fullscreen");
    diagPopup.style.display = "none"; // force hide in case CSS class removal isn't enough
  }
  diagramPopupOpen = false;
  stopDiagramFrameSending();
  // Also clear any diagram thumbnail cards from the transcript
  document.querySelectorAll(".t-diagram-card").forEach(el => el.remove());
  stopIdleCheck();
  if (idleCountdownInterval) { clearInterval(idleCountdownInterval); idleCountdownInterval = null; }
  hideTimeoutModal();
  const setupLoading = document.getElementById("setup-loading");
  if (setupLoading) { setupLoading.classList.remove("visible"); setupLoading.style.display = "none"; }

  audioChunksReceived = 0;
  vadInSpeech = false;
  vadSilenceCount = 0;
  micMuted = false;
  muteBtn.innerHTML = '<span class="icon">&#x1F3A4;</span> Mute';
  muteBtn.classList.remove("muted");
  if (coachingFadeTimer) { clearTimeout(coachingFadeTimer); coachingFadeTimer = null; }
  teacherSpeechEnded = false;
  currentTeacherEntry = null;
  currentStudentEntry = null;
  lastTeacherFinalizedAt = 0;
  lastStudentFinalizedAt = 0;
  awaitingReflection = false;
  whiteboardInited = false;
  coachingBody.innerHTML = '<div class="coaching-empty">Tips will appear as you teach\u2026</div>';
  resetWhiteboardView();
  setWbFullscreen(false);
  disableCameraFloating();

  if (!keepScreen) {
    if (lastError) {
      setStatus(lastError, "error");
      // Give user time to read the error message before returning to setup
      setTimeout(showSetup, 4000);
    } else {
      setTimeout(showSetup, 800);
    }
  }
}

/** Reconnect with the resume token after a backoff. Idempotent while a retry is pending. */
function scheduleResume(reason) {
  if (resumeRetryTimer) return;
  handoverInProgress = true;
  const delay = Math.min(1000 * Math.pow(2, resumeFailures), 30000);
  debugLog('warn', `Resuming in ${delay}ms: ${reason}`);
  setStatus("Reconnecting…", "");
  resumeRetryTimer = setTimeout(() => {
    resumeRetryTimer = null;
    connect({ resume: true });
  }, delay);
}

/** Server asked us to move to a fresh function invocation. The old socket stays open until the new one is ready. */
function beginClientHandover(token, reason) {
  if (handoverInProgress) return;
  if (token) resumeToken = token;
  if (!resumeToken) return;
  handoverInProgress = true;
  handoverQueue = [];
  debugLog('warn', `Session handover: ${reason || 'server request'}`);
  setStatus("Reconnecting…", "");
  if (ws) { oldWs = ws; oldWs.onclose = null; oldWs.onerror = null; }
  connect({ resume: true });
}

// Message types still worth applying from a socket that a handover has replaced.
const STALE_SOCKET_OK = new Set(["audio", "transcript", "teacher_transcript", "turn_complete", "emotion", "coaching_tip", "student_diagram"]);

/**
 * Open the session socket. `opts.resume` reconnects with the held resume token:
 * in-session (mic already running) nothing on screen is reset; after a tab reload
 * the session screen and hardware start fresh just like a new session.
 */
async function connect(opts = {}) {
  const resuming = !!(opts.resume && resumeToken);
  // In-session handover: the session screen is already up, so nothing on it is reset.
  const freshScreen = !resuming || sessionScreen.style.display !== "flex";

  if (freshScreen) {
    lastError = null;
    if (!resuming) debugEvents.length = 0; // clear debug log for new session
    awaitingReflection = false;
    stopSetupHardware();
    sessionTopic = resuming ? (resumeToken.topic || getSelectedTopic()) : getSelectedTopic();
    sessionLanguage = resuming ? (resumeToken.language || getSessionLanguage()) : getSessionLanguage();
    sessionMaterials = materialsEl.value.trim();
    cameraEnabled = useCameraEl.checked;
    whiteboardEnabled = useWhiteboardEl.checked;
    screenEnabled = false; // Screen share toggled on during session
  }
  // Always enable video model — screen share can be toggled mid-session
  const useVideo = true;

  if (freshScreen) {
    showSession(sessionTopic);

    const setupLoading = document.getElementById("setup-loading");
    const setupText = document.getElementById("setupLoadingText");
    if (setupLoading) { setupLoading.classList.add("visible"); setupLoading.style.display = "flex"; }
    if (setupText) setupText.textContent = resuming ? "Resuming your session…" : "Preparing your session…";
  } else {
    setStatus("Reconnecting…", "");
  }

  if (!playbackContext) playbackContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: RECV_SAMPLE_RATE });
  if (playbackContext.state === "suspended") await playbackContext.resume();

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${location.host}/ws/live`
    + `?topic=${encodeURIComponent(sessionTopic)}`
    + `&persona=${encodeURIComponent(selectedPersona)}`
    + `&language=${encodeURIComponent(sessionLanguage)}`
    + `&video=${useVideo ? "1" : "0"}`
    + (sessionMaterials ? `&materials=${encodeURIComponent(sessionMaterials)}` : "")
    + (resuming ? "&resume=1" : "");

  const sock = new WebSocket(url);
  sock.binaryType = "arraybuffer";
  ws = sock;

  sock.onopen = async () => {
    if (ws !== sock) return;
    debugLog('info', resuming ? 'WebSocket reconnected — resuming session' : 'WebSocket connected to server');
    setStatus(resuming ? "Resuming session…" : "Preparing session…", "connected");
    try {
      if (resuming) {
        // The analyzed materials ride along so the new invocation never re-runs vision.
        sock.send(JSON.stringify({ type: "resume", token: resumeToken, materialsContext }));
      } else {
        // Send uploaded study material files first so the server can merge them into the system instruction before the session starts
        for (const file of uploadedFiles) {
          try {
            sock.send(JSON.stringify({
              type: "material_file",
              name: file.name,
              mimeType: file.mimeType,
              base64: file.base64,
            }));
          } catch (_) {}
        }
      }
      // Tell server we're done sending pre-session materials; it will extract text, merge with pasted notes, then create the Live session and send session_ready
      sock.send(JSON.stringify({ type: "ready_to_start" }));
    } catch (e) {
      setStatus("Failed: " + e.message, "error");
    }
  };

  sock.onclose = (ev) => {
    if (ws !== sock) return; // replaced by a handover — ignore
    debugLog('error', `WebSocket closed (code ${ev.code}${ev.reason ? ': ' + ev.reason : ''})`);
    if (awaitingReflection) return;
    if (handoverInProgress) {
      // The replacement socket died before session_ready.
      resumeFailures++;
      if (resumeFailures >= RESUME_MAX_FAILURES) {
        lastError = lastError || "Could not reconnect to the session.";
        disconnect();
      } else {
        scheduleResume(`reconnect attempt ${resumeFailures} failed`);
      }
      return;
    }
    if (sessionReady && resumeToken) { scheduleResume(`connection closed (code ${ev.code})`); return; }
    disconnect();
  };

  sock.onerror = () => {
    if (ws !== sock) return;
    debugLog('error', 'WebSocket connection error');
    if (!handoverInProgress && !(sessionReady && resumeToken)) {
      lastError = "Connection error.";
      setStatus("Connection error", "error");
    }
  };

  sock.onmessage = async event => {
    const stale = ws !== sock;
    if (stale && oldWs !== sock) return; // a socket we've fully abandoned

    // Binary audio
    if (event.data instanceof ArrayBuffer) { await playPcm24k(event.data); return; }
    if (event.data instanceof Blob) { await playPcm24k(await event.data.arrayBuffer()); return; }

    try {
      const msg = JSON.parse(event.data);
      if (stale && !STALE_SOCKET_OK.has(msg.type)) return;

      // Session is ready: server has created the Live session with pre-session materials in context; start mic/camera/timer now
      if (msg.type === "session_ready") {
        debugLog('info', resuming ? 'Session resumed' : 'Gemini Live session ready');
        const setupLoading = document.getElementById("setup-loading");
        if (setupLoading) { setupLoading.classList.remove("visible"); setupLoading.style.display = "none"; }
        sessionReady = true;
        updateActivity();
        startIdleCheck();
        resumeFailures = 0;
        if (resuming) {
          if (oldWs) { oldWs.onclose = null; try { oldWs.close(); } catch (_) {} oldWs = null; }
          handoverInProgress = false;
          const queued = handoverQueue;
          handoverQueue = [];
          for (const frame of queued) { try { sock.send(frame); } catch (_) {} }
          if (queued.length) debugLog('info', `Flushed ${queued.length} frames buffered during handover`);
          // The new invocation starts with every media source OFF — resync it.
          try { sock.send(JSON.stringify({ type: "media_state", camera: cameraEnabled, whiteboard: whiteboardEnabled, screen: screenEnabled })); } catch (_) {}
          storeSessionForResume();
          setStatus("Reconnected — keep going.", "connected");
        }
        if (!micProcessor) {
          // The session clock runs even if the hardware fails — typed teaching still counts.
          if (!timerInterval) startTimer(resuming ? (resumeToken.elapsedMs || 0) : 0);
          (async () => {
            try {
              if (cameraEnabled) {
                await startCamera(true);
                await startMic(cameraStream);
              } else {
                await startMic();
              }
              if (whiteboardEnabled) {
                initWhiteboard();
              }
              updateMediaLayout();
              startFrameSending();
            } catch (e) {
              setStatus("Camera/mic failed: " + e.message, "error");
            }
          })();
        }
      }

      // Handover / resume bookkeeping
      if (msg.type === "session_context") { materialsContext = msg.materialsContext || ""; }
      if (msg.type === "session_state" && msg.resumeToken) { resumeToken = msg.resumeToken; storeSessionForResume(); }
      if (msg.type === "session_handover") { beginClientHandover(msg.resumeToken, msg.reason); }

      // Status
      if (msg.type === "info") { debugLog('info', msg.message || ''); setStatus(msg.message || "", "connected"); }
      if (msg.type === "error") { debugLog('error', msg.message || 'Unknown error'); lastError = msg.message; setStatus(msg.message, "error"); }
      // Server-pushed debug events
      if (msg.type === "debug") { debugLog(msg.level || 'info', msg.message || ''); }

      // Material processing progress (pre-session vision analysis)
      if (msg.type === "material_progress") {
        const loadingText = document.querySelector("#setup-loading .setup-loading-text");
        if (loadingText) {
          loadingText.textContent = `Analyzing ${msg.filename} (${msg.current}/${msg.total})…`;
        }
      }
      // In-session material processing (file dropped mid-session)
      if (msg.type === "material_processing") {
        showSessionToast(`Analyzing ${msg.filename}…`, "processing");
      }
      if (msg.type === "material_processed") {
        showSessionToast(`${msg.filename} ready ✓`, "success");
        setTimeout(() => hideSessionToast(), 3000);
      }


      // Teacher transcript: new teacher turn — close any open student entry first.
      if (msg.type === "teacher_transcript" && msg.text) {
        resetIdleTimer();
        if (!currentTeacherEntry) {
          if (Date.now() - lastTeacherFinalizedAt < STALE_CHUNK_WINDOW_MS) {
            // Stale chunk arriving after teacher turn was finalized — drop it
          } else {
            // Close student entry if AI was still mid-response when teacher started speaking
            if (currentStudentEntry) {
              const entry = currentStudentEntry;
              currentStudentEntry = null;
              lastStudentFinalizedAt = Date.now();
              if (entry.rawText.trim()) cleanupEntry(entry, false).catch(() => {});
            }
            currentTeacherEntry = addTranscriptEntry("You", "teacher");
            appendToEntry(currentTeacherEntry, msg.text, { live: true, predict: true });
          }
        } else {
          appendToEntry(currentTeacherEntry, msg.text, { live: true, predict: true });
        }
      }

      // Student transcript: new student turn — close any open teacher entry first.
      // Safety net: if transcript arrives while suppressAudio is stuck on (e.g.,
      // from a stale speech_start when no student audio was playing), clear it.
      // Transcript confirms the model is generating a NEW response.
      if (msg.type === "transcript" && msg.text) {
        if (suppressAudio && !vadInSpeech) suppressAudio = false;
        const expectedSpeaker = "Student";

        if (!currentStudentEntry) {
          if (Date.now() - lastStudentFinalizedAt < STALE_CHUNK_WINDOW_MS) {
            // Stale chunk arriving after student turn was finalized — drop it
          } else {
            // Close teacher entry if it was left open
            if (currentTeacherEntry) {
              const entry = currentTeacherEntry;
              currentTeacherEntry = null;
              lastTeacherFinalizedAt = Date.now();
              if (entry.rawText.trim()) cleanupEntry(entry, false).catch(() => {});
            }
            currentStudentEntry = addTranscriptEntry(expectedSpeaker, "student");
          }
        }
        if (currentStudentEntry) appendToEntry(currentStudentEntry, msg.text, { live: true, predict: true });
      }

      // Solo turn complete
      if (msg.type === "turn_complete") {
        suppressAudio = false;
        lastStudentFinalizedAt = Date.now();
        const studentEntry = currentStudentEntry;
        currentStudentEntry = null;
        if (studentEntry && studentEntry.rawText.trim()) {
          cleanupEntry(studentEntry, false).catch(() => {});
        }
        audioChunksReceived = 0;
        setOrbState("listening");
        setStatus("Your turn \u2014 speak and pause when done.", "connected");
      }

      // Emotion
      if (msg.type === "emotion" && SERVER_EMOTION_STATES.has(msg.state)) {
        setOrbState(msg.state);
      }

      // Audio (solo)
      if (msg.type === "audio" && msg.base64) {
        // In solo mode there's no student_speaking message to clear suppressAudio.
        // If teacher stopped talking (VAD silence) but speech_end hasn't fired yet,
        // clear suppressAudio so the response audio plays immediately.
        if (suppressAudio && !vadInSpeech) suppressAudio = false;
        const binary = atob(msg.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        await playPcm24k(bytes.buffer);
      }

      // Coaching tip
      if (msg.type === "coaching_tip" && msg.tip) {
        addCoachingTip(msg.tip);
      }

      // Student diagram
      if (msg.type === "student_diagram" && msg.base64) {
        console.log(`[Poken][Diagram] Received student_diagram from ${msg.studentId} (${msg.mimeType || "image/png"}, ${msg.base64.length} chars)`);
        showDiagramThumbnail(msg.studentId, msg.base64, msg.mimeType || "image/png");
      }

      // Reflection
      if (msg.type === "reflection" && msg.data) {
        awaitingReflection = false;
        disconnect(true);
        showReflection(msg.data);
      }

      // Vision refresh: server requests a full-page screenshot
      if (msg.type === "request_screenshot") {
        captureAndSendScreenshot();
      }
    } catch (_) {}
  };
}

// ── Controls ─────────────────────────────────────────────────────────────────
startBtn.addEventListener("click", async () => {
  if (!customTopic || !customTopic.value.trim()) return;
  if (!getSelectedTopic()) return;
  playButtonSound("confirm");
  startBtn.disabled = true;
  await connect();
  startBtn.disabled = false;
});

stopBtn.addEventListener("click", () => {
  playButtonSound("end");
  if (ws && ws.readyState === WebSocket.OPEN) {
    if (screenEnabled) {
      screenEnabled = false;
      stopScreenShare();
      updateMediaLayout();
    }
    awaitingReflection = true;
    stopPlayback();
    try { ws.send(JSON.stringify({ type: "request_reflection" })); } catch (_) {}
    stopBtn.disabled = true;
    sessionScreen.style.display = "none";
    if (reflectionLoadingScreen) reflectionLoadingScreen.classList.add("visible");
  } else {
    disconnect();
  }
});

const timeoutStayBtn = document.getElementById("timeoutStayBtn");
if (timeoutStayBtn) {
  timeoutStayBtn.addEventListener("click", () => {
    hideTimeoutModal();
  });
}

muteBtn.addEventListener("click", () => {
  micMuted = !micMuted;
  muteBtn.innerHTML = micMuted
    ? '<span class="icon">&#x1F507;</span> Unmute'
    : '<span class="icon">&#x1F3A4;</span> Mute';
  muteBtn.classList.toggle("muted", micMuted);
  if (micMuted) {
    setMicActive(false);
    vadInSpeech = false;
    vadSilenceCount = 0;
  } else {
    setMicActive(!!micStream?.getAudioTracks?.().length);
  }
});

camToggleBtn.addEventListener("click", async () => {
  if (cameraEnabled) {
    cameraEnabled = false;
    stopCamera();
    updateMediaLayout();
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "media_state", camera: false }));
  } else {
    try {
      cameraEnabled = true;
      updateMediaLayout(); // Make PiP container visible BEFORE play()
      await startCamera();
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "media_state", camera: true }));
    } catch (e) {
      cameraEnabled = false;
      updateMediaLayout();
      setStatus("Camera failed: " + e.message, "error");
      return;
    }
  }
});

wbToggleBtn.addEventListener("click", () => {
  whiteboardEnabled = !whiteboardEnabled;
  if (whiteboardEnabled) {
    if (!whiteboardInited) initWhiteboard();
  } else if (isWbFullscreenActive()) {
    setWbFullscreen(false);
  }
  updateMediaLayout();
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "media_state", whiteboard: whiteboardEnabled }));
});

screenToggleBtn.addEventListener("click", async () => {
  if (screenEnabled) {
    screenEnabled = false;
    stopScreenShare();
    updateMediaLayout();
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "media_state", screen: false }));
  } else {
    try {
      screenEnabled = true;
      updateMediaLayout(); // Show container before stream starts
      await startScreenShare();
      startFrameSending();
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "media_state", screen: true }));
    } catch (e) {
      screenEnabled = false;
      updateMediaLayout();
      if (e.name !== "NotAllowedError") {
        setStatus("Screen share failed: " + e.message, "error");
      }
    }
  }
});

function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  if (!handoverInProgress && (!ws || ws.readyState !== WebSocket.OPEN)) return;
  resetIdleTimer();
  wsSend(JSON.stringify({ type: "text_input", text }));
  // Show typed message in transcript
  const entry = addTranscriptEntry("You (typed)", "teacher");
  entry.rawText = text;
  entry.textEl.textContent = text;
  rememberTranscriptContext(entry.speaker, text);
  chatInput.value = "";
  setOrbState("thinking");
}

chatSendBtn.addEventListener("click", sendChatMessage);
chatInput.addEventListener("keydown", e => { if (e.key === "Enter") sendChatMessage(); });

// Keyboard shortcuts (when not typing)
document.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (sessionScreen.style.display !== "flex") return;
  if (e.key === "m" || e.key === "M") { muteBtn.click(); e.preventDefault(); }
});

// ── Reflection screen controls ───────────────────────────────────────────────
teachAgainBtn.addEventListener("click", () => {
  reflectionScreen.style.display = "none";
  showSetup();
});

changeTopicBtn.addEventListener("click", () => {
  reflectionScreen.style.display = "none";
  if (reflectionLoadingScreen) reflectionLoadingScreen.classList.remove("visible");
  disconnect();  // clean up ws, mic, playback before returning to setup
});

// ── PDF Download ─────────────────────────────────────────────────────────────
const downloadSummaryBtn = document.getElementById("downloadSummaryBtn");
if (downloadSummaryBtn) {
  downloadSummaryBtn.addEventListener("click", () => {
    if (!lastReflectionData) return;
    const data = lastReflectionData;
    const { jsPDF } = window.jspdf || {};
    if (!jsPDF) { alert("PDF library not loaded. Please try again."); return; }
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const pw = 210; // page width
    const margin = 20;
    const tw = pw - margin * 2; // text width
    let y = 20;

    function addText(text, size, style, color, maxW) {
      doc.setFontSize(size);
      doc.setFont("helvetica", style);
      doc.setTextColor(...color);
      const lines = doc.splitTextToSize(text, maxW || tw);
      if (y + lines.length * size * 0.45 > 280) { doc.addPage(); y = 20; }
      doc.text(lines, margin, y);
      y += lines.length * size * 0.45 + 2;
    }

    function addSection(title, items, bullet) {
      y += 4;
      if (y > 265) { doc.addPage(); y = 20; }
      addText(title, 13, "bold", [15, 23, 42]);
      (items || []).forEach(item => {
        const raw = (typeof item === "string" ? item : String(item)).replace(/\*\*/g, "");
        addText((bullet || "\u2022") + "  " + raw, 10, "normal", [51, 65, 85]);
      });
    }

    // Title
    addText("Session Reflection", 22, "bold", [15, 23, 42]);
    y += 2;
    // Summary
    if (data.summary) addText(data.summary, 10, "normal", [100, 116, 139]);
    y += 4;
    // Topic block
    addText("Topic: " + (sessionTopic || "—"), 14, "bold", [0, 121, 107]);
    addText("Solo  \u2022  " + (formatTime(sessionDuration) || "0:00") + " Session", 10, "normal", [71, 85, 105]);
    y += 2;

    // Sections
    addSection("What Went Well", data.strengths);
    addSection("Concepts to Revisit", data.gaps);

    if (data.keyVocabulary && data.keyVocabulary.length > 0) {
      y += 4;
      addText("Key Vocabulary", 13, "bold", [15, 23, 42]);
      addText(data.keyVocabulary.join("  \u2022  "), 10, "normal", [123, 31, 162]);
    }

    addSection("Next Steps", data.improvements);
    addSection("Student Questions", data.topQuestions, "\u201C");

    // Presentation feedback
    const ps = data.presentationSkills || {};
    const fb = [ps.visualsAndGestures, ps.explanations, ps.mediaUsage].filter(s => s && s.trim() && s !== "\u2014");
    if (fb.length > 0) {
      y += 4;
      addText("Presentation Skills Feedback", 13, "bold", [15, 23, 42]);
      addText(fb.join(" "), 10, "normal", [51, 65, 85]);
    }

    // Mechanics
    const mech = data.presentationMechanics || {};
    if (mech.clarity || mech.visuals || mech.pacing || mech.tools) {
      y += 4;
      addText("Presentation & Mechanics", 13, "bold", [15, 23, 42]);
      addText(`Clarity: ${mech.clarity || "\u2014"}   |   Visuals: ${mech.visuals || "\u2014"}   |   Pacing: ${mech.pacing || "\u2014"}   |   Tools: ${mech.tools || "\u2014"}`, 10, "normal", [51, 65, 85]);
    }

    // Footer
    y += 8;
    if (y > 275) { doc.addPage(); y = 20; }
    doc.setFontSize(8);
    doc.setTextColor(148, 163, 184);
    doc.text("Generated by Poken \u2014 Learn by Teaching", margin, 285);

    const filename = "Poken-Reflection-" + (sessionTopic || "session").replace(/[^a-zA-Z0-9]/g, "-").slice(0, 40) + ".pdf";
    doc.save(filename);
  });
}

// ── Firebase ─────────────────────────────────────────────────────────────────
function initFirebase() {
  if (!window.__FIREBASE_CONFIG || !window.__FIREBASE_CONFIG.apiKey) return;
  if (typeof firebase === "undefined") { setTimeout(initFirebase, 500); return; }
  try {
    if (!firebase.apps.length) firebase.initializeApp(window.__FIREBASE_CONFIG);
    firebase.auth().signInAnonymously().catch(e => console.warn("[Poken] Firebase auth:", e));
    db = firebase.firestore();
    console.log("[Poken] Firebase initialized");
  } catch (e) { console.warn("[Poken] Firebase init:", e); }
}

async function saveSession(data) {
  if (!db) return;
  try {
    const user = firebase.auth().currentUser;
    await db.collection("sessions").add({
      ...data,
      userId: user?.uid || "anonymous",
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    console.log("[Poken] Session saved to Firebase");
  } catch (e) { console.warn("[Poken] Firebase save:", e); }
}

// ── Boot ─────────────────────────────────────────────────────────────────────
initFirebase();

if (sessionHomeBtn) {
  sessionHomeBtn.addEventListener("click", () => {
    disconnect(true);
    showLanding();
  });
}


// ── Diagram frame streaming + vision refresh ────────────────────────────────

function startDiagramFrameSending() {
  if (diagramFrameInterval) clearInterval(diagramFrameInterval);
  diagramFrameInterval = setInterval(() => {
    if (!diagramPopupOpen) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Only send if teacher drew recently
    if (Date.now() - lastDiagramDrawTime > DIAGRAM_DRAW_WINDOW_MS) return;
    const canvas = document.getElementById("diagramCanvas");
    if (!canvas) return;
    const base64 = canvas.toDataURL("image/jpeg", 0.5).split(",")[1];
    try { ws.send(JSON.stringify({ type: "diagram_frame", base64 })); } catch (_) {}
  }, DIAGRAM_FRAME_INTERVAL_MS);
}

function stopDiagramFrameSending() {
  if (diagramFrameInterval) { clearInterval(diagramFrameInterval); diagramFrameInterval = null; }
}

function captureAndSendScreenshot() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const W = 1280, H = 720;
  const shotCanvas = document.createElement("canvas");
  shotCanvas.width = W;
  shotCanvas.height = H;
  const ctx = shotCanvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);

  // Collect active sources
  const sources = [];
  const camEl = document.getElementById("cameraPipFeed") || document.getElementById("cameraFeed");
  if (camEl && camEl.srcObject)          sources.push({ type: "camera", el: camEl });
  const screenEl = document.getElementById("screenFeed");
  if (screenEl && screenEl.srcObject)    sources.push({ type: "screen", el: screenEl });
  const wbCanvas = document.getElementById("whiteboardCanvas");
  if (wbCanvas && wbCanvas.width > 0)    sources.push({ type: "whiteboard", el: wbCanvas });
  // Include diagram if popup is open
  const diagCanvas = document.getElementById("diagramCanvas");
  const diagPopup = document.getElementById("diagramPopup");
  if (diagPopup && diagPopup.classList.contains("visible") && diagCanvas) {
    sources.push({ type: "diagram", el: diagCanvas });
  }

  // Smart tiling — every source gets maximum pixels
  if (sources.length === 1) {
    try { ctx.drawImage(sources[0].el, 0, 0, W, H); } catch (_) {}
  } else if (sources.length === 2) {
    try { ctx.drawImage(sources[0].el, 0, 0, W / 2, H); } catch (_) {}
    try { ctx.drawImage(sources[1].el, W / 2, 0, W / 2, H); } catch (_) {}
  } else if (sources.length === 3) {
    const camIdx = sources.findIndex(s => s.type === "camera");
    const cam = camIdx >= 0 ? sources.splice(camIdx, 1)[0] : sources.shift();
    try { ctx.drawImage(cam.el, 0, 0, W, H / 2); } catch (_) {}
    try { ctx.drawImage(sources[0].el, 0, H / 2, W / 2, H / 2); } catch (_) {}
    try { ctx.drawImage(sources[1].el, W / 2, H / 2, W / 2, H / 2); } catch (_) {}
  } else if (sources.length >= 4) {
    // 2x2 grid
    try { ctx.drawImage(sources[0].el, 0, 0, W / 2, H / 2); } catch (_) {}
    try { ctx.drawImage(sources[1].el, W / 2, 0, W / 2, H / 2); } catch (_) {}
    try { ctx.drawImage(sources[2].el, 0, H / 2, W / 2, H / 2); } catch (_) {}
    try { ctx.drawImage(sources[3].el, W / 2, H / 2, W / 2, H / 2); } catch (_) {}
  }

  // Add labels so Gemini knows which source is which
  ctx.font = "bold 16px Inter, sans-serif";
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 3;
  const positions = sources.length === 1 ? [[8, 24]]
    : sources.length === 2 ? [[8, 24], [W / 2 + 8, 24]]
    : sources.length === 3 ? [[8, 24], [8, H / 2 + 24], [W / 2 + 8, H / 2 + 24]]
    : [[8, 24], [W / 2 + 8, 24], [8, H / 2 + 24], [W / 2 + 8, H / 2 + 24]];
  // Recover full sources list for labelling (we may have spliced camera out)
  const allSources = sources.length === 1 ? sources
    : sources; // labels are approximate — camera always first
  // skip labels for single source
  if (sources.length > 1) {
    positions.forEach((pos, i) => {
      if (i < sources.length) {
        const label = sources[i].type.charAt(0).toUpperCase() + sources[i].type.slice(1);
        ctx.strokeText(label, pos[0], pos[1]);
        ctx.fillText(label, pos[0], pos[1]);
      }
    });
  }

  const base64 = shotCanvas.toDataURL("image/jpeg", 0.7).split(",")[1];
  try { ws.send(JSON.stringify({ type: "vision_screenshot", base64 })); } catch (_) {}
}

// ── Diagram popup ─────────────────────────────────────────────────────────────
(function () {
  const popup          = document.getElementById("diagramPopup");
  const titlebar       = document.getElementById("diagramTitlebar");
  const closeBtn       = document.getElementById("diagramCloseBtn");
  const fullscreenBtn  = document.getElementById("diagramFullscreenBtn");
  const canvas         = document.getElementById("diagramCanvas");
  const toolbar        = document.getElementById("diagramToolbar");
  const penBtn         = document.getElementById("diagPenBtn");
  const eraserBtn      = document.getElementById("diagEraserBtn");
  const textBtn        = document.getElementById("diagTextBtn");
  const clearBtn       = document.getElementById("diagClearBtn");
  const sizeSlider     = document.getElementById("diagSizeSlider");
  const resizeHandle   = document.getElementById("diagramResizeHandle");

  if (!popup || !canvas) return;
  const ctx = canvas.getContext("2d");

  // ── State ──────────────────────────────────────────────────────────────────
  let diagTool         = "pen";
  let diagColor        = "#000000";
  let diagPenSize      = 3;
  let diagDrawing      = false;
  let diagLastX        = 0;
  let diagLastY        = 0;
  let baseImageData    = null;   // snapshot after diagram image is drawn (for clear)
  let isDraggingDiagram   = false;
  let isResizingDiagram   = false;
  let dragOffX = 0, dragOffY = 0;
  let resizeStartX = 0, resizeStartY = 0;
  let resizeStartW = 0, resizeStartH = 0;

  // Keep last received diagram for re-loading after resize/fullscreen
  let lastDiagramBase64  = null;
  let lastDiagramMime    = "image/png";

  // ── Tool switching ──────────────────────────────────────────────────────────
  function setDiagTool(t) {
    diagTool = t;
    [penBtn, eraserBtn, textBtn].forEach(b => b && b.classList.remove("active"));
    if (t === "pen"    && penBtn)    penBtn.classList.add("active");
    if (t === "eraser" && eraserBtn) eraserBtn.classList.add("active");
    if (t === "text"   && textBtn)   textBtn.classList.add("active");
    canvas.style.cursor = t === "eraser" ? "cell" : t === "text" ? "text" : "crosshair";
  }

  if (penBtn)    penBtn.addEventListener("click",    () => setDiagTool("pen"));
  if (eraserBtn) eraserBtn.addEventListener("click", () => setDiagTool("eraser"));
  if (textBtn)   textBtn.addEventListener("click",   () => setDiagTool("text"));

  // ── Color swatches ──────────────────────────────────────────────────────────
  if (toolbar) {
    toolbar.querySelectorAll(".diag-color-swatch").forEach(swatch => {
      swatch.addEventListener("click", () => {
        toolbar.querySelectorAll(".diag-color-swatch").forEach(s => s.classList.remove("active"));
        swatch.classList.add("active");
        diagColor = swatch.dataset.color || "#000000";
        if (diagTool === "eraser") setDiagTool("pen");
      });
    });
  }

  // ── Size slider ─────────────────────────────────────────────────────────────
  if (sizeSlider) {
    sizeSlider.addEventListener("input", () => { diagPenSize = parseInt(sizeSlider.value, 10) || 3; });
  }

  // ── Clear ───────────────────────────────────────────────────────────────────
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (baseImageData) {
        ctx.putImageData(baseImageData, 0, 0);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    });
  }

  // ── Close / fullscreen ──────────────────────────────────────────────────────
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      popup.classList.remove("visible");
      diagramPopupOpen = false;
      stopDiagramFrameSending();
      // Notify server that diagram popup is closed
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: "diagram_popup_closed" })); } catch (_) {}
      }
    });
  }
  if (fullscreenBtn) {
    fullscreenBtn.addEventListener("click", () => {
      popup.classList.toggle("diagram-fullscreen");
      fullscreenBtn.textContent = popup.classList.contains("diagram-fullscreen") ? "\u2716" : "\u26F6";
      // Re-draw the diagram image into the now-resized canvas
      if (lastDiagramBase64) {
        setTimeout(() => loadDiagramIntoCanvas(lastDiagramBase64, lastDiagramMime), 50);
      }
    });
  }

  // ── Drawing events ──────────────────────────────────────────────────────────
  function getCanvasPos(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  }

  canvas.addEventListener("mousedown", onDiagStart);
  canvas.addEventListener("mousemove", onDiagMove);
  canvas.addEventListener("mouseup",   onDiagEnd);
  canvas.addEventListener("mouseleave", onDiagEnd);
  canvas.addEventListener("touchstart", onDiagStart, { passive: false });
  canvas.addEventListener("touchmove",  onDiagMove,  { passive: false });
  canvas.addEventListener("touchend",   onDiagEnd);

  function onDiagStart(e) {
    e.preventDefault();
    e.stopPropagation();
    lastDiagramDrawTime = Date.now(); // track for annotation streaming
    const { x, y } = getCanvasPos(e);
    if (diagTool === "text") {
      const input = prompt("Enter text:");
      if (input) {
        ctx.font = `${diagPenSize * 5 + 10}px Inter, sans-serif`;
        ctx.fillStyle = diagColor;
        ctx.fillText(input, x, y);
      }
      return;
    }
    diagDrawing = true;
    diagLastX   = x;
    diagLastY   = y;
    ctx.beginPath();
    ctx.moveTo(x, y);
  }

  function onDiagMove(e) {
    e.preventDefault();
    if (!diagDrawing) return;
    lastDiagramDrawTime = Date.now(); // track for annotation streaming
    const { x, y } = getCanvasPos(e);
    ctx.lineJoin = "round";
    ctx.lineCap  = "round";
    if (diagTool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.lineWidth = diagPenSize * 6;
      ctx.strokeStyle = "rgba(0,0,0,1)";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.lineWidth   = diagPenSize;
      ctx.strokeStyle = diagColor;
    }
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y);
    diagLastX = x; diagLastY = y;
  }

  function onDiagEnd(e) {
    if (diagDrawing) {
      ctx.globalCompositeOperation = "source-over";
      diagDrawing = false;
    }
  }

  // ── Drag (titlebar) ─────────────────────────────────────────────────────────
  if (titlebar) {
    titlebar.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      if (popup.classList.contains("diagram-fullscreen")) return;
      isDraggingDiagram = true;
      const rect = popup.getBoundingClientRect();
      dragOffX = e.clientX - rect.left;
      dragOffY = e.clientY - rect.top;
      e.preventDefault();
    });
  }

  // ── Resize handle ───────────────────────────────────────────────────────────
  if (resizeHandle) {
    resizeHandle.addEventListener("mousedown", (e) => {
      if (popup.classList.contains("diagram-fullscreen")) return;
      isResizingDiagram = true;
      const rect = popup.getBoundingClientRect();
      resizeStartX = e.clientX;
      resizeStartY = e.clientY;
      resizeStartW = rect.width;
      resizeStartH = rect.height;
      e.preventDefault();
      e.stopPropagation();
    });
  }

  document.addEventListener("mousemove", (e) => {
    if (isDraggingDiagram) {
      popup.style.left   = (e.clientX - dragOffX) + "px";
      popup.style.top    = (e.clientY - dragOffY) + "px";
      popup.style.bottom = "auto";
      popup.style.right  = "auto";
    }
    if (isResizingDiagram) {
      const newW = Math.max(300, resizeStartW + (e.clientX - resizeStartX));
      const newH = Math.max(250, resizeStartH + (e.clientY - resizeStartY));
      popup.style.width  = newW + "px";
      popup.style.height = newH + "px";
    }
  });
  document.addEventListener("mouseup", () => {
    isDraggingDiagram = isResizingDiagram = false;
  });

  // ── Stop popup events reaching session ─────────────────────────────────────
  popup.addEventListener("mousedown", (e) => e.stopPropagation());
  popup.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });

  // ── Load image into canvas ──────────────────────────────────────────────────
  function loadDiagramIntoCanvas(base64, mimeType) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const popupW = popup.offsetWidth   || 480;
        const popupH = (popup.offsetHeight || 400) - (titlebar ? titlebar.offsetHeight : 32) - (toolbar ? toolbar.offsetHeight : 42);
        canvas.width  = Math.max(popupW, 480);
        canvas.height = Math.max(popupH, 250);
        // Fill white background
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        // Scale image to fit, preserving aspect ratio
        const scale = Math.min(canvas.width / img.width, canvas.height / img.height);
        const drawW = img.width  * scale;
        const drawH = img.height * scale;
        const drawX = (canvas.width  - drawW) / 2;
        const drawY = (canvas.height - drawH) / 2;
        ctx.drawImage(img, drawX, drawY, drawW, drawH);
        // Snapshot after base image is drawn (for "clear annotations")
        baseImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        resolve();
      };
      img.onerror = () => resolve();
      img.src = `data:${mimeType};base64,${base64}`;
    });
  }

  // ── Public: open popup with a diagram ──────────────────────────────────────
  async function openDiagramPopup(base64, mimeType) {
    lastDiagramBase64 = base64;
    lastDiagramMime   = mimeType || "image/png";
    // Reset position to default (bottom-right) unless user has moved it
    if (!popup.style.left && !popup.style.top) {
      popup.style.bottom = "80px";
      popup.style.right  = "20px";
    }
    // Ensure visible before measuring dimensions
    popup.classList.remove("diagram-fullscreen");
    popup.classList.add("visible");
    fullscreenBtn.textContent = "\u26F6";
    setDiagTool("pen");
    await loadDiagramIntoCanvas(base64, mimeType || "image/png");

    // Start diagram annotation streaming
    diagramPopupOpen = true;
    startDiagramFrameSending();
    // Notify server that diagram popup is open (pause regular video frames)
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: "diagram_popup_open" })); } catch (_) {}
    }
  }

  // ── Public: show thumbnail card in transcript ───────────────────────────────
  window.showDiagramThumbnail = function (studentId, base64, mimeType) {
    const mime = mimeType || "image/png";
    // Find the last transcript entry (the most recent student bubble) and append to it
    const entries = transcriptBody ? transcriptBody.querySelectorAll(".t-entry") : [];
    const targetEntry = entries.length ? entries[entries.length - 1] : null;

    const card = document.createElement("div");
    card.className = "t-diagram-card";

    const thumb = document.createElement("img");
    thumb.className = "t-diagram-thumb";
    thumb.src = `data:${mime};base64,${base64}`;
    thumb.alt = "Student sketch";

    const btn = document.createElement("button");
    btn.className = "t-diagram-open-btn";
    btn.textContent = "\u270F\uFE0F Open & Annotate";

    const openFn = () => openDiagramPopup(base64, mime);
    thumb.addEventListener("click", openFn);
    btn.addEventListener("click",   openFn);

    card.appendChild(thumb);
    card.appendChild(btn);

    if (targetEntry) {
      targetEntry.appendChild(card);
    } else if (transcriptBody) {
      transcriptBody.appendChild(card);
    }
    if (transcriptBody) transcriptBody.scrollTop = transcriptBody.scrollHeight;
  };
})();
