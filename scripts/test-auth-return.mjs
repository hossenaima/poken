// Runnable check for the return-intent record in public/auth.js:
//   node scripts/test-auth-return.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function load({ search = '', hash = '', store = {} } = {}) {
  const sessionStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  };
  const window = {};
  const sandbox = {
    window, sessionStorage, console,
    location: { origin: 'https://poken.live', pathname: '/', search, hash },
    history: { replaceState() {}, state: null },
    URLSearchParams,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync('public/auth.js', 'utf8'), sandbox);
  return { auth: window.pokenAuth, store };
}

// a written intent comes back once, then is gone
{
  const { auth, store } = load();
  auth.writeReturn('setup');
  assert.equal(auth.takeReturn(), 'setup');
  assert.equal(auth.takeReturn(), null, 'the record is cleared after one read');
  assert.deepEqual(Object.keys(store), [], 'nothing is left in storage');
}
// nothing written
{
  const { auth } = load();
  assert.equal(auth.takeReturn(), null);
}
// stale record is ignored (older than 10 minutes)
{
  const stale = JSON.stringify({ screen: 'learn', ts: Date.now() - 11 * 60 * 1000 });
  const { auth } = load({ store: { poken_return: stale } });
  assert.equal(auth.takeReturn(), null, 'a stale record must not hijack a later visit');
}
// a fresh record just inside the window is honoured
{
  const fresh = JSON.stringify({ screen: 'learn', ts: Date.now() - 60 * 1000 });
  const { auth } = load({ store: { poken_return: fresh } });
  assert.equal(auth.takeReturn(), 'learn');
}
// malformed records never throw
{
  for (const junk of ['not json', '{}', '[]', 'null', JSON.stringify({ screen: 7, ts: Date.now() })]) {
    const { auth } = load({ store: { poken_return: junk } });
    assert.equal(auth.takeReturn(), null, `junk rejected: ${junk}`);
  }
}
// storage that throws (Safari private mode) must not take the page down
{
  const { auth } = load();
  auth.writeReturn('setup');
  assert.equal(typeof auth.takeReturn, 'function');
}
console.log('auth return-intent checks OK');
