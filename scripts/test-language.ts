// Runnable check for the language-switch and cleanup-guard helpers:
//   npx tsx --env-file=.env scripts/test-language.ts
// (server.ts throws at import unless GEMINI_API_KEY is non-empty; no network calls are made,
//  so any placeholder value in .env is enough to run these.)
import assert from 'node:assert/strict';
import { detectLanguageSwitchRequest, dominantScript, cleanupLooksBroken, joinChunk, enforceTranscriptLanguage, transcriptChunk, isDiagramRequest, buildDiagramBrief, silencePcmBase64 } from '../api/server.js';

// explicit requests, including Gemini's fragmented ASR and CJK phrasing
assert.equal(detectLanguageSwitchRequest('Can we switch to Chinese now?'), 'Simplified Chinese');
assert.equal(detectLanguageSwitchRequest('swi tch to chi nese'), 'Simplified Chinese');
assert.equal(detectLanguageSwitchRequest('let\'s continue in Spanish'), 'Spanish');
assert.equal(detectLanguageSwitchRequest('可以用中文吗'), 'Simplified Chinese');
assert.equal(detectLanguageSwitchRequest('please respond in English from now on'), 'English');
// not requests: a language merely mentioned
assert.equal(detectLanguageSwitchRequest('the word for water in Spanish is agua'), null);
assert.equal(detectLanguageSwitchRequest('Chinese porcelain was traded along the Silk Road'), null);
assert.equal(detectLanguageSwitchRequest('so the water evaporates'), null);
// script detection
assert.equal(dominantScript('光合作用是植物制造养分的过程'), 'Han');
assert.equal(dominantScript('the water cycle'), 'Latin');
assert.equal(dominantScript('ok'), null);
assert.equal(dominantScript('光合作用是 water cycle'), null); // mixed, no 70% majority
// cleanup guard
const prompt = 'Raw speech-to-text (may have missing spaces). Task: produce a transcript … Transcription: Change language.';
assert.equal(cleanupLooksBroken('Change language.', prompt), true);
assert.equal(cleanupLooksBroken('thewater cycle', 'the water cycle'), false);
assert.equal(cleanupLooksBroken('hi', 'x'.repeat(200)), true);
// chunk joining: verbatim concatenation — Gemini streams sub-word fragments and adds its own leading spaces
assert.equal(joinChunk('光合', '作用'), '光合作用');
assert.equal(joinChunk('photosynthesis', 'turns'), 'photosynthesisturns');
assert.equal(joinChunk('the', ' water'), 'the water');
assert.equal(joinChunk('', '光'), '光');
assert.equal(joinChunk('hello,', ' world'), 'hello, world');
// transcript enforcement: Traditional characters become Simplified in a Simplified Chinese session
assert.equal(enforceTranscriptLanguage('光合作用需要陽光', 'Simplified Chinese'), '光合作用需要阳光');
assert.equal(enforceTranscriptLanguage('葉綠素吸收陽光', 'Simplified Chinese'), '叶绿素吸收阳光');
assert.equal(enforceTranscriptLanguage('光合作用需要阳光', 'Simplified Chinese'), '光合作用需要阳光');
assert.equal(enforceTranscriptLanguage('葉綠素 absorbs 陽光', 'Simplified Chinese'), '叶绿素 阳光');
// other languages are untouched by the converter
assert.equal(enforceTranscriptLanguage('the water cycle', 'English'), 'the water cycle');
assert.equal(enforceTranscriptLanguage('photosynthesis needs 陽光', 'English'), 'photosynthesis needs');
assert.equal(enforceTranscriptLanguage('', 'Simplified Chinese'), '');
assert.equal(transcriptChunk(' water', 'English'), ' water');
assert.equal(transcriptChunk(' 光', 'Simplified Chinese'), '光');
assert.equal(transcriptChunk(',', 'English'), ',');
assert.equal(transcriptChunk(' 陽光', 'English'), '');
// Diagram request detection: explicit asks (clean or fragmented ASR) vs incidental visual words
assert.equal(isDiagramRequest('Can you produce a diagram that shows this?'), true);
assert.equal(isDiagramRequest('give me a sketch of that'), true);
assert.equal(isDiagramRequest('could you please show us a flowchart'), true);
assert.equal(isDiagramRequest('dia gram this for me'), true);
assert.equal(isDiagramRequest('can you draw me a diagram'), true);
assert.equal(isDiagramRequest("let's draw a conclusion from this"), false);
assert.equal(isDiagramRequest('the picture on page 3 shows a cell'), false);
assert.equal(isDiagramRequest("I'll illustrate my point"), false);
// On-demand diagram brief: student's latest utterance(s) + teacher's explanation before it, never the request
const t = (text: string) => ({ role: 'teacher' as const, name: 'Teacher', text, time: 0 });
const s = (text: string) => ({ role: 'student' as const, name: 'Student', text, time: 0 });
assert.equal(buildDiagramBrief([], 'Python functions'), 'Topic: Python functions.');
assert.equal(
  buildDiagramBrief([t('A function takes an input.'), t('def defines it.'), s('So input goes in, body runs, output comes out?')], 'Python functions'),
  'Draw the concept the student just described: "So input goes in, body runs, output comes out?". The teacher explained: "A function takes an input. def defines it.". Topic: Python functions.',
);
// only the last two teacher turns before the student's utterance; consecutive student utterances are merged
assert.equal(
  buildDiagramBrief([t('old'), t('one'), t('two'), s('a'), s('b')], 'X'),
  'Draw the concept the student just described: "a b". The teacher explained: "one two". Topic: X.',
);
// teacher-only log: no student clause
assert.equal(buildDiagramBrief([t('just me')], 'X'), 'The teacher explained: "just me". Topic: X.');
// the request sentence itself is sliced off by the caller, so a trailing teacher turn is not the request here
assert.equal(buildDiagramBrief([s('the answer'), t('more')], 'X'), 'Draw the concept the student just described: "the answer". Topic: X.');
// both clauses are capped at 400 chars
const long = 'w'.repeat(500);
const brief = buildDiagramBrief([t(long), s(long)], 'X');
assert.ok(brief.includes(`"${'w'.repeat(400)}"`));
assert.ok(!brief.includes('w'.repeat(401)));
// trailing silence sent at speech_end: 16 kHz 16-bit mono zeros (800ms = 25600 bytes)
const silence = Buffer.from(silencePcmBase64(800), 'base64');
assert.equal(silence.length, 16000 * 2 * 0.8);
assert.ok(silence.every(b => b === 0));
assert.equal(Buffer.from(silencePcmBase64(0), 'base64').length, 0);
console.log('language + cleanup checks OK');

// Gemini returns Chinese spaced out ("光 合 作 用"); the transcript must not inherit that.
assert.equal(transcriptChunk('光 合 作 用 需 要 阳 光 , 水 。', 'Simplified Chinese'), '光合作用需要阳光,水。');
assert.equal(transcriptChunk('叶 绿 素 absorbs 光', 'Simplified Chinese'), '叶绿素光'); // Latin stripped, Han joined
assert.equal(transcriptChunk(' water and carbon dioxide', 'English'), ' water and carbon dioxide');
