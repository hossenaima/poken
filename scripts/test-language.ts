// Runnable check for the language-switch and cleanup-guard helpers:
//   npx tsx --env-file=.env scripts/test-language.ts
// (server.ts throws at import unless GEMINI_API_KEY is non-empty; no network calls are made,
//  so any placeholder value in .env is enough to run these.)
import assert from 'node:assert/strict';
import { detectLanguageSwitchRequest, dominantScript, cleanupLooksBroken, joinChunk, enforceTranscriptLanguage } from '../api/server.js';

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
// chunk joining: Latin words get a space, CJK characters do not
assert.equal(joinChunk('光合', '作用'), '光合作用');
assert.equal(joinChunk('the water', 'cycle'), 'the water cycle');
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
console.log('language + cleanup checks OK');
