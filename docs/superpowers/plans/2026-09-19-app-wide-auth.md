# App-Wide Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user sign in from anywhere in Poken and come back to the screen they started from, instead of only from the Learn screen.

**Architecture:** Supabase auth moves out of Learn Mode's storage module into a new `public/auth.js` that owns the one Supabase client and exposes `window.pokenAuth`. Sign-in records which screen it started from in `sessionStorage`; a router in `app.js` reads that record once at boot and re-opens that screen. One account control renders into any element marked `data-poken-account`.

**Tech Stack:** Vanilla browser JS (classic scripts, no bundler), Supabase JS v2.116.0 loaded from jsDelivr as an ESM dynamic import, Node 20 + `node:assert` for the headless test.

**Spec:** `docs/superpowers/specs/2026-09-19-app-wide-auth-design.md`

## Global Constraints

- **Never throws.** Every auth function returns a documented failure value (`false`, `null`) and logs through `warn()`. A missing or broken Supabase must leave teaching and learning fully usable.
- **Nothing becomes gated.** No screen, button or flow may require a signed-in user. Sign-in is an offer.
- **`window.pokenStore` keeps its exact shape:** `ready, currentUser, signInWithGoogle, signOut, onAuthChange, listTopics, createTopic, saveNode, loadTree, deleteTopic, uploadDiagram, diagramUrl`. `public/learn.js` must not need edits to its storage calls.
- **One Supabase client only.** Two clients on one project run two token-refresh loops against the same storage key and race. Creation moves to `auth.js`; `learn-store.js` asks for it.
- **Script order in `public/index.html` is `auth.js`, then `app.js`, then `learn-store.js`, then `learn.js`.**
- **No new dependencies.** No bundler, no framework, no npm package.
- **Prerequisite, not a code change:** Supabase → Authentication → URL Configuration must list `https://poken.live/**` in Redirect URLs and set Site URL to `https://poken.live`. `redirectTo` is built from `location.origin`, so sign-in fails silently on any origin missing from that list.

---

### Task 1: `public/auth.js` — the shared client, identity API, and return intent

**Files:**
- Create: `public/auth.js`
- Create: `scripts/test-auth-return.mjs`
- Modify: `public/index.html` (script tags, ~line 1534)
- Modify: `public/learn-store.js` (client creation and the auth block, lines ~33-215)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `window.pokenAuth` with
  - `client(): Promise<SupabaseClient>` — the shared client; rejects if the CDN import fails.
  - `currentUser(): Promise<User|null>` where `User = { id, email, name, avatarUrl }`.
  - `onAuthChange(cb: (user: User|null) => void): () => void` — returns an unsubscribe function.
  - `signIn(screen: string): Promise<boolean>` — writes the return intent, then redirects. `false` means the redirect never started.
  - `signOut(): Promise<boolean>`.
  - `takeReturn(): string|null` — reads and clears the return intent; `null` when absent, malformed, or older than 10 minutes.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-auth-return.mjs`. It evaluates `public/auth.js` inside a fake browser so the pure return-intent logic can be checked headlessly. `client()` is lazy, so no network call happens.

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/test-auth-return.mjs`
Expected: FAIL with `ENOENT: no such file or directory, open 'public/auth.js'`.

- [ ] **Step 3: Create `public/auth.js`**

Move the client bootstrap, `toUser`, `currentUser`, `signInWithGoogle`, `signOut`, `onAuthChange` and the whole OAuth-callback block out of `public/learn-store.js` verbatim, and add the return intent. The `warn` prefix changes to `[Poken][Auth]`.

```js
// ── Auth ─────────────────────────────────────────────────────────────────────
// The one Supabase client for the whole app, and the identity API around it.
// Every function returns a documented failure value and never throws: a missing or
// misconfigured Supabase must leave teaching and learning fully usable.
// Loads before app.js and learn-store.js; learn-store.js re-exports what it needs.
(() => {
  // Public by design: the publishable key only identifies the project; Row-Level Security
  // on every table is what protects data. Never put a secret / service_role key here.
  const override = window.POKEN_SUPABASE || {};
  const SUPABASE_URL = override.url || "https://poken.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY = override.key || "sb_publishable_bv-rl4U4GZVc1j7gb8eTbQ_7BdK0hX8";
  const SUPABASE_JS_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/+esm";

  const AUTH_EVENTS = new Set(["INITIAL_SESSION", "SIGNED_IN", "SIGNED_OUT", "USER_UPDATED"]);
  const AUTH_QUERY_PARAMS = ["code", "state", "error", "error_code", "error_description"];
  const AUTH_HASH_PARAMS = [
    "access_token", "refresh_token", "expires_in", "expires_at", "token_type", "type",
    "provider_token", "provider_refresh_token", "error", "error_code", "error_description",
  ];

  // Google sign-in navigates away and comes back to a cold page, so the screen the user
  // started from has to survive in storage. Ten minutes is long enough for a slow consent
  // screen and short enough that a forgotten tab doesn't hijack a later visit.
  const RETURN_KEY = "poken_return";
  const RETURN_MAX_AGE_MS = 10 * 60 * 1000;

  const detailOf = (err) => err && (err.message || err.error_description || err.msg || String(err));
  const warn = (what, err) => {
    const detail = detailOf(err);
    console.warn(`[Poken][Auth] ${what}${detail ? `: ${detail}` : ""}`);
  };

  // ── Client (lazy, memoized) ──────────────────────────────────────────────
  let clientPromise = null;
  const resetHooks = [];
  function client() {
    if (!clientPromise) {
      clientPromise = import(SUPABASE_JS_URL)
        .then(({ createClient }) => {
          const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
            auth: { flowType: "pkce" },
          });
          sb.auth.onAuthStateChange(() => { for (const fn of resetHooks) { try { fn(); } catch (_) {} } });
          return sb;
        })
        .catch((err) => { clientPromise = null; throw err; });
    }
    return clientPromise;
  }
  // learn-store.js registers here so its `readyPromise` cache still clears on an auth change.
  function onAuthReset(fn) { resetHooks.push(fn); }

  function toUser(u) {
    if (!u?.id) return null;
    const m = u.user_metadata || {};
    return {
      id: u.id,
      email: u.email || null,
      name: m.full_name || m.name || null,
      avatarUrl: m.avatar_url || m.picture || null,
    };
  }

  async function currentUser() {
    try {
      const sb = await client();
      const { data, error } = await sb.auth.getSession();
      if (error) throw error;
      return toUser(data?.session?.user);
    } catch (err) {
      warn("currentUser failed", err);
      return null;
    }
  }

  // ── Return intent ────────────────────────────────────────────────────────
  function writeReturn(screen) {
    try {
      sessionStorage.setItem(RETURN_KEY, JSON.stringify({ screen: String(screen), ts: Date.now() }));
    } catch (_) { /* private mode: we lose the return, not the sign-in */ }
  }

  function takeReturn() {
    try {
      const raw = sessionStorage.getItem(RETURN_KEY);
      sessionStorage.removeItem(RETURN_KEY);
      if (!raw) return null;
      const rec = JSON.parse(raw);
      if (!rec || typeof rec.screen !== "string" || !rec.screen) return null;
      if (typeof rec.ts !== "number" || !Number.isFinite(rec.ts)) return null;
      if (Date.now() - rec.ts > RETURN_MAX_AGE_MS) return null;
      return rec.screen;
    } catch (_) {
      return null;
    }
  }

  async function signIn(screen) {
    writeReturn(screen);
    try {
      const sb = await client();
      const { error } = await sb.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: location.origin + location.pathname },
      });
      if (error) throw error;
      return true;
    } catch (err) {
      warn("signIn failed", err);
      takeReturn();   // never left, so the record would be stale
      return false;
    }
  }

  async function signOut() {
    try {
      const sb = await client();
      const { error } = await sb.auth.signOut();
      if (error) throw error;
      return true;
    } catch (err) {
      warn("signOut failed", err);
      return false;
    }
  }

  // Synchronous; returns an unsubscribe function. cb(user | null) on INITIAL_SESSION,
  // SIGNED_IN, SIGNED_OUT, USER_UPDATED. If Supabase can't load, cb is never called.
  function onAuthChange(cb) {
    let cancelled = false;
    let unsubscribe = null;
    client()
      .then((sb) => {
        if (cancelled) return;
        const { data } = sb.auth.onAuthStateChange((event, session) => {
          if (cancelled || !AUTH_EVENTS.has(event)) return;
          try {
            cb(toUser(session?.user));
          } catch (err) {
            warn("onAuthChange callback threw", err);
          }
        });
        unsubscribe = data?.subscription?.unsubscribe?.bind(data.subscription) || null;
        if (cancelled) unsubscribe?.();
      })
      .catch((err) => warn("onAuthChange unavailable", err));
    return () => {
      cancelled = true;
      try { unsubscribe?.(); } catch (_) { /* ignore */ }
      unsubscribe = null;
    };
  }

  // ── OAuth callback on page load ──────────────────────────────────────────
  // Google redirects back with ?code=… (PKCE) or #access_token=… / #error=…. Load the
  // client right away so supabase-js completes the exchange, then clean the address bar.
  function stripParams(search, keys) {
    const params = new URLSearchParams(search);
    for (const k of keys) params.delete(k);
    const s = params.toString();
    return s ? `?${s}` : "";
  }

  function cleanAuthUrl() {
    try {
      const query = stripParams(location.search, AUTH_QUERY_PARAMS);
      let hash = "";
      if (location.hash.length > 1) {
        const rest = stripParams(location.hash.slice(1), AUTH_HASH_PARAMS);
        hash = rest ? `#${rest.slice(1)}` : "";
      }
      history.replaceState(history.state, "", location.pathname + query + hash);
    } catch (err) {
      warn("cleaning the auth callback URL failed", err);
    }
  }

  function hasAuthCallback() {
    const query = new URLSearchParams(location.search);
    const hash = new URLSearchParams(location.hash.slice(1));
    return query.has("code") || query.has("error") || query.has("error_description")
      || hash.has("access_token") || hash.has("error") || hash.has("error_description");
  }

  async function handleAuthCallback() {
    const query = new URLSearchParams(location.search);
    const hash = new URLSearchParams(location.hash.slice(1));
    const urlError = query.get("error_description") || query.get("error")
      || hash.get("error_description") || hash.get("error");
    try {
      const sb = await client();
      const { error } = await sb.auth.initialize();
      if (error) throw error;
      if (query.has("code")) {
        const { data: sessionData, error: sessionError } = await sb.auth.getSession();
        if (sessionError) throw sessionError;
        if (!sessionData?.session) throw new Error("no session established");
      }
      if (urlError) throw new Error(urlError);
    } catch (err) {
      warn("sign-in callback failed", err);
    } finally {
      cleanAuthUrl();
    }
  }

  if (hasAuthCallback()) handleAuthCallback();

  window.pokenAuth = {
    client, onAuthReset, currentUser, onAuthChange,
    signIn, signOut, writeReturn, takeReturn,
  };
})();
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node scripts/test-auth-return.mjs`
Expected: PASS, printing `auth return-intent checks OK`.

- [ ] **Step 5: Strip the moved code out of `public/learn-store.js`**

Delete from `learn-store.js`: the `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_JS_URL` constants, `AUTH_EVENTS`, `AUTH_QUERY_PARAMS`, `AUTH_HASH_PARAMS`, the `client()` block, `toUser`, `currentUser`, `signInWithGoogle`, `signOut`, `onAuthChange`, `stripParams`, `cleanAuthUrl`, `hasAuthCallback`, `handleAuthCallback`, and the `if (hasAuthCallback()) handleAuthCallback();` line. Keep `DIAGRAM_BUCKET`, `SIGNED_URL_TTL_S`, `TOPIC_LIST_LIMIT`, `detailOf`, `warn` and every storage function.

Replace them with a borrowed client and re-exports:

```js
  // The client and every identity concern live in auth.js; this module only stores things.
  const auth = () => window.pokenAuth;
  const client = () => auth().client();
  auth().onAuthReset(() => { readyPromise = null; });
```

and change the export block at the bottom to:

```js
  window.pokenStore = {
    ready,
    currentUser: (...a) => auth().currentUser(...a),
    signInWithGoogle: () => auth().signIn("learn"),
    signOut: (...a) => auth().signOut(...a),
    onAuthChange: (...a) => auth().onAuthChange(...a),
    listTopics, createTopic, saveNode, loadTree, deleteTopic, uploadDiagram, diagramUrl,
  };
```

- [ ] **Step 6: Load `auth.js` first in `public/index.html`**

Change the script block near line 1534 from:

```html
  <script src="app.js"></script>
  <script src="learn-store.js"></script>
  <script src="learn.js"></script>
```

to:

```html
  <script src="auth.js"></script>
  <script src="app.js"></script>
  <script src="learn-store.js"></script>
  <script src="learn.js"></script>
```

- [ ] **Step 7: Verify nothing regressed**

Run: `node --check public/auth.js && node --check public/learn-store.js && node scripts/test-auth-return.mjs`
Expected: all pass.

Then start the app with `npm run dev`, open `http://localhost:8000`, go to Learn Mode, and confirm the Sign in with Google button still renders and the browser console shows no `[Poken]` warnings. Sign-in behaviour is unchanged by this task — the button is still only on Learn.

- [ ] **Step 8: Commit**

```bash
git add public/auth.js public/learn-store.js public/index.html scripts/test-auth-return.mjs
git commit -m "Move Supabase auth out of Learn Mode's storage module

learn-store.js created the Supabase client and owned sign-in, sign-out and
the auth subscription alongside tree storage, so anything outside Learn Mode
had to reach through Learn Mode to get an account.

auth.js now owns the one client and the identity API. learn-store keeps its
storage functions and re-exports identity from it, so window.pokenStore is
unchanged and learn.js needs no edit. Adds the return-intent record that a
later change uses to come back to the screen sign-in started from."
```

---

### Task 2: Return to the screen sign-in started from

**Files:**
- Modify: `public/app.js` (add the screen registry and boot router near the other boot code)
- Modify: `public/learn.js` (register a restore hook; stop routing off the tree stash, ~lines 757-775)

**Interfaces:**
- Consumes: `window.pokenAuth.takeReturn()` from Task 1.
- Produces: `window.pokenScreens.register(name: string, restore: () => void): void` — a screen declares how to re-open itself. Names used in this plan: `"landing"`, `"setup"`, `"learn"`, `"reflection"`.

- [ ] **Step 1: Add the screen registry and router to `public/app.js`**

Put this next to the other top-level boot code, after `showLanding` is defined:

```js
// ── Returning from Google sign-in ───────────────────────────────────────────
// The OAuth redirect reloads the page, so the screen the user was on is gone. auth.js
// recorded which one it was; each screen says here how to re-open itself.
const screenRestorers = new Map();
window.pokenScreens = {
  register(name, restore) { screenRestorers.set(name, restore); },
};

function restoreScreenAfterSignIn() {
  const screen = window.pokenAuth?.takeReturn?.();
  if (!screen) return;
  const restore = screenRestorers.get(screen);
  if (!restore) return;
  try { restore(); } catch (e) { console.warn("[Poken] restoring after sign-in failed:", e); }
}

window.pokenScreens.register("landing", () => showLanding());
window.pokenScreens.register("setup", () => {
  landingScreen.style.display = "none";
  setupScreen.style.display = "block";
});
```

Call it once, after the screens and `learn.js` have registered. Add to the end of `app.js`:

```js
// learn.js registers its own restorer when it loads, and it loads after this file.
window.addEventListener("DOMContentLoaded", restoreScreenAfterSignIn);
```

- [ ] **Step 2: Register the Learn restorer and stop routing off the stash**

In `public/learn.js`, replace the stash-driven routing inside the first auth event. The current block is:

```js
    if (firstAuthEvent) {
      firstAuthEvent = false;
      // Back from Google: return to Learn Mode, rebuild the tree that was on screen, and save
      // it if sign-in worked (saveAll below). A cancelled sign-in still gets the tree back.
      if (stash) {
        show();
        if (stash.rows?.length) rebuild(stash.topic, stash.language, stash.rows);
      }
    }
```

Replace it with a rebuild that no longer decides the screen:

```js
    if (firstAuthEvent) {
      firstAuthEvent = false;
      // Back from Google: rebuild the tree that was on screen. Which screen to open is the
      // return intent's job (app.js), so a sign-in started elsewhere doesn't land in Learn Mode.
      if (stash?.rows?.length) rebuild(stash.topic, stash.language, stash.rows);
    }
```

And register the restorer next to it:

```js
  window.pokenScreens?.register("learn", () => show());
```

- [ ] **Step 3: Simplify `stashTree`'s contract**

The comment on `stashTree` in `public/learn.js` says the stash doubles as the routing signal. That is no longer true. Change:

```js
  function stashTree() {
    // Even with no tree, stash so the return from Google lands back in Learn Mode.
```

to:

```js
  function stashTree() {
    // Only the tree's contents; app.js decides which screen the return from Google opens.
```

- [ ] **Step 4: Verify**

Run: `node --check public/app.js && node --check public/learn.js`
Expected: both pass.

Then, with `npm run dev` running, in the browser console on `http://localhost:8000`:

```js
sessionStorage.setItem("poken_return", JSON.stringify({ screen: "setup", ts: Date.now() }));
location.reload();
```

Expected: the page opens on the setup screen rather than the landing screen, and `sessionStorage.getItem("poken_return")` is now `null`. Repeat with `"learn"` and confirm the Learn screen opens.

- [ ] **Step 5: Commit**

```bash
git add public/app.js public/learn.js
git commit -m "Route the return from Google sign-in by recorded intent

Learn Mode decided the post-sign-in screen by whether a tree stash existed,
which only works because sign-in was only reachable from Learn Mode. Screens
now register how to re-open themselves and app.js routes from the record
auth.js wrote, so sign-in can start anywhere. The tree stash goes back to
carrying only the tree."
```

---

### Task 3: One account control, mounted on every screen that wants one

**Files:**
- Modify: `public/index.html` (mount points on landing, setup and reflection; `#learnAccount` gains the attribute)
- Modify: `public/app.js` (the shared `renderAccountControls`)
- Modify: `public/learn.js` (delete its local `renderAccount`, ~lines 713-744)

**Interfaces:**
- Consumes: `window.pokenAuth.onAuthChange`, `.signIn`, `.signOut` from Task 1; the screen names from Task 2.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Add mount points in `public/index.html`**

Give the existing Learn slot the attribute, changing:

```html
        <div class="learn-account" id="learnAccount"></div>
```

to:

```html
        <div class="learn-account" id="learnAccount" data-poken-account="learn"></div>
```

Add one to the landing screen, as the last child of `#landing-screen`:

```html
    <div class="poken-account" data-poken-account="landing"></div>
```

One to the setup screen, as the last child of `#setup-screen`:

```html
    <div class="poken-account" data-poken-account="setup"></div>
```

And one to the reflection screen, immediately before `<div class="reflection-actions">`:

```html
      <div class="poken-account" data-poken-account="reflection"></div>
```

Add the shared styling to the stylesheet, next to `.learn-account`:

```css
    .poken-account { display: flex; align-items: center; justify-content: center; gap: 0.5rem; margin-top: 1.25rem; }
    .poken-account:empty { display: none; }
```

- [ ] **Step 2: Render the control from `public/app.js`**

Add next to the other boot code:

```js
// ── Account control ─────────────────────────────────────────────────────────
// One renderer for every [data-poken-account] mount. The attribute's value is the screen
// name, so signing in from here comes back here. Never gates anything: signed out, the
// app works exactly as it does signed in.
function renderAccountControls(user) {
  for (const mount of document.querySelectorAll("[data-poken-account]")) {
    const screen = mount.getAttribute("data-poken-account") || "landing";
    mount.replaceChildren();
    if (!window.pokenAuth) return;
    if (!user) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "learn-google";
      b.textContent = "Sign in with Google";
      b.addEventListener("click", () => {
        if (typeof window.pokenStashForSignIn === "function") window.pokenStashForSignIn();
        window.pokenAuth.signIn(screen);
      });
      mount.append(b);
      continue;
    }
    const wrap = document.createElement("div");
    wrap.className = "learn-user";
    if (user.avatarUrl) {
      const img = document.createElement("img");
      img.src = user.avatarUrl;
      img.alt = "";
      img.referrerPolicy = "no-referrer";   // Google avatar URLs refuse some referrers
      wrap.append(img);
    }
    const name = document.createElement("span");
    name.textContent = user.name || user.email || "Signed in";
    const out = document.createElement("button");
    out.type = "button";
    out.textContent = "Sign out";
    out.addEventListener("click", () => window.pokenAuth.signOut());
    wrap.append(name, out);
    mount.append(wrap);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  renderAccountControls(null);
  window.pokenAuth?.onAuthChange(renderAccountControls);
});
```

- [ ] **Step 3: Delete Learn Mode's own account renderer**

In `public/learn.js`, delete the whole `function renderAccount() { … }` body (it ends at the line after `accountEl.append(wrap);`) and replace it with a call through to the shared one, so the existing call sites keep working:

```js
  // The control itself is rendered by app.js for every [data-poken-account] mount.
  function renderAccount() {
    if (typeof window.renderAccountControls === "function") window.renderAccountControls(user);
  }
```

Export the renderer from `app.js` by adding this line directly after the `renderAccountControls` function:

```js
window.renderAccountControls = renderAccountControls;
```

Have Learn Mode stash its tree before any sign-in, wherever it starts. Add next to the `signIn` function in `learn.js`:

```js
  // Any sign-in anywhere may navigate away, so the tree has to be stashed first.
  window.pokenStashForSignIn = () => { stashTree(); leavingForSignIn = true; };
```

- [ ] **Step 4: Verify**

Run: `node --check public/app.js && node --check public/learn.js && node scripts/test-auth-return.mjs`
Expected: all pass.

Then run through the behavioural matrix with `npm run dev`:

1. Landing shows a Sign in with Google button; setup shows one; the reflection screen shows one; Learn still shows its own in the header.
2. Sign in from the landing button. Expected: after Google, the page returns to the landing screen, signed in, showing avatar and Sign out.
3. Sign in from the setup screen. Expected: returns to setup, signed in.
4. Sign in from Learn with an unsaved tree. Expected: returns to Learn, the tree is intact, and it saves.
5. Cancel at Google's consent screen. Expected: back on the same screen, still signed out, nothing lost.
6. Sign out from each mount. Expected: stays on the screen, no redirect, every mount updates at once.
7. Click the Learn save banner's "Sign in with Google to keep it". Expected: unchanged behaviour — it stashes the tree and returns to Learn Mode, because `learn.js`'s own `signIn()` calls `store().signInWithGoogle()`, which Task 1 re-exported as `auth().signIn("learn")`. This button is deliberately left alone: asking at the moment the user has something to lose is the strongest prompt in the app.
8. Set `window.POKEN_SUPABASE = { url: "https://example.invalid", key: "x" }` before load. Expected: the Sign in button still renders (the client is lazy, so nothing knows it is broken until it is used), clicking it logs one `[Poken][Auth] signIn failed` warning, and both teaching and learning keep working. What must NOT happen is an unhandled rejection or a dead screen.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/app.js public/learn.js
git commit -m "Let the user sign in from anywhere, not just Learn Mode

Sign-in was only reachable from the Learn screen, so someone who came to
Poken to teach never saw it. One renderer now fills every element marked
data-poken-account — landing, setup, learn and reflection — and the mount
names the screen to come back to. Deliberately not in the live session
header: it is already crowded and an accidental sign-out mid-lesson would
drop the save path underneath a running session."
```

---

## Notes for the executor

- **Do not add a mount to `#session-screen`.** That is a design decision, not an omission.
- **Nothing here may gate a flow.** If a step seems to require a signed-in user, stop; the plan is wrong.
- **Supabase's redirect allow-list is a prerequisite.** If sign-in redirects to Google and comes back signed out, check that `https://poken.live/**` is in Supabase → Authentication → URL Configuration before debugging the code.
