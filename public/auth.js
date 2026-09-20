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
