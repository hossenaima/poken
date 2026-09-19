// Runnable check for the reflection helpers (issue #37): gaps tagged with Learn Mode node ids.
//   npx tsx --env-file=.env scripts/test-reflection.ts
// (server.ts throws at import unless GEMINI_API_KEY is non-empty; no network calls are made,
//  so any placeholder value in .env is enough to run these.)
import assert from 'node:assert/strict';
import { buildReflectionSchema, coerceReflection, parseLearnIndex, LEARN_INDEX_MAX_ENTRIES } from '../api/server.js';

const ids = ['n-light', 'n-calvin', 'n-atp'];
const topic = 'Photosynthesis';

// ── coerceReflection ────────────────────────────────────────────────────────
{
  // gapNodes aligned with gaps; unknown id nulled; missing id nulled
  const r = coerceReflection({
    summary: 'ok',
    strengths: ['**Good** pace'],
    gaps: ['**Photolysis** was skipped.', '**Calvin cycle** inputs were vague.', '**ATP** role unclear.'],
    gapNodes: [
      { text: '**Photolysis** was skipped.', nodeId: 'n-light' },
      { text: '**Calvin cycle** inputs were vague.', nodeId: 'made-up-id' },
      { text: '**ATP** role unclear.' },
    ],
    topQuestions: [], improvements: [], keyVocabulary: [],
    presentationSkills: { visualsAndGestures: 'a', explanations: 'b', mediaUsage: 'c' },
    presentationMechanics: { clarity: 'Good', visuals: 'Fair', pacing: 'Steady', tools: 'Minimal' },
  }, ids, topic);
  assert.deepEqual(r.gaps, ['**Photolysis** was skipped.', '**Calvin cycle** inputs were vague.', '**ATP** role unclear.']);
  assert.deepEqual(r.gapNodes, [
    { text: '**Photolysis** was skipped.', nodeId: 'n-light' },
    { text: '**Calvin cycle** inputs were vague.', nodeId: null },
    { text: '**ATP** role unclear.', nodeId: null },
  ]);
  assert.equal(r.gapNodes.length, r.gaps.length);
  assert.deepEqual(r.presentationSkills, { visualsAndGestures: 'a', explanations: 'b', mediaUsage: 'c' });
  assert.equal(r.presentationMechanics.clarity, 'Good');
}
{
  // model returns no gapNodes at all → still index-aligned, all null
  const r = coerceReflection({ gaps: ['a', 'b'] }, ids, topic);
  assert.deepEqual(r.gapNodes, [{ text: 'a', nodeId: null }, { text: 'b', nodeId: null }]);
}
{
  // gapNodes in a different order / slightly different whitespace → matched by text
  const r = coerceReflection({
    gaps: ['a', 'b'],
    gapNodes: [{ text: ' b ', nodeId: 'n-atp' }, { text: 'a', nodeId: 'n-calvin' }],
  }, ids, topic);
  assert.deepEqual(r.gapNodes, [{ text: 'a', nodeId: 'n-calvin' }, { text: 'b', nodeId: 'n-atp' }]);
}
{
  // gapNodes texts don't match but count does → fall back to positional alignment
  const r = coerceReflection({
    gaps: ['a', 'b'],
    gapNodes: [{ text: 'A.', nodeId: 'n-light' }, { text: 'B.', nodeId: 'bogus' }],
  }, ids, topic);
  assert.deepEqual(r.gapNodes, [{ text: 'a', nodeId: 'n-light' }, { text: 'b', nodeId: null }]);
}
{
  // count mismatch and no text match → null, never a guess
  const r = coerceReflection({ gaps: ['a', 'b'], gapNodes: [{ text: 'zzz', nodeId: 'n-light' }] }, ids, topic);
  assert.deepEqual(r.gapNodes, [{ text: 'a', nodeId: null }, { text: 'b', nodeId: null }]);
}
{
  // empty index → gapNodes is [] even if the model volunteers some
  const r = coerceReflection({ gaps: ['a'], gapNodes: [{ text: 'a', nodeId: 'n-light' }] }, [], topic);
  assert.deepEqual(r.gaps, ['a']);
  assert.deepEqual(r.gapNodes, []);
}
{
  // junk types: gaps stays string[] (non-strings dropped), gapNodes tolerates garbage entries
  const r = coerceReflection({
    summary: 42,
    gaps: ['real', 7, null, { text: 'obj' }],
    gapNodes: 'nope',
    strengths: 'not an array',
    presentationSkills: ['x', 'y'],
    presentationMechanics: 'bad',
    uiLabels: { title: 'Reflexión', gaps: 3 },
  }, ids, topic);
  assert.deepEqual(r.gaps, ['real']);
  assert.deepEqual(r.gapNodes, [{ text: 'real', nodeId: null }]);
  assert.deepEqual(r.strengths, []);
  assert.equal(r.summary, `You taught "${topic}". A detailed reflection could not be generated.`);
  assert.deepEqual(r.presentationSkills, { visualsAndGestures: 'x', explanations: 'y', mediaUsage: '' });
  assert.deepEqual(r.presentationMechanics, { clarity: 'Fair', visuals: 'Fair', pacing: 'Steady', tools: 'Minimal' });
  assert.deepEqual(r.uiLabels, { title: 'Reflexión' });

  const r2 = coerceReflection({ gaps: ['a'], gapNodes: [null, 5, 'str', { nodeId: 'n-light' }] }, ids, topic);
  assert.deepEqual(r2.gapNodes, [{ text: 'a', nodeId: null }]);
}
{
  // not an object at all → full fallback shape
  for (const junk of [null, undefined, 'text', 12, ['a']]) {
    const r = coerceReflection(junk, ids, topic);
    assert.deepEqual(r.gaps, []);
    assert.deepEqual(r.gapNodes, []);
    assert.equal(typeof r.summary, 'string');
    assert.deepEqual(r.presentationMechanics, { clarity: 'Fair', visuals: 'Fair', pacing: 'Steady', tools: 'Minimal' });
  }
}

// ── buildReflectionSchema ───────────────────────────────────────────────────
{
  const withIndex = buildReflectionSchema(true);
  const without = buildReflectionSchema(false);
  assert.ok(withIndex.properties?.gapNodes, 'gapNodes present when index given');
  assert.ok(withIndex.required?.includes('gapNodes'));
  assert.equal(without.properties?.gapNodes, undefined, 'gapNodes absent without index');
  assert.ok(!without.required?.includes('gapNodes'));
  assert.ok(without.properties?.gaps, 'gaps always present');
  assert.equal(withIndex.properties?.gapNodes?.items?.properties?.nodeId?.nullable, true);
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

console.log('test-reflection: all assertions passed');
