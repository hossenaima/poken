/**
 * Extract plain text from PDF, PPTX, text files; optional image OCR via Gemini.
 */
import JSZip from 'jszip';
// pdf-parse is imported lazily: its pdfjs-dist dependency throws at import time when
// the optional native @napi-rs/canvas is absent (no DOMMatrix). Gemini vision is the primary
// PDF path; this text extraction is only the fallback, so it must never take the process down.

const MAX_FILE_BYTES = 12 * 1024 * 1024; // 12 MB
const MAX_EXTRACT_CHARS = 120_000; // keep URL param safe

function truncate(s: string): string {
  const t = s.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (t.length <= MAX_EXTRACT_CHARS) return t;
  return t.slice(0, MAX_EXTRACT_CHARS) + '\n\n[… truncated …]';
}

export async function extractFromBuffer(
  buf: Buffer,
  mime: string,
  filename: string,
): Promise<{ text: string; error?: string }> {
  const lower = filename.toLowerCase();
  if (buf.length > MAX_FILE_BYTES) {
    return { text: '', error: 'File too large (max 12 MB).' };
  }

  // Plain text
  if (
    mime.startsWith('text/') ||
    lower.endsWith('.txt') ||
    lower.endsWith('.md') ||
    lower.endsWith('.csv')
  ) {
    try {
      const text = buf.toString('utf-8');
      return { text: truncate(text) };
    } catch {
      return { text: '', error: 'Could not read as UTF-8 text.' };
    }
  }

  // PDF — pdf-parse v2+ uses PDFParse class (default export is no longer a function)
  if (mime === 'application/pdf' || lower.endsWith('.pdf')) {
    let parser: { getText(): Promise<{ text?: string }>; destroy(): Promise<void> } | null = null;
    try {
      const { PDFParse } = await import('pdf-parse');
      parser = new PDFParse({ data: new Uint8Array(buf) });
      const textResult = await parser.getText();
      const text = textResult?.text ?? '';
      return { text: truncate(text) };
    } catch (e) {
      return { text: '', error: e instanceof Error ? e.message : 'PDF parse failed.' };
    } finally {
      if (parser) {
        try {
          await parser.destroy();
        } catch {
          /* ignore */
        }
      }
    }
  }

  // PPTX (zip with ppt/slides/slide*.xml)
  if (
    mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    lower.endsWith('.pptx')
  ) {
    try {
      const zip = await JSZip.loadAsync(buf);
      const parts: string[] = [];
      const names = Object.keys(zip.files).filter(
        n => /^ppt\/slides\/slide\d+\.xml$/i.test(n) && !zip.files[n].dir,
      );
      names.sort((a, b) => {
        const na = parseInt(a.replace(/\D/g, ''), 10) || 0;
        const nb = parseInt(b.replace(/\D/g, ''), 10) || 0;
        return na - nb;
      });
      for (const name of names) {
        const xml = await zip.files[name].async('string');
        // PowerPoint stores text in <a:t>...</a:t> and similar
        const chunks = xml.match(/<a:t[^>]*>([^<]*)<\/a:t>/g) || [];
        for (const c of chunks) {
          const inner = c.replace(/<[^>]+>/g, '').trim();
          if (inner) parts.push(inner);
        }
      }
      const text = parts.join('\n');
      if (!text.trim()) return { text: '', error: 'No text found in slides (may be image-only).' };
      return { text: truncate(text) };
    } catch (e) {
      return { text: '', error: e instanceof Error ? e.message : 'PPTX parse failed.' };
    }
  }

  return {
    text: '',
    error: `Unsupported type (${mime || 'unknown'}). Use PDF, PPTX, TXT, or MD — or paste text.`,
  };
}
