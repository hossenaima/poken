/**
 * Learn Mode — plain-HTTP, stateless text generation (no Gemini Live, no WebSocket).
 * See docs/LEARN_MODE_PLAN.md. Explanations stream as SSE; Wikipedia intros inform them
 * in the background (never shown); /visual draws diagrams; /extras adds key terms and
 * suggested rabbit holes.
 *
 * Blocks are paragraphs, `###` subheads or lists: the model separates them with blank
 * lines and the client splits on those, then parses a closed allowlist of markdown
 * (bold, subheads, lists) — addressable enough for drag-select, so no structuring pass.
 */
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { Modality, Type } from '@google/genai';
import type { GoogleGenAI } from '@google/genai';
import { extractFromBuffer } from './materials-extract.js';
import { readPdf, analyzeImageWithVision, formatForContext } from './materials-vision.js';

const LEARN_MODEL = 'gemini-2.5-flash';
// Nano Banana 2. Compared on the same Calvin-cycle prompt (2026-09-19): 2.5-flash-image garbled
// labels ("ATP = + H+"); this one got every label and count right in ~9s; 3.1-flash-lite-image
// was ~3s but misplaced arrows. Diagrams teach, so accuracy wins.
const IMAGE_MODEL = 'gemini-3.1-flash-image';
const MAX_SELECTION_CHARS = 2_000;   // a highlight can span a few paragraphs
const MAX_LABEL_CHARS = 300;         // breadcrumb entries and questions
const MAX_CHAIN = 12;
const MAX_CONTEXT_CHARS = 6_000;
// Upload limits, both chosen for latency rather than capability. 8 MB is a long slide deck or a
// phone photo at full resolution; past that, vision analysis starts costing tens of seconds and
// the learner is left staring at a spinner before they have read a word. MAX_MATERIAL_CHARS then
// bounds what rides along on EVERY later explain call, so a big deck cannot slow the whole session.
const MAX_MATERIAL_BYTES = 8 * 1024 * 1024;
const MAX_MATERIAL_CHARS = 24_000;

type ChainLink = { selection: string };
type Source = { title: string; extract: string };

// ── Wikipedia sources (backend only) ──────────────────────────────────────────
// Not Google Search grounding: its terms forbid modifying, storing, nesting into or
// "learning from" grounded results, and Poken does all four (plan §Phase 3). Wikipedia
// intros go to the model as background; nothing about them reaches the browser.
const WIKI_LANG: Record<string, string> = {
  English: 'en', Spanish: 'es', French: 'fr', German: 'de', Portuguese: 'pt',
  Hindi: 'hi', Arabic: 'ar', 'Simplified Chinese': 'zh',
};
// Wikimedia blocks clients without an informative User-Agent with contact info.
const WIKI_UA = 'Poken/1.0 (https://github.com/poken-app/poken)';
const MAX_SOURCES = 3;

async function wikiPages(lang: string, params: Record<string, string>): Promise<any[]> {
  const qs = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', redirects: '1',
    prop: 'extracts|info|pageprops', ppprop: 'disambiguation', inprop: 'url',
    exintro: '1', explaintext: '1', exchars: '1500',
    ...(lang === 'zh' ? { variant: 'zh-cn' } : {}),
    ...params,
  });
  const res = await fetch(`https://${lang}.wikipedia.org/w/api.php?${qs}`, {
    headers: { 'User-Agent': WIKI_UA },
    signal: AbortSignal.timeout(4_000),
  });
  if (!res.ok) return [];
  const data: any = await res.json();
  return Array.isArray(data?.query?.pages) ? data.query.pages : [];
}

/** Up to 3 article intros for `query`: an exact title match first, then search results. Never throws. */
export async function wikipediaSources(query: string, language: string): Promise<Source[]> {
  const lang = WIKI_LANG[language] || 'en';
  const usable = (p: any) => !p.missing && !(p.pageprops && 'disambiguation' in p.pageprops) && p.extract?.trim() && p.fullurl;
  try {
    const [exact, search] = await Promise.allSettled([
      wikiPages(lang, { titles: query }),
      wikiPages(lang, { generator: 'search', gsrsearch: query, gsrlimit: '5' }),
    ]);
    const ranked = [
      ...(exact.status === 'fulfilled' ? exact.value : []),
      ...(search.status === 'fulfilled' ? search.value.sort((a, b) => (a.index ?? 99) - (b.index ?? 99)) : []),
    ];
    const seen = new Set<number>();
    const out: Source[] = [];
    for (const p of ranked) {
      if (!usable(p) || seen.has(p.pageid)) continue;
      seen.add(p.pageid);
      out.push({ title: p.title, extract: p.extract.trim() });
      if (out.length === MAX_SOURCES) break;
    }
    return out;
  } catch (err: any) {
    console.warn('[Poken][Learn] Wikipedia lookup failed:', err?.message ?? err);
    return [];   // explanations still work without sources
  }
}

// The learner's own upload. Unlike the Wikipedia block this is theirs, so it is authoritative
// about what they need to know: it sets the scope and vocabulary, and where it disagrees with
// general knowledge the explanation should follow it and say so rather than silently correcting.
function materialBlock(material: string): string {
  if (!material) return '';
  return `

The learner uploaded this material and wants to understand it:
${material}

Ground the explanation in this. Use its scope, its vocabulary and its notation, and explain the parts of it that matter rather than the topic in general. If it is incomplete, fill the gaps from your own knowledge. If something in it looks wrong, explain it the way the material has it and then say plainly what the accepted account is. Never mention "the material", "the upload", "the slides" or "the document" — the learner knows what they gave you; just explain the content.`;
}

// Background only: the learner never sees sources or links (product decision). That makes
// "own words" load-bearing — CC BY-SA needs attribution when its wording is reused, not when
// its facts inform original prose. Don't loosen the no-copying rule without adding credit.
function sourcesBlock(sources: Source[]): string {
  if (!sources.length) return '';
  return `

Background reference (for accuracy only):
${sources.map(s => `${s.title}: ${s.extract}`).join('\n\n')}

Use this only to keep your facts accurate. Explain entirely in your own words at the learner's level — never copy sentences or distinctive phrases from it. Ignore anything off-topic. Do not cite, number, link or mention it, and never say "Wikipedia", "sources" or "reference".`;
}

// Pedagogy after LearnLM's principles — but Learn Mode explains; Teach Mode tests.
// A Learn Mode that withholds answers would fight the teaching phase for the same job.
function systemInstruction(language: string): string {
  return `You are an expert explainer in a learn-by-teaching app. The learner reads your explanation, then teaches it to an AI student who will probe for gaps. Your job is to make the learner genuinely understand, so they can teach it.

Rules:
- Explain fully and directly. Do NOT quiz the learner, do NOT ask them questions, do NOT withhold information Socratically. The teaching phase is where they get tested.
- Break the concept into a clear sequence of ideas, one idea per paragraph. Lead with the core mechanism, then why it works, then a concrete example, then the edge or the common misunderstanding. Adapt this to the topic.
- Prefer mechanism over vocabulary. When a term is unavoidable, define it in the same sentence.
- Be precise. No filler, no motivational framing, no "great question".
- Write in ${language}.

Format — structure the page so it can be *scanned*, not just read. An unbroken wall of paragraphs is the failure mode to avoid. Let the shape of the content pick the device:

- **Paragraphs**: one idea each, 2–4 sentences, separated by a blank line. Vary their length — a one-sentence paragraph lands a key point hard. This is still the backbone; the devices below punctuate it, they do not replace it.
- **Bold** with **asterisks** for the terms and figures the learner must carry away — typically one per paragraph, at the moment the term is introduced or defined. Enough that scanning only the bold gives the spine of the idea. Not whole sentences, and not so much that nothing stands out.
- *Italics* with single *asterisks* for a term being named as a term, a contrast being drawn, or light emphasis mid-sentence.
- **"### " subheadings** when the explanation has two or more genuinely distinct parts — a mechanism and its exceptions, before and after, three named stages. Two to four words each. Never any heading level other than ###.
- **Lists** ("- " bullets, or "1. " when order truly matters) when you are enumerating parallel things. Three or more items, each a phrase or one sentence. If the items are really prose, write prose.
- **Tables** when you are comparing two or more things across two or more dimensions — that is exactly what a table is for, and it beats three paragraphs of "whereas". Pipe syntax with a header row: \`| Thing | Dimension |\` then \`|---|---|\` then the rows. Keep cells to a few words. Three to five rows. Never a table for a single thing's properties: that is a list.
- **Blockquotes** ("> " on its own line) only for a genuine quotation, definition or principle worth pausing on — it renders centred and set apart, so it must earn that weight. At most one per explanation, and often none.

- **Math**: every equation, formula or derivation step goes in its own display block — \`$$\` on a line by itself, the LaTeX, then \`$$\` on a line by itself — never inside a sentence. One equation per line inside the block; a derivation is several lines, one step each. Introduce the block in the sentence before it and explain it in the sentence after. In prose, name a single symbol in plain text or Unicode (x, v₀, Δt, θ) — no \`$\` delimiters mid-sentence.
- **Code**: only when the topic is genuinely about programming or a precise procedure. Put it in a fenced block with its language — \`\`\`python\` on its own line, the code, then \`\`\`\` on its own line — never inline in a sentence. Keep each block short and focused on one idea, and explain it in prose around it.

Never use every device in one explanation; reach for a device only where it genuinely fits the content, and let the rest be clean prose. No emoji, no links.
- No preamble and no closing summary line.`;
}

function userPrompt(topic: string, chain: ChainLink[], selection: string, parentText: string, question: string, simplify: boolean): string {
  // A follow-up typed into the box under the page: about the topic, not about a highlight.
  if (question && !chain.length) {
    return `The learner is studying "${topic}".${parentText ? `

What has been explained to them so far (for context — do not restate it):
"""
${parentText}
"""` : ''}

They asked this follow-up question:
"""
${question}
"""

Answer it directly: the first sentence is the answer, then explain why. Connect it to what they have already covered where that genuinely helps, but do not re-summarize it. Keep it to what the question needs (2–5 paragraphs). If it drifts from the topic, answer it anyway, briefly.`;
  }
  if (!chain.length) {
    return `Explain "${topic}" so that someone could teach it to a curious student.`;
  }
  const trail = [topic, ...chain.map(c => c.selection)].join(' → ');
  const context = `The learner is studying "${topic}". They have gone deeper along this trail: ${trail}.

The text they were reading (for context — do not restate it):
"""
${parentText}
"""

They highlighted this span:
"""
${selection}
"""`;
  if (question) {
    return `${context}

About that span, they asked:
"""
${question}
"""

Answer their question directly: the first sentence is the answer, then explain why, grounded in the highlighted span. Keep it to what the question needs (2–4 paragraphs). Do not re-summarize the parent paragraph or the broader topic. Never refer to "the highlighted text", "the selection" or "the passage" — just answer as if they asked you in conversation.`;
  }
  if (simplify) {
    return `${context}

They found that span hard to follow. Re-explain what it means in much simpler words, as if to a curious 12-year-old: no jargon (or define it in plain words), one concrete everyday analogy, short sentences. 1–3 short paragraphs. Keep it accurate — simpler, not wrong. Never refer to "the highlighted text" or "the passage".`;
  }
  return `${context}

They want to go deeper on exactly that span. Explain the selected idea in depth: its mechanism, why it is the case, and where it breaks or is commonly misunderstood. Do not re-summarize the parent paragraph or the broader topic. Assume everything on the trail is already understood.`;
}

function clean(s: unknown, max: number): string {
  return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

export function registerLearnRoutes(app: Hono, ai: GoogleGenAI, normalizeLanguage: (raw: string | null) => string): void {
  // POST { topic, language, chain?: [{selection}], selection?, parentText?, question?, mode? }
  // question: "Ask" on a highlight — answers it instead of a generic deep-dive. With an empty
  // chain it is a follow-up about the whole topic, and parentText carries what was covered.
  // mode: 'simplify' re-explains the highlight in plain words.
  // → SSE: data: {"text": "..."} chunks, then data: {"done": true}
  app.post('/api/learn/explain', async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

    const topic = clean(body?.topic, 200);
    if (!topic) return c.json({ error: 'topic required' }, 400);
    const language = normalizeLanguage(body?.language ?? null);
    const chain: ChainLink[] = (Array.isArray(body?.chain) ? body.chain : [])
      .slice(-MAX_CHAIN)
      .map((l: any) => ({ selection: clean(l?.selection, MAX_LABEL_CHARS) }))
      .filter((l: ChainLink) => l.selection);
    const selection = clean(body?.selection, MAX_SELECTION_CHARS);
    const parentText = typeof body?.parentText === 'string' ? body.parentText.trim().slice(0, MAX_CONTEXT_CHARS) : '';
    const question = clean(body?.question, MAX_LABEL_CHARS * 2);
    const simplify = body?.mode === 'simplify';
    // Text pulled out of an uploaded slide deck, PDF or photo by /api/learn/material. The
    // client holds it and sends it back, so the server stays stateless like the rest of Learn.
    const material = typeof body?.material === 'string' ? body.material.trim().slice(0, MAX_MATERIAL_CHARS) : '';
    if (chain.length && !selection) return c.json({ error: 'selection required when chain is non-empty' }, 400);
    // A question with no chain is a follow-up about the whole topic; simplify always needs a span.
    if (simplify && !chain.length) return c.json({ error: 'simplify requires a selection' }, 400);

    return streamSSE(c, async (stream) => {
      try {
        // Sources: the topic for a root explanation, the highlighted span for a branch (a question
        // is usually a poor search query; the span it's about is a good one). Simplify re-words
        // what's already on screen, so it skips the lookup.
        let sources: Source[] = [];
        if (!simplify) {
          // A multi-paragraph highlight is a poor search query (and Wikipedia rejects >300 chars).
          const query = chain.length && selection.length <= 120 ? selection : topic;
          sources = await wikipediaSources(query, language);
          if (!sources.length && chain.length) sources = await wikipediaSources(topic, language);
        }

        const result = await ai.models.generateContentStream({
          model: LEARN_MODEL,
          contents: [{ role: 'user', parts: [{ text: userPrompt(topic, chain, selection, parentText, question, simplify) + materialBlock(material) + sourcesBlock(sources) }] }],
          config: { systemInstruction: systemInstruction(language) },
        });
        for await (const chunk of result) {
          const text = chunk.text;
          if (text) await stream.writeSSE({ data: JSON.stringify({ text }) });
        }
        await stream.writeSSE({ data: JSON.stringify({ done: true }) });
      } catch (err: any) {
        console.error('[Poken][Learn] explain failed:', err?.message ?? err);
        await stream.writeSSE({ data: JSON.stringify({ error: 'Explanation failed. Try again.' }) });
      }
    });
  });

  // "Get images": POST { topic, selection, parentText } → { base64, mimeType }
  app.post('/api/learn/visual', async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    const topic = clean(body?.topic, 200);
    const selection = clean(body?.selection, 600);   // an image prompt needs the idea, not paragraphs
    const parentText = typeof body?.parentText === 'string' ? body.parentText.trim().slice(0, 2_000) : '';
    if (!topic || !selection) return c.json({ error: 'topic and selection required' }, 400);
    const prompt = `Draw a clear, accurate educational diagram that explains "${selection}" (topic: ${topic}).
Context it appeared in: ${parentText}
Style: clean flat-vector textbook illustration on a white background, simple shapes, arrows showing flow or cause and effect, a few short legible labels in English. No title banner, no decorative clutter, no photorealism.`;
    try {
      const result = await ai.models.generateContent({
        model: IMAGE_MODEL,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { responseModalities: [Modality.TEXT, Modality.IMAGE] },
      });
      const part = result.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data);
      if (!part?.inlineData?.data) return c.json({ error: 'No image came back. Try a different phrase.' }, 502);
      return c.json({ base64: part.inlineData.data, mimeType: part.inlineData.mimeType || 'image/png' });
    } catch (err: any) {
      console.error('[Poken][Learn] visual failed:', err?.message ?? err);
      return c.json({ error: 'Image generation failed. Try again.' }, 502);
    }
  });

  // Key terms (hover glosses) + suggested rabbit holes for a finished explanation.
  // POST { topic, text, language } → { keyTerms: [{term, gloss}], suggestions: [string] }
  // Upload a slide deck, PDF or photo and get its content back as text. One call per file; the
  // client keeps the text and passes it to /explain, so Learn Mode stays stateless.
  app.post('/api/learn/material', async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

    const name = clean(body?.name, 200) || 'upload';
    const mimeType = clean(body?.mimeType, 100) || 'application/octet-stream';
    const base64 = typeof body?.base64 === 'string' ? body.base64 : '';
    if (!base64) return c.json({ error: 'file required' }, 400);

    // Check the size before decoding: base64 is ~4/3 of the bytes it encodes, so this rejects an
    // oversized upload without ever materialising it in memory.
    const approxBytes = Math.floor(base64.length * 3 / 4);
    if (approxBytes > MAX_MATERIAL_BYTES) {
      return c.json({ error: `That file is ${(approxBytes / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_MATERIAL_BYTES / 1024 / 1024} MB, so reading it doesn't hold up your first explanation.` }, 413);
    }

    let buf: Buffer;
    try { buf = Buffer.from(base64, 'base64'); } catch { return c.json({ error: 'Could not read that file' }, 400); }
    if (!buf.length) return c.json({ error: 'That file is empty' }, 400);

    const isPdf = mimeType === 'application/pdf' || /\.pdf$/i.test(name);
    const isImage = mimeType.startsWith('image/');
    const started = Date.now();
    try {
      let text = '';
      if (isPdf) {
        text = formatForContext(await readPdf(ai, buf, name));
      } else if (isImage) {
        text = formatForContext(await analyzeImageWithVision(ai, buf, mimeType, name));
      } else {
        // Slides, docs and plain text: the same extractor the teaching session uses.
        const { text: extracted, error } = await extractFromBuffer(buf, mimeType, name);
        if (!extracted.trim() && error) return c.json({ error }, 422);
        text = extracted;
      }
      const trimmed = text.trim().slice(0, MAX_MATERIAL_CHARS);
      if (!trimmed) return c.json({ error: 'Nothing readable in that file' }, 422);
      console.log(`[Poken][Learn] material ${name} (${(approxBytes / 1024).toFixed(0)}KB) -> ${trimmed.length} chars in ${Date.now() - started}ms`);
      return c.json({ name, chars: trimmed.length, truncated: text.trim().length > MAX_MATERIAL_CHARS, text: trimmed });
    } catch (e: any) {
      console.error(`[Poken][Learn] material ${name} failed:`, e?.message);
      return c.json({ error: 'Could not read that file' }, 422);
    }
  });

  app.post('/api/learn/extras', async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    const topic = clean(body?.topic, 200);
    const text = typeof body?.text === 'string' ? body.text.trim().slice(0, MAX_CONTEXT_CHARS) : '';
    const language = normalizeLanguage(body?.language ?? null);
    if (!topic || !text) return c.json({ error: 'topic and text required' }, 400);
    try {
      const result = await ai.models.generateContent({
        model: LEARN_MODEL,
        contents: [{ role: 'user', parts: [{ text: `A learner studying "${topic}" just read this explanation:
"""
${text}
"""

1. keyTerms: the 3–6 technical terms in it a learner would most need defined. Each "term" must be copied EXACTLY as it appears in the explanation (same spelling and case). Each "gloss" is a plain-language definition of at most 15 words, written in ${language}.
2. suggestions: 3 short (2–6 word) follow-up topics worth going deeper on next, that the explanation mentions or implies but does not fully explain. Written in ${language}.` }] }],
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              keyTerms: {
                type: Type.ARRAY,
                items: { type: Type.OBJECT, properties: { term: { type: Type.STRING }, gloss: { type: Type.STRING } }, required: ['term', 'gloss'] },
              },
              suggestions: { type: Type.ARRAY, items: { type: Type.STRING } },
            },
            required: ['keyTerms', 'suggestions'],
          },
        },
      });
      const parsed = JSON.parse(result.text || '{}');
      // Only terms that really occur in the text can be highlighted.
      const keyTerms = (Array.isArray(parsed.keyTerms) ? parsed.keyTerms : [])
        .filter((k: any) => typeof k?.term === 'string' && typeof k?.gloss === 'string' && text.toLowerCase().includes(k.term.toLowerCase()))
        .slice(0, 6)
        .map((k: any) => ({ term: k.term.slice(0, 80), gloss: k.gloss.slice(0, 200) }));
      const suggestions = (Array.isArray(parsed.suggestions) ? parsed.suggestions : [])
        .filter((s: any) => typeof s === 'string' && s.trim())
        .slice(0, 3)
        .map((s: string) => s.trim().slice(0, 80));
      return c.json({ keyTerms, suggestions });
    } catch (err: any) {
      console.error('[Poken][Learn] extras failed:', err?.message ?? err);
      return c.json({ keyTerms: [], suggestions: [] });   // extras are optional; never break the page
    }
  });
}
