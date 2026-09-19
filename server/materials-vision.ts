/**
 * Native Gemini Vision analysis for PDFs, images, and documents.
 * Replaces text-only pdf-parse extraction with multimodal understanding
 * that preserves diagrams, charts, figures, equations, and layout context.
 */
import type { GoogleGenAI } from '@google/genai';

// ── Types ────────────────────────────────────────────────────────────────────

export interface VisualElement {
  page?: number;
  label: string;
  type: 'figure' | 'chart' | 'table' | 'equation' | 'diagram' | 'photo' | 'other';
  description: string;
}

export interface VisionAnalysisResult {
  text: string;
  visualElements: VisualElement[];
  conceptMap?: string;
  pageCount?: number;
  filename: string;
  type: 'pdf' | 'image' | 'text' | 'pptx';
}

// ── Constants ────────────────────────────────────────────────────────────────

const FAST_MODEL = 'gemini-2.5-flash';
const MAX_INLINE_PDF_MB = 20;
const CHUNK_PAGES = 10;
const MAX_CONCURRENT = 3;

// ── PDF Vision Analysis ─────────────────────────────────────────────────────

const PDF_ANALYSIS_PROMPT = `You are analyzing a teaching/study document. Provide a comprehensive analysis with TWO sections:

## TEXT CONTENT
Extract ALL text content from this document, preserving:
- Headings and section structure
- Bullet points and numbered lists
- Key terms, definitions, and formulas
- Any captions or labels

## VISUAL ELEMENTS
For EVERY figure, chart, diagram, table, equation, or image in the document, provide:
- **[Type] Label (Page N):** Detailed description

Types: Figure, Chart, Table, Equation, Diagram, Photo

For charts: describe axes, data trends, and key data points.
For diagrams: describe the relationships, flows, or structures shown.
For tables: describe column headers and summarize the data.
For equations: write out the equation in text form.

If there are no visual elements, write "No visual elements found."

Be thorough — a student should be able to understand and reference any visual element from your description alone.`;

const PDF_CONTEXT_PROMPT = `You previously extracted content from a teaching document. Now analyze the relationships:

1. **Concept Outline:** Create a hierarchical topic outline of the document's content.
2. **Cross-References:** How do visual elements relate to text sections? (e.g., "Figure 3 illustrates the concept in Section 2.1")
3. **Key Questions:** What questions might a student ask about the visual content?

Keep it concise but thorough. Format as plain text with clear headings.`;

/**
 * Analyze a PDF using Gemini's native vision — sees text, images, charts, equations.
 */
export async function analyzePdfWithVision(
  ai: GoogleGenAI,
  buf: Buffer,
  filename: string,
): Promise<VisionAnalysisResult> {
  const b64 = buf.toString('base64');
  const sizeMB = buf.length / (1024 * 1024);

  let fileUri: string | undefined;

  // For large PDFs, use File API instead of inline
  if (sizeMB > MAX_INLINE_PDF_MB) {
    try {
      const uploaded = await ai.files.upload({
        file: new Blob([new Uint8Array(buf)], { type: 'application/pdf' }),
        config: { displayName: filename },
      });
      fileUri = uploaded.uri;
      // Wait for processing
      await waitForFileActive(ai, uploaded.name!);
    } catch (e) {
      console.error('[Vision] File API upload failed, falling back to inline:', e);
      // Fall through to inline attempt
    }
  }

  const parts: any[] = [];
  if (fileUri) {
    parts.push({ fileData: { fileUri, mimeType: 'application/pdf' } });
  } else {
    parts.push({ inlineData: { mimeType: 'application/pdf', data: b64 } });
  }
  parts.push({ text: PDF_ANALYSIS_PROMPT });

  try {
    const gen = await ai.models.generateContent({
      model: FAST_MODEL,
      contents: [{ role: 'user', parts }],
    });

    const raw = (gen.text || '').trim();
    const { text, visualElements } = parseVisionResponse(raw);

    return {
      text: text || raw,
      visualElements,
      filename,
      type: 'pdf',
    };
  } catch (e: any) {
    console.error(`[Vision] PDF analysis failed for ${filename}:`, e.message);
    return { text: '', visualElements: [], filename, type: 'pdf' };
  }
}

/**
 * For very large PDFs (30+ pages), chunk and process in parallel.
 */
export async function analyzePdfChunked(
  ai: GoogleGenAI,
  buf: Buffer,
  filename: string,
  pageCount: number,
): Promise<VisionAnalysisResult> {
  const totalChunks = Math.ceil(pageCount / CHUNK_PAGES);
  const chunks: { start: number; end: number }[] = [];

  for (let i = 0; i < totalChunks; i++) {
    chunks.push({
      start: i * CHUNK_PAGES + 1,
      end: Math.min((i + 1) * CHUNK_PAGES, pageCount),
    });
  }

  // Process with concurrency limiter
  const results: VisionAnalysisResult[] = [];
  for (let i = 0; i < chunks.length; i += MAX_CONCURRENT) {
    const batch = chunks.slice(i, i + MAX_CONCURRENT);
    const batchResults = await Promise.allSettled(
      batch.map(async (range) => {
        const chunkPrompt = `${PDF_ANALYSIS_PROMPT}\n\nIMPORTANT: Focus ONLY on pages ${range.start} through ${range.end}. Ignore content outside this range.`;
        const b64 = buf.toString('base64');

        const gen = await ai.models.generateContent({
          model: FAST_MODEL,
          contents: [{
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'application/pdf', data: b64 } },
              { text: chunkPrompt },
            ],
          }],
        });

        const raw = (gen.text || '').trim();
        const { text, visualElements } = parseVisionResponse(raw);
        return { text, visualElements, pageRange: range };
      })
    );

    for (const r of batchResults) {
      if (r.status === 'fulfilled') {
        results.push({
          text: r.value.text,
          visualElements: r.value.visualElements,
          filename,
          type: 'pdf',
        });
      }
    }
  }

  // Merge all chunks
  const mergedText = results.map(r => r.text).filter(Boolean).join('\n\n');
  const mergedVisuals = results.flatMap(r => r.visualElements);

  return {
    text: mergedText,
    visualElements: mergedVisuals,
    pageCount,
    filename,
    type: 'pdf',
  };
}

// ── Image Vision Analysis ────────────────────────────────────────────────────

const IMAGE_ANALYSIS_PROMPT = `Analyze this image comprehensively for a teaching context:

1. **Text Content:** Extract ALL readable text (printed, handwritten, labels, captions).
2. **Visual Description:** Describe what the image shows in detail.
3. **Educational Context:** If this is a chart, diagram, graph, table, or educational figure:
   - For charts/graphs: describe axes, data trends, key data points
   - For diagrams: describe relationships, flows, structures
   - For tables: describe columns and summarize data
   - For equations/formulas: write them out in text
   - For photos: describe the subject and any educational relevance

Format your response with clear section headers.`;

/**
 * Analyze an image using Gemini vision — full visual understanding, not just OCR.
 */
export async function analyzeImageWithVision(
  ai: GoogleGenAI,
  buf: Buffer,
  mimeType: string,
  filename: string,
): Promise<VisionAnalysisResult> {
  if (buf.length > 50 * 1024 * 1024) {
    return { text: `[Image too large: ${filename}]`, visualElements: [], filename, type: 'image' };
  }

  const b64 = buf.toString('base64');
  const mime = mimeType || 'image/jpeg';

  try {
    const gen = await ai.models.generateContent({
      model: FAST_MODEL,
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: mime, data: b64 } },
          { text: IMAGE_ANALYSIS_PROMPT },
        ],
      }],
    });

    const raw = (gen.text || '').trim();
    if (!raw || raw === '[no text]') {
      return { text: `[Image: ${filename} — no extractable content]`, visualElements: [], filename, type: 'image' };
    }

    // Detect visual element type from content
    const visualElements: VisualElement[] = [];
    const lowerRaw = raw.toLowerCase();
    let elementType: VisualElement['type'] = 'other';
    if (lowerRaw.includes('chart') || lowerRaw.includes('graph')) elementType = 'chart';
    else if (lowerRaw.includes('diagram') || lowerRaw.includes('flow')) elementType = 'diagram';
    else if (lowerRaw.includes('table')) elementType = 'table';
    else if (lowerRaw.includes('equation') || lowerRaw.includes('formula')) elementType = 'equation';
    else if (lowerRaw.includes('photo') || lowerRaw.includes('photograph')) elementType = 'photo';
    else elementType = 'figure';

    visualElements.push({
      label: filename,
      type: elementType,
      description: raw.slice(0, 500),
    });

    return { text: raw, visualElements, filename, type: 'image' };
  } catch (e: any) {
    console.error(`[Vision] Image analysis failed for ${filename}:`, e.message);
    return { text: `[Could not analyze image: ${filename}]`, visualElements: [], filename, type: 'image' };
  }
}

// ── Phase 2: Contextual Understanding ────────────────────────────────────────

/**
 * Second-pass analysis: generate concept map and cross-references
 * from an already-extracted vision result.
 */
export async function generateContextualUnderstanding(
  ai: GoogleGenAI,
  result: VisionAnalysisResult,
): Promise<string> {
  if (!result.text.trim()) return '';

  // Only run Phase 2 if there's substantial content
  if (result.text.length < 200) return '';

  const contentSummary = result.text.slice(0, 8000); // Keep prompt reasonable
  const visualList = result.visualElements
    .map(v => `- [${v.type}] ${v.label}: ${v.description.slice(0, 150)}`)
    .join('\n');

  try {
    const gen = await ai.models.generateContent({
      model: FAST_MODEL,
      contents: [{
        role: 'user',
        parts: [{
          text: `${PDF_CONTEXT_PROMPT}\n\n## Document Text (excerpt)\n${contentSummary}\n\n## Visual Elements Found\n${visualList || 'None'}`,
        }],
      }],
    });

    return (gen.text || '').trim();
  } catch (e: any) {
    console.error(`[Vision] Contextual understanding failed for ${result.filename}:`, e.message);
    return '';
  }
}

// ── Format for System Instruction Context ────────────────────────────────────

/**
 * Convert a VisionAnalysisResult into a formatted context string
 * suitable for injecting into a Gemini Live session's system instruction.
 */
export function formatForContext(result: VisionAnalysisResult): string {
  const parts: string[] = [];

  const header = result.pageCount
    ? `## Document: ${result.filename} (${result.pageCount} pages)`
    : `## Document: ${result.filename}`;
  parts.push(header);

  if (result.text.trim()) {
    parts.push('### Content\n' + result.text.trim());
  }

  if (result.visualElements.length > 0) {
    const visualParts = result.visualElements.map(v => {
      const pageNote = v.page ? ` (page ${v.page})` : '';
      return `- **[${v.type.toUpperCase()}] ${v.label}${pageNote}:** ${v.description}`;
    });
    parts.push('### Visual Elements\n' + visualParts.join('\n'));
  }

  if (result.conceptMap) {
    parts.push('### Concept Map & Cross-References\n' + result.conceptMap);
  }

  return parts.join('\n\n');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseVisionResponse(raw: string): { text: string; visualElements: VisualElement[] } {
  const visualElements: VisualElement[] = [];
  let textSection = '';
  let visualSection = '';

  // Split into text content and visual elements sections
  const textMatch = raw.match(/##\s*TEXT\s*CONTENT\s*\n([\s\S]*?)(?=##\s*VISUAL\s*ELEMENTS|$)/i);
  const visualMatch = raw.match(/##\s*VISUAL\s*ELEMENTS\s*\n([\s\S]*?)$/i);

  if (textMatch) {
    textSection = textMatch[1].trim();
  } else {
    textSection = raw;
  }

  if (visualMatch) {
    visualSection = visualMatch[1].trim();
    // Parse visual elements: **[Type] Label (Page N):** Description
    const elementRegex = /\*\*\[(\w+)\]\s*([^(]+?)(?:\(Page\s*(\d+)\))?\s*:\*\*\s*(.+)/gi;
    let match;
    while ((match = elementRegex.exec(visualSection)) !== null) {
      const typeStr = match[1].toLowerCase();
      let type: VisualElement['type'] = 'other';
      if (typeStr.includes('figure')) type = 'figure';
      else if (typeStr.includes('chart') || typeStr.includes('graph')) type = 'chart';
      else if (typeStr.includes('table')) type = 'table';
      else if (typeStr.includes('equation') || typeStr.includes('formula')) type = 'equation';
      else if (typeStr.includes('diagram')) type = 'diagram';
      else if (typeStr.includes('photo')) type = 'photo';

      visualElements.push({
        page: match[3] ? parseInt(match[3], 10) : undefined,
        label: match[2].trim(),
        type,
        description: match[4].trim(),
      });
    }
  }

  return { text: textSection, visualElements };
}

async function waitForFileActive(ai: GoogleGenAI, fileName: string, timeoutMs = 300_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const file = await ai.files.get({ name: fileName });
      if (file.state === 'ACTIVE') return;
      if (file.state === 'FAILED') throw new Error(`File processing failed: ${fileName}`);
    } catch (e: any) {
      if (e.message?.includes('failed')) throw e;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`File processing timed out after ${timeoutMs / 1000}s: ${fileName}`);
}
