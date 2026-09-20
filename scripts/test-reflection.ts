// Runnable check for the reflection helpers: the topic list, and gaps carrying a study label
// plus the Learn Mode node id they came from.
//   npx tsx --env-file=.env scripts/test-reflection.ts
// (server.ts throws at import unless GEMINI_API_KEY is non-empty; no network calls are made,
//  so any placeholder value in .env is enough to run these.)
import assert from 'node:assert/strict';
import { buildReflectionSchema, coerceReflection, parseLearnIndex, LEARN_INDEX_MAX_ENTRIES, OPEN_QUESTION_REASONS } from '../api/server.js';

const ids = ['n-light', 'n-calvin', 'n-atp'];
const topic = 'Photosynthesis';

// ── coerceReflection ────────────────────────────────────────────────────────
{
  // gapNodes aligned with gaps; unknown id nulled; missing id nulled; label kept
  const r = coerceReflection({
    summary: 'ok',
    topicsCovered: ['How light is captured', 'Where glucose goes'],
    gaps: ['**Photolysis** was skipped.', '**Calvin cycle** inputs were vague.', '**ATP** role unclear.'],
    gapNodes: [
      { text: '**Photolysis** was skipped.', label: 'Photolysis', nodeId: 'n-light' },
      { text: '**Calvin cycle** inputs were vague.', label: 'Calvin cycle', nodeId: 'made-up-id' },
      { text: '**ATP** role unclear.', label: 'ATP in photosynthesis' },
    ],
    keyVocabulary: ['Chlorophyll'],
  }, ids, topic);
  assert.deepEqual(r.gaps, ['**Photolysis** was skipped.', '**Calvin cycle** inputs were vague.', '**ATP** role unclear.']);
  assert.deepEqual(r.gapNodes, [
    { text: '**Photolysis** was skipped.', label: 'Photolysis', nodeId: 'n-light' },
    { text: '**Calvin cycle** inputs were vague.', label: 'Calvin cycle', nodeId: null },
    { text: '**ATP** role unclear.', label: 'ATP in photosynthesis', nodeId: null },
  ]);
  assert.equal(r.gapNodes.length, r.gaps.length);
  assert.deepEqual(r.topicsCovered, ['How light is captured', 'Where glucose goes']);
  assert.deepEqual(r.keyVocabulary, ['Chlorophyll']);
}
{
  // no gapNodes at all → still index-aligned, labels derived from the gap text
  const r = coerceReflection({ gaps: ['**Photolysis** was skipped.', 'The second step was never explained.'] }, ids, topic);
  assert.deepEqual(r.gapNodes, [
    { text: '**Photolysis** was skipped.', label: 'Photolysis', nodeId: null },
    { text: 'The second step was never explained.', label: 'The second step was never explained', nodeId: null },
  ]);
}
{
  // a derived label is capped at six words and loses its trailing punctuation
  const r = coerceReflection({ gaps: ['one two three four five six seven eight.'] }, [], topic);
  assert.equal(r.gapNodes[0].label, 'one two three four five six');
}
{
  // gapNodes in a different order / slightly different whitespace → matched by text
  const r = coerceReflection({
    gaps: ['a', 'b'],
    gapNodes: [{ text: ' b ', label: 'B', nodeId: 'n-atp' }, { text: 'a', label: 'A', nodeId: 'n-calvin' }],
  }, ids, topic);
  assert.deepEqual(r.gapNodes, [
    { text: 'a', label: 'A', nodeId: 'n-calvin' },
    { text: 'b', label: 'B', nodeId: 'n-atp' },
  ]);
}
{
  // gapNodes texts don't match but count does → fall back to positional alignment
  const r = coerceReflection({
    gaps: ['a', 'b'],
    gapNodes: [{ text: 'A.', label: 'Ay', nodeId: 'n-light' }, { text: 'B.', label: 'Bee', nodeId: 'bogus' }],
  }, ids, topic);
  assert.deepEqual(r.gapNodes, [
    { text: 'a', label: 'Ay', nodeId: 'n-light' },
    { text: 'b', label: 'Bee', nodeId: null },
  ]);
}
{
  // count mismatch and no text match → null id, never a guess; label still derived
  const r = coerceReflection({ gaps: ['a', 'b'], gapNodes: [{ text: 'zzz', label: 'Z', nodeId: 'n-light' }] }, ids, topic);
  assert.deepEqual(r.gapNodes, [{ text: 'a', label: 'a', nodeId: null }, { text: 'b', label: 'b', nodeId: null }]);
}
{
  // no Learn Mode index → gaps are still clickable concepts, just never tied to a node
  const r = coerceReflection({ gaps: ['a'], gapNodes: [{ text: 'a', label: 'A', nodeId: 'n-light' }] }, [], topic);
  assert.deepEqual(r.gaps, ['a']);
  assert.deepEqual(r.gapNodes, [{ text: 'a', label: 'A', nodeId: null }]);
}
{
  // junk types: gaps stays string[] (non-strings dropped), gapNodes tolerates garbage entries
  const r = coerceReflection({
    summary: 42,
    gaps: ['real', 7, null, { text: 'obj' }],
    gapNodes: 'nope',
    topicsCovered: 'not an array',
    keyVocabulary: [1, 'Glucose'],
    uiLabels: { title: 'Reflexión', gaps: 3 },
  }, ids, topic);
  assert.deepEqual(r.gaps, ['real']);
  assert.deepEqual(r.gapNodes, [{ text: 'real', label: 'real', nodeId: null }]);
  assert.deepEqual(r.topicsCovered, []);
  assert.deepEqual(r.keyVocabulary, ['Glucose']);
  assert.equal(r.summary, `You taught "${topic}". A detailed reflection could not be generated.`);
  assert.deepEqual(r.uiLabels, { title: 'Reflexión' });

  const r2 = coerceReflection({ gaps: ['a'], gapNodes: [null, 5, 'str', { nodeId: 'n-light' }] }, ids, topic);
  assert.deepEqual(r2.gapNodes, [{ text: 'a', label: 'a', nodeId: null }]);
}
{
  // not an object at all → full fallback shape
  for (const junk of [null, undefined, 'text', 12, ['a']]) {
    const r = coerceReflection(junk, ids, topic);
    assert.deepEqual(r.gaps, []);
    assert.deepEqual(r.gapNodes, []);
    assert.deepEqual(r.topicsCovered, []);
    assert.equal(typeof r.summary, 'string');
  }
}

// ── buildReflectionSchema ───────────────────────────────────────────────────
{
  const withIndex = buildReflectionSchema(true);
  const without = buildReflectionSchema(false);
  // gapNodes is always asked for (the label drives the "learn this" hand-off)
  for (const schema of [withIndex, without]) {
    assert.ok(schema.properties?.gapNodes, 'gapNodes always present');
    assert.ok(schema.required?.includes('gapNodes'));
    assert.ok(schema.properties?.gaps && schema.properties?.topicsCovered);
    assert.ok(schema.properties?.gapNodes?.items?.required?.includes('label'));
  }
  // nodeId is only offered when there are real ids to choose from
  assert.equal(withIndex.properties?.gapNodes?.items?.properties?.nodeId?.nullable, true);
  assert.equal(without.properties?.gapNodes?.items?.properties?.nodeId, undefined);
  // the cut sections are gone
  for (const dead of ['strengths', 'topQuestions', 'improvements', 'presentationSkills', 'presentationMechanics']) {
    assert.equal(withIndex.properties?.[dead], undefined, `${dead} should no longer be requested`);
  }
}

// ── parseLearnIndex ─────────────────────────────────────────────────────────
{
  const parsed = parseLearnIndex([
    { id: 'a', label: 'light-dependent reactions' },
    { id: ' b ', label: '  Calvin cycle ' },        // trimmed
    { id: 'a', label: 'duplicate id' },              // dropped
    { id: 'c' },                                     // no label
    { label: 'no id' },
    { id: 7, label: 'numeric id' },
    { id: 'd', label: '' },                          // empty label
    { id: 'x'.repeat(65), label: 'id too long' },
    { id: 'e', label: 'y'.repeat(201) },             // label too long
    null, 'string', 42,
    { id: 'x'.repeat(64), label: 'y'.repeat(200) },  // exactly at the caps
  ]);
  assert.deepEqual(parsed, [
    { id: 'a', label: 'light-dependent reactions' },
    { id: 'b', label: 'Calvin cycle' },
    { id: 'x'.repeat(64), label: 'y'.repeat(200) },
  ]);
  assert.deepEqual(parseLearnIndex(undefined), []);
  assert.deepEqual(parseLearnIndex('not an array'), []);
  assert.deepEqual(parseLearnIndex({ id: 'a', label: 'b' }), []);

  const many = Array.from({ length: 100 }, (_, i) => ({ id: `id-${i}`, label: `label ${i}` }));
  const capped = parseLearnIndex(many);
  assert.equal(capped.length, LEARN_INDEX_MAX_ENTRIES);
  assert.equal(capped[0].id, 'id-0');
  assert.equal(capped[59].id, 'id-59');
}

// ── openQuestions ───────────────────────────────────────────────────────────
{
  const r = coerceReflection({
    openQuestions: [
      { question: 'Are memory cells the antibodies themselves?', reason: 'deferred' },
      { question: 'Why do boosters exist?', reason: 'WRONG' },
      { question: '  ', reason: 'skipped' },
      { question: 'Invented reason is dropped, never coerced', reason: 'confused' },
      { question: 'Are memory cells the antibodies themselves?', reason: 'unanswered' },
      { reason: 'skipped' },
      'not an object',
    ],
  }, [], 'How vaccines work');
  assert.equal(r.openQuestions.length, 2, 'blank, bad-reason, duplicate and malformed entries are dropped');
  assert.deepEqual(r.openQuestions[0], { question: 'Are memory cells the antibodies themselves?', reason: 'deferred' });
  assert.equal(r.openQuestions[1].reason, 'wrong', 'reason is lower-cased to match the db check constraint');
  for (const q of r.openQuestions) assert.ok(OPEN_QUESTION_REASONS.includes(q.reason));
}
{
  // Speech-transcript artefacts seen in a real session probe.
  const r = coerceReflection({
    openQuestions: [
      { question: 'I thought memory cells were actually*cells* that make antibodies?', reason: 'wrong' },
      { question: '  Spaced   out   question?  ', reason: 'skipped' },
      { question: '***', reason: 'deferred' },
      { question: 'Does the *stress* land right at the end*?', reason: 'unanswered' },
    ],
  }, [], 'Topic');
  assert.equal(r.openQuestions[0].question, 'I thought memory cells were actually cells that make antibodies?', 'emphasis asterisks stripped');
  assert.equal(r.openQuestions[1].question, 'Spaced out question?', 'runs of whitespace collapsed');
  assert.equal(r.openQuestions[2].question, 'Does the stress land right at the end?', 'no space left stranded before punctuation');
  assert.equal(r.openQuestions.length, 3, 'a question that was only asterisks is dropped, not kept as empty');
}
{
  // Contractions and names must survive: we do not touch apostrophes.
  const r = coerceReflection({
    openQuestions: [{ question: "Don't O'Brien's model say otherwise?", reason: 'wrong' }],
  }, [], 'Topic');
  assert.equal(r.openQuestions[0].question, "Don't O'Brien's model say otherwise?");
}
{
  const r = coerceReflection({ summary: 'ok' }, [], 'Topic');
  assert.deepEqual(r.openQuestions, [], 'a reflection with no openQuestions key yields an empty list, not undefined');
  assert.equal(r.seededAnswered, undefined, 'seededAnswered stays absent unless the model returned a boolean');
}
{
  const r = coerceReflection({ seededAnswered: true }, [], 'Topic');
  assert.equal(r.seededAnswered, true);
  const r2 = coerceReflection({ seededAnswered: 'yes' }, [], 'Topic');
  assert.equal(r2.seededAnswered, undefined, 'a non-boolean seededAnswered is ignored');
}
{
  const plain = JSON.stringify(buildReflectionSchema(false));
  const seeded = JSON.stringify(buildReflectionSchema(false, true));
  assert.ok(!plain.includes('seededAnswered'), 'seededAnswered is not offered when no question was seeded');
  assert.ok(seeded.includes('seededAnswered'), 'seededAnswered is required when a question was seeded');
  assert.ok(plain.includes('openQuestions'), 'openQuestions is always in the schema');
}

console.log('test-reflection: all assertions passed');
