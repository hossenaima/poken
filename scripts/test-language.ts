// Runnable check for the language-switch and cleanup-guard helpers:
//   npx tsx --env-file=.env scripts/test-language.ts
// (server.ts throws at import unless GEMINI_API_KEY is non-empty; no network calls are made,
//  so any placeholder value in .env is enough to run these.)
import assert from 'node:assert/strict';
import { detectLanguageSwitchRequest, dominantScript, cleanupLooksBroken, joinChunk, enforceTranscriptLanguage, transcriptChunk, silencePcmBase64 } from '../api/server.js';

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
// Latin-script sessions: full-width punctuation becomes ASCII, a leading continuation ellipsis is dropped
assert.equal(enforceTranscriptLanguage('... Awesome。So let\'s talk about functions。', 'English'), 'Awesome. So let\'s talk about functions.');
assert.equal(enforceTranscriptLanguage('All right。Well，um，how do I？', 'English'), 'All right. Well, um, how do I?');
assert.equal(enforceTranscriptLanguage('All right。Well，um，how do I…？', 'English'), 'All right. Well, um, how do I…?');
assert.equal(enforceTranscriptLanguage('… Wait！ Really： yes； no （maybe）', 'Spanish'), 'Wait! Really: yes; no (maybe)');
assert.equal(enforceTranscriptLanguage('光合作用需要阳光。', 'Simplified Chinese'), '光合作用需要阳光。');
assert.equal(enforceTranscriptLanguage('the water cycle.', 'English'), 'the water cycle.');
// A reply in the wrong script is dropped whole, never reduced to its punctuation: CJK marks are
// Script=Common, so "光合作用，就是阳光。对吗？" in an English session used to surface as ", . ?".
assert.equal(enforceTranscriptLanguage('光合作用，就是阳光。对吗？', 'English'), '');
assert.equal(enforceTranscriptLanguage('光合作用。', 'Spanish'), '');
assert.equal(transcriptChunk('对吗？', 'English'), '');
// …but punctuation that is merely unaccompanied in this chunk still streams normally.
assert.equal(enforceTranscriptLanguage('123。', 'English'), '123.');
assert.equal(enforceTranscriptLanguage('光合作用，对吗？', 'Simplified Chinese'), '光合作用，对吗？');
assert.equal(transcriptChunk(' water', 'English'), ' water');
assert.equal(transcriptChunk(' 光', 'Simplified Chinese'), '光');
assert.equal(transcriptChunk(',', 'English'), ',');
assert.equal(transcriptChunk(' 陽光', 'English'), '');
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
