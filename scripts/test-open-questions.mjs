// Runnable check for the open-questions row mapping in public/learn-store.js:
//   node scripts/test-open-questions.mjs
//
// No network. These cover the layer that turns model output into database rows, which is
// where a bad `reason` would otherwise surface as an opaque 400 from PostgREST.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// learn-store.js reaches for window.pokenAuth at module scope (onAuthReset), so stand up
// just enough of it. Nothing here makes a request: the tests only touch pure helpers.
function load({ signedIn = true } = {}) {
  const window = {
    pokenAuth: {
      client: async () => { throw new Error('no network in tests'); },
      currentUser: async () => (signedIn ? { id: 'u1' } : null),
      onAuthReset() {},
      onAuthChange() {},
      signIn() {}, signOut() {},
    },
  };
  const sandbox = { window, console, crypto: globalThis.crypto, URLSearchParams };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../public/learn-store.js', import.meta.url), 'utf8'), sandbox);
  return window.pokenStore;
}

// Values built inside the vm context carry that realm's Object.prototype, which strict
// deepEqual treats as a mismatch. Compare structure, not identity.
const plain = (v) => JSON.parse(JSON.stringify(v));

const store = load();
const { toOpenQuestion, toOpenQuestionRow, OPEN_QUESTION_REASONS } = store._openQuestions;
const topic = { id: 't1', title: 'How vaccines work', language: 'English' };

// ── snake_case → camelCase ──────────────────────────────────────────────────
{
  const row = {
    id: 'q1', topic_id: 't1', topic_title: 'How vaccines work', language: 'English',
    question: 'Are memory cells the antibodies themselves?', reason: 'deferred',
    created_at: '2026-09-20T02:00:00Z', closed_at: null,
  };
  assert.deepEqual(plain(toOpenQuestion(row)), {
    id: 'q1', topicId: 't1', topicTitle: 'How vaccines work', language: 'English',
    question: 'Are memory cells the antibodies themselves?', reason: 'deferred',
    createdAt: '2026-09-20T02:00:00Z', closedAt: null,
  });
  assert.equal(toOpenQuestion(null), null);
  assert.equal(toOpenQuestion('nope'), null);
}

// A question whose tree was deleted keeps its topic_title: that is what the page groups by.
{
  const q = toOpenQuestion({ id: 'q2', topic_id: null, topic_title: 'Weimar', reason: 'wrong', question: 'x' });
  assert.equal(q.topicId, null);
  assert.equal(q.topicTitle, 'Weimar');
  assert.equal(q.language, 'English', 'language falls back rather than going undefined');
  assert.equal(q.closedAt, null);
}

// ── camelCase → row, with the table's constraints enforced up front ─────────
{
  const row = toOpenQuestionRow({ id: 'q1', question: '  Why boosters?  ', reason: 'skipped' }, topic, 'u1');
  assert.deepEqual(plain(row), {
    id: 'q1', user_id: 'u1', topic_id: 't1', topic_title: 'How vaccines work',
    language: 'English', question: 'Why boosters?', reason: 'skipped',
  });
}
{
  const row = toOpenQuestionRow({ id: 'q1', question: 'x', reason: 'wrong' }, { title: 'No tree' }, 'u1');
  assert.equal(row.topic_id, null, 'a session with no Learn tree stores a null topic_id');
  assert.equal(row.language, 'English');
}
{
  // Every one of these would violate a check constraint if it reached the database.
  const bad = [
    [{ id: 'q', question: 'x', reason: 'confused' }, topic, 'invented reason'],
    [{ id: 'q', question: '', reason: 'wrong' }, topic, 'empty question'],
    [{ id: 'q', question: '   ', reason: 'wrong' }, topic, 'whitespace-only question'],
    [{ id: 'q', question: 'x'.repeat(1001), reason: 'wrong' }, topic, 'question over 1000 chars'],
    [{ question: 'x', reason: 'wrong' }, topic, 'missing id'],
    [{ id: 'q', question: 'x', reason: 'wrong' }, { title: '' }, 'empty topic title'],
    [{ id: 'q', question: 'x', reason: 'wrong' }, { title: 'y'.repeat(201) }, 'topic title over 200 chars'],
    [null, topic, 'null question'],
  ];
  for (const [q, t, why] of bad) assert.equal(toOpenQuestionRow(q, t, 'u1'), null, `rejected: ${why}`);
}
{
  for (const reason of OPEN_QUESTION_REASONS) {
    assert.ok(toOpenQuestionRow({ id: 'q', question: 'x', reason }, topic, 'u1'), `${reason} is accepted`);
  }
  assert.deepEqual(plain(OPEN_QUESTION_REASONS), ['deferred', 'skipped', 'wrong', 'unanswered']);
}

// ── signed out: failure values, never throws ────────────────────────────────
{
  const out = load({ signedIn: false });
  assert.deepEqual(plain(await out.listOpenQuestions()), [], 'signed out lists nothing');
  assert.equal(await out.saveOpenQuestions(topic, [{ id: 'q', question: 'x', reason: 'wrong' }]), 0);
  assert.equal(await out.closeOpenQuestion('q1'), false);
  assert.equal(await out.reopenOpenQuestion('q1'), false);
}

// Signed in but with no reachable client: still a failure value, not a throw.
{
  assert.deepEqual(plain(await store.listOpenQuestions()), []);
  assert.equal(await store.saveOpenQuestions(topic, [{ id: 'q', question: 'x', reason: 'wrong' }]), 0);
  assert.equal(await store.closeOpenQuestion('q1'), false);
}

// Nothing valid to write is 0 rows, not an empty request.
{
  assert.equal(await store.saveOpenQuestions(topic, []), 0);
  assert.equal(await store.saveOpenQuestions(topic, [{ id: 'q', question: 'x', reason: 'nope' }]), 0);
}

console.log('test-open-questions: all assertions passed');
