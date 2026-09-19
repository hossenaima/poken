// Runnable check for the language-switch and cleanup-guard helpers:
//   npx tsx --env-file=.env scripts/test-language.ts
// (server.ts throws at import unless GEMINI_API_KEY is non-empty; no network calls are made,
//  so any placeholder value in .env is enough to run these.)
import assert from 'node:assert/strict';
import { detectLanguageSwitchRequest, dominantScript, cleanupLooksBroken, joinChunk, enforceTranscriptLanguage, isDiagramRequest } from '../api/server.js';
import { mapScribeLanguage, segmentDelta, parseScribeEvent } from '../server/scribe.js';

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
// Scribe language codes → the 8 session languages; anything else is ignored
assert.equal(mapScribeLanguage('en'), 'English');
assert.equal(mapScribeLanguage('spa'), 'Spanish');
assert.equal(mapScribeLanguage('zh'), 'Simplified Chinese');
assert.equal(mapScribeLanguage('cmn-Hans'), 'Simplified Chinese');
assert.equal(mapScribeLanguage('ja'), null);
assert.equal(mapScribeLanguage(null), null);
// Scribe re-sends the whole segment as it settles; only the new tail is ingested
assert.equal(segmentDelta('the water', 'the water cycle'), ' cycle');
assert.equal(segmentDelta('the water cycle', 'the water'), '');
assert.equal(segmentDelta('', 'photosynthesis'), 'photosynthesis');
// a revision that is not a forward extension is dropped rather than duplicated downstream
assert.equal(segmentDelta('I scream', 'ice cream'), '');
assert.equal(segmentDelta('a rewritten', 'completely different'), '');
// Scribe event parsing: only final/committed segments carry transcript, partials are dropped
assert.deepEqual(parseScribeEvent('{"message_type":"session_started","session_id":"x"}'), { kind: 'started' });
assert.deepEqual(parseScribeEvent('{"message_type":"partial_transcript","text":"the wa"}'), { kind: 'partial', text: 'the wa' });
assert.deepEqual(parseScribeEvent('{"message_type":"final_transcript","text":"the water cycle"}'),
  { kind: 'transcript', text: 'the water cycle', committed: false });
assert.deepEqual(parseScribeEvent('{"message_type":"committed_transcript","text":"the water cycle."}'),
  { kind: 'transcript', text: 'the water cycle.', committed: true });
assert.deepEqual(parseScribeEvent('{"message_type":"committed_transcript_with_timestamps","language_code":"zh"}'),
  { kind: 'language', language: 'Simplified Chinese' });
assert.deepEqual(parseScribeEvent('{"message_type":"final_transcript_with_timestamps","language_code":"ja"}'), { kind: 'ignore' });
assert.deepEqual(parseScribeEvent('{"message_type":"error","error":"auth_error"}'),
  { kind: 'error', code: 'auth_error', permanent: true });
assert.deepEqual(parseScribeEvent('{"message_type":"error","error":"internal_error"}'),
  { kind: 'error', code: 'internal_error', permanent: false });
// a rejected frame comes back as input_error, retryable unless the code itself is permanent
assert.deepEqual(parseScribeEvent('{"message_type":"input_error","error":"Unexpected message type: commit"}'),
  { kind: 'error', code: 'Unexpected message type: commit', permanent: false });
assert.deepEqual(parseScribeEvent('{"message_type":"input_error","error":"auth_error"}'),
  { kind: 'error', code: 'auth_error', permanent: true });
assert.deepEqual(parseScribeEvent('not json'), { kind: 'ignore' });
// Diagram request detection: explicit asks (clean or fragmented ASR) vs incidental visual words
assert.equal(isDiagramRequest('Can you produce a diagram that shows this?'), true);
assert.equal(isDiagramRequest('give me a sketch of that'), true);
assert.equal(isDiagramRequest('could you please show us a flowchart'), true);
assert.equal(isDiagramRequest('dia gram this for me'), true);
assert.equal(isDiagramRequest('can you draw me a diagram'), true);
assert.equal(isDiagramRequest("let's draw a conclusion from this"), false);
assert.equal(isDiagramRequest('the picture on page 3 shows a cell'), false);
assert.equal(isDiagramRequest("I'll illustrate my point"), false);
console.log('language + cleanup checks OK');
