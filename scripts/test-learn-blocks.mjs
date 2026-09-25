// Runnable check for Learn Mode's block parser: node scripts/test-learn-blocks.mjs
// Evaluates the parser straight out of public/learn.js (it lives inside the page's IIFE), so this
// tests the shipped code, not a copy of it.
import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../public/learn.js', import.meta.url), 'utf8');
const start = src.indexOf('  const LINE = {');
const end = src.indexOf('  const plainBlocksOf');
assert.ok(start > 0 && end > start, 'parser section not found in learn.js');
const { blocksOf, proseBlocksOf } = new Function(`${src.slice(start, end)}; return { blocksOf, proseBlocksOf };`)();
const kinds = (t) => blocksOf(t).map(b => b.kind);

// 1. Text with no code and no math splits exactly as before, so saved trees keep their anchors.
for (const t of [
  'One paragraph.\n\nAnother with **bold** and *italic*.',
  '### Stages\n\n- first\n- second\n\n1. a\n2. b',
  '| A | B |\n|---|---|\n| 1 | 2 |\n\n> A principle worth pausing on.',
]) assert.deepEqual(blocksOf(t), proseBlocksOf(t));

// 2. A fenced block becomes one code block, keeping its language and any blank lines inside it.
const code = blocksOf('Here is a loop:\n\n```python\nfor i in range(3):\n\n    print(i)\n```\n\nIt prints three lines.');
assert.deepEqual(code.map(b => b.kind), ['paragraph', 'code', 'paragraph']);
assert.equal(code[1].lang, 'python');
assert.equal(code[1].text, 'for i in range(3):\n\n    print(i)');

// 3. Mid-stream, an unclosed fence shows what has arrived instead of swallowing it.
assert.deepEqual(kinds('Intro.\n\n```js\nconst x ='), ['paragraph', 'code']);

// 4. Display math is its own block, one equation per line.
const m = blocksOf('The rate is:\n\n$$\nv = \\frac{d}{t}\na = \\frac{\\Delta v}{\\Delta t}\n$$\n\nSo speed is distance over time.');
assert.deepEqual(m.map(b => b.kind), ['paragraph', 'math', 'paragraph']);
assert.deepEqual(m[1].lines, ['v = \\frac{d}{t}', 'a = \\frac{\\Delta v}{\\Delta t}']);
assert.equal(m[1].open, false);
assert.deepEqual(kinds('Before \\[E = mc^2\\] after.'), ['paragraph', 'math', 'paragraph']);

// 5. A lone inline symbol stays in its sentence as readable text…
assert.equal(blocksOf('where $x$ is distance, $v_0$ the start and $\\theta$ the angle, $x^2$ too.')[0].text,
  'where x is distance, v₀ the start and θ the angle, x² too.');
// …but a real inline equation is pulled out into its own block.
assert.deepEqual(kinds('Energy is $E = mc^2$ which is large.'), ['paragraph', 'math', 'paragraph']);

// 6. Prices are not math.
assert.deepEqual(blocksOf('It costs $5 and $10 later.'), proseBlocksOf('It costs $5 and $10 later.'));

// 7. Mid-stream, unclosed math is marked open so it shows as source, not a red parse error.
const open = blocksOf('Look:\n\n$$\nx = \\frac{1}{');
assert.equal(open.at(-1).kind, 'math');
assert.equal(open.at(-1).open, true);

// 8. & alignment stays one aligned environment so its columns line up.
assert.deepEqual(blocksOf('$$\na &= b + c \\\\\n  &= d\n$$')[0].lines, ['\\begin{aligned}a &= b + c\\\\&= d\\end{aligned}']);

console.log('learn block parser checks OK');
