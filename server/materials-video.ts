/**
 * Video processing using Gemini's File API + native vision.
 * Uploads video, waits for processing, then extracts transcription
 * and visual summary using generateContent.
 */
import type { GoogleGenAI } from '@google/genai';

// ── Types ────────────────────────────────────────────────────────────────────

export interface KeyMoment {
  timestamp: string; // MM:SS
  description: string;
}

export interface VideoAnalysisResult {
  transcription: string;
  visualSummary: string;
  keyMoments: KeyMoment[];
  duration?: string;
  filename: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const FAST_MODEL = 'gemini-2.5-flash';
const MAX_VIDEO_SIZE = 100 * 1024 * 1024; // 100 MB
const FILE_POLL_INTERVAL_MS = 3000;
const FILE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export const SUPPORTED_VIDEO_MIMES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-msvideo',
  'video/mpeg',
  'video/3gpp',
];

export function isVideoMime(mime: string): boolean {
  return SUPPORTED_VIDEO_MIMES.includes(mime.toLowerCase());
}

// ── Video Analysis Prompt ────────────────────────────────────────────────────

const VIDEO_ANALYSIS_PROMPT = `You are analyzing a teaching/educational video. Provide a comprehensive analysis with THREE sections:

## TRANSCRIPTION
Transcribe ALL spoken audio from the video accurately. Include speaker changes if multiple speakers are present. Use timestamps (MM:SS) at the start of each paragraph or speaker change.

## VISUAL SUMMARY
Describe the key visual content throughout the video:
- Slide changes or presentation transitions
- Whiteboard/blackboard writing or drawing
- Demonstrations or hands-on activities
- Charts, diagrams, or figures shown
- Any text displayed on screen

Use timestamps (MM:SS) for each visual element or transition.

## KEY MOMENTS
List the most important moments/topic transitions in the video:
- **MM:SS** — Brief description of what happens

This should serve as a chapter list / table of contents for the video.`;

// ── Main Processing Function ─────────────────────────────────────────────────

/**
 * Process a video file: upload to Gemini File API, wait for processing,
 * then analyze with generateContent for transcription + visual summary.
 */
export async function processVideoMaterial(
  ai: GoogleGenAI,
  buf: Buffer,
  filename: string,
  mime: string,
  onProgress?: (stage: string, detail?: string) => void,
): Promise<VideoAnalysisResult> {
  if (buf.length > MAX_VIDEO_SIZE) {
    throw new Error(`Video too large (${Math.round(buf.length / 1024 / 1024)}MB). Maximum is ${MAX_VIDEO_SIZE / 1024 / 1024}MB.`);
  }

  // Step 1: Upload to File API
  onProgress?.('uploading', 'Uploading video to AI...');
  console.log(`[Video] Uploading ${filename} (${Math.round(buf.length / 1024 / 1024)}MB)...`);

  let fileUri: string;
  let fileName: string;
  try {
    const uploaded = await ai.files.upload({
      file: new Blob([new Uint8Array(buf)], { type: mime }),
      config: { displayName: filename },
    });
    fileUri = uploaded.uri!;
    fileName = uploaded.name!;
    console.log(`[Video] Uploaded: ${fileName}`);
  } catch (e: any) {
    throw new Error(`Failed to upload video: ${e.message}`);
  }

  // Step 2: Wait for File API to process
  onProgress?.('processing', 'Processing video...');
  console.log(`[Video] Waiting for File API processing...`);
  await waitForFileActive(ai, fileName, onProgress);

  // Step 3: Analyze with generateContent
  onProgress?.('analyzing', 'Analyzing video content...');
  console.log(`[Video] Running analysis...`);

  try {
    const gen = await ai.models.generateContent({
      model: FAST_MODEL,
      contents: [{
        role: 'user',
        parts: [
          { fileData: { fileUri, mimeType: mime } },
          { text: VIDEO_ANALYSIS_PROMPT },
        ],
      }],
    });

    const raw = (gen.text || '').trim();
    const result = parseVideoResponse(raw, filename);

    console.log(`[Video] Analysis complete for ${filename}: ${result.keyMoments.length} key moments found`);
    return result;
  } catch (e: any) {
    throw new Error(`Video analysis failed: ${e.message}`);
  }
}

// ── Format for Context ───────────────────────────────────────────────────────

/**
 * Convert a VideoAnalysisResult into a formatted context string
 * for the system instruction.
 */
export function formatVideoForContext(result: VideoAnalysisResult): string {
  const parts: string[] = [];

  parts.push(`## Video: ${result.filename}${result.duration ? ` (${result.duration})` : ''}`);

  if (result.transcription.trim()) {
    parts.push('### Transcription\n' + result.transcription.trim());
  }

  if (result.visualSummary.trim()) {
    parts.push('### Visual Summary\n' + result.visualSummary.trim());
  }

  if (result.keyMoments.length > 0) {
    const moments = result.keyMoments
      .map(m => `- **${m.timestamp}** — ${m.description}`)
      .join('\n');
    parts.push('### Key Moments\n' + moments);
  }

  return parts.join('\n\n');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseVideoResponse(raw: string, filename: string): VideoAnalysisResult {
  let transcription = '';
  let visualSummary = '';
  const keyMoments: KeyMoment[] = [];

  // Parse sections
  const transMatch = raw.match(/##\s*TRANSCRIPTION\s*\n([\s\S]*?)(?=##\s*VISUAL\s*SUMMARY|$)/i);
  const visualMatch = raw.match(/##\s*VISUAL\s*SUMMARY\s*\n([\s\S]*?)(?=##\s*KEY\s*MOMENTS|$)/i);
  const momentsMatch = raw.match(/##\s*KEY\s*MOMENTS\s*\n([\s\S]*?)$/i);

  if (transMatch) transcription = transMatch[1].trim();
  if (visualMatch) visualSummary = visualMatch[1].trim();

  if (momentsMatch) {
    const momentRegex = /\*\*(\d{1,2}:\d{2})\*\*\s*[—–-]\s*(.+)/g;
    let match;
    while ((match = momentRegex.exec(momentsMatch[1])) !== null) {
      keyMoments.push({ timestamp: match[1], description: match[2].trim() });
    }
  }

  // If parsing failed, use raw text as transcription
  if (!transcription && !visualSummary) {
    transcription = raw;
  }

  return { transcription, visualSummary, keyMoments, filename };
}

async function waitForFileActive(
  ai: GoogleGenAI,
  fileName: string,
  onProgress?: (stage: string, detail?: string) => void,
): Promise<void> {
  const start = Date.now();
  let lastLog = 0;

  while (Date.now() - start < FILE_TIMEOUT_MS) {
    try {
      const file = await ai.files.get({ name: fileName });

      if (file.state === 'ACTIVE') {
        console.log(`[Video] File is ACTIVE and ready`);
        return;
      }

      if (file.state === 'FAILED') {
        throw new Error(`File processing failed for ${fileName}`);
      }

      // Log progress periodically
      const elapsed = Math.round((Date.now() - start) / 1000);
      if (Date.now() - lastLog > 10000) {
        console.log(`[Video] Still processing... (${elapsed}s elapsed, state: ${file.state})`);
        onProgress?.('processing', `Processing video... (${elapsed}s)`);
        lastLog = Date.now();
      }
    } catch (e: any) {
      if (e.message?.includes('failed')) throw e;
      // Transient error, keep polling
    }

    await new Promise(r => setTimeout(r, FILE_POLL_INTERVAL_MS));
  }

  throw new Error(`Video processing timed out after ${FILE_TIMEOUT_MS / 1000}s`);
}
