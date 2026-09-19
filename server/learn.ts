/**
 * Learn Mode — plain-HTTP, stateless text generation (no Gemini Live, no WebSocket).
 * See docs/LEARN_MODE_PLAN.md. Phase 1: `start` and `deeper`, streamed as SSE.
 *
 * Blocks are paragraphs: the model writes prose separated by blank lines and the
 * client splits on them. The typed-block structuring pass arrives with web sources
 * (Phase 3); until then paragraphs are addressable enough for drag-select.
 */
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { GoogleGenAI } from '@google/genai';

const LEARN_MODEL = 'gemini-2.5-flash';
const MAX_SELECTION_CHARS = 600;
const MAX_CHAIN = 12;
const MAX_CONTEXT_CHARS = 6_000;

type ChainLink = { selection: string };

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

Format (strict):
- Plain prose paragraphs separated by one blank line. Aim for 4–7 paragraphs, each 2–5 sentences.
- No markdown: no headings, no bullet lists, no bold, no code fences.
- No preamble and no closing summary line.`;
}

function userPrompt(topic: string, chain: ChainLink[], selection: string, parentText: string, question: string): string {
  if (!chain.length) {
    return `Explain "${topic}" so that someone could teach it to a curious student.`;
  }
  const trail = [topic, ...chain.map(c => c.selection)].join(' → ');
  const context = `The learner is studying "${topic}". They have gone deeper along this trail: ${trail}.

The paragraph they were reading (for context — do not restate it):
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
  return `${context}

They want to go deeper on exactly that span. Explain the selected idea in depth: its mechanism, why it is the case, and where it breaks or is commonly misunderstood. Do not re-summarize the parent paragraph or the broader topic. Assume everything on the trail is already understood.`;
}

function clean(s: unknown, max: number): string {
  return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

export function registerLearnRoutes(app: Hono, ai: GoogleGenAI, normalizeLanguage: (raw: string | null) => string): void {
  // POST { topic, language, chain?: [{selection}], selection?, parentText?, question? }
  // question: "Ask" on a highlight — answers it instead of a generic deep-dive.
  // → SSE: data: {"text": "..."} chunks, then data: {"done": true}
  app.post('/api/learn/explain', async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

    const topic = clean(body?.topic, 200);
    if (!topic) return c.json({ error: 'topic required' }, 400);
    const language = normalizeLanguage(body?.language ?? null);
    const chain: ChainLink[] = (Array.isArray(body?.chain) ? body.chain : [])
      .slice(-MAX_CHAIN)
      .map((l: any) => ({ selection: clean(l?.selection, MAX_SELECTION_CHARS) }))
      .filter((l: ChainLink) => l.selection);
    const selection = clean(body?.selection, MAX_SELECTION_CHARS);
    const parentText = typeof body?.parentText === 'string' ? body.parentText.trim().slice(0, MAX_CONTEXT_CHARS) : '';
    const question = clean(body?.question, MAX_SELECTION_CHARS);
    if (chain.length && !selection) return c.json({ error: 'selection required when chain is non-empty' }, 400);
    if (question && !chain.length) return c.json({ error: 'question requires a selection' }, 400);

    return streamSSE(c, async (stream) => {
      try {
        const result = await ai.models.generateContentStream({
          model: LEARN_MODEL,
          contents: [{ role: 'user', parts: [{ text: userPrompt(topic, chain, selection, parentText, question) }] }],
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
}
