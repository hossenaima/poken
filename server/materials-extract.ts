/**
 * Extract plain text from PDF, PPTX, text files; optional image OCR via Gemini.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
// pdf-parse is never imported into the server: it runs in its own process (pdf-text-worker.mjs),
// so neither its memory nor a crash on a bad PDF can take the server down. See pdfTextLayer.

const MAX_FILE_BYTES = 12 * 1024 * 1024; // 12 MB
const MAX_EXTRACT_CHARS = 120_000;

function truncate(s: string): string {
  const t = s.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (t.length <= MAX_EXTRACT_CHARS) return t;
  return t.slice(0, MAX_EXTRACT_CHARS) + '\n\n[… truncated …]';
}

const PDF_WORKER = fileURLToPath(new URL('./pdf-text-worker.mjs', import.meta.url));
const PDF_WORKER_TIMEOUT_MS = 30_000;

/**
 * The PDF's own embedded text and its page count, read locally. Rejects if the file won't parse.
 * Runs in a separate plain-node process (server/pdf-text-worker.mjs), never inside the server:
 * under tsx, pdfjs used ~510 MB for an 8-page handout and Cloud Run killed the container. Plain
 * node needs ~75 MB, freed when the child exits. The heap cap and timeout mean a pathological PDF
 * kills only the child, and the caller falls back to vision.
 */
export function pdfTextLayer(buf: Buffer): Promise<{ text: string; pages: number }> {
  return new Promise((resolve, reject) => {
    // spawn, not fork: nothing of the parent's tsx loader flags is inherited.
    const child = spawn(process.execPath, ['--max-old-space-size=256', PDF_WORKER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    const timer = setTimeout(() => child.kill('SIGKILL'), PDF_WORKER_TIMEOUT_MS);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        const why = Buffer.concat(err).toString().trim().split('\n').pop() || '';
        return reject(new Error(`PDF text worker ${signal ? `killed (${signal})` : `exited ${code}`}${why ? `: ${why}` : ''}`));
      }
      try { resolve(JSON.parse(Buffer.concat(out).toString())); } catch (e) { reject(e); }
    });
    child.stdin.on('error', () => { /* the child can exit before reading all of it; 'close' reports why */ });
    child.stdin.end(buf);
  });
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

  // PDF
  if (mime === 'application/pdf' || lower.endsWith('.pdf')) {
    try {
      return { text: truncate((await pdfTextLayer(buf)).text) };
    } catch (e) {
      return { text: '', error: e instanceof Error ? e.message : 'PDF parse failed.' };
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
