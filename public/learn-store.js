// ── Learn Mode storage (Phase 4) ─────────────────────────────────────────────
// The browser talks to Supabase directly; the Node server stays stateless.
// Every function below is async, never throws, and returns a documented failure
// value — persistence must never break learning. See docs/LEARN_MODE_PLAN.md §4b.
// Saving needs a signed-in (Google) user; signed out, every data function returns
// its failure value and nothing is persisted. No anonymous users are ever created.
(() => {
  // Public by design: the publishable key only identifies the project; Row-Level Security
  // on every table is what protects data. Never put a secret / service_role key here.
  // window.POKEN_SUPABASE = { url, key } (set before this script) points at another
  // project, e.g. the local stack in tests.
  const override = window.POKEN_SUPABASE || {};
  const SUPABASE_URL = override.url || "https://poken.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY = override.key || "sb_publishable_bv-rl4U4GZVc1j7gb8eTbQ_7BdK0hX8";

  const SUPABASE_JS_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/+esm";
  const DIAGRAM_BUCKET = "learn-diagrams";
  const SIGNED_URL_TTL_S = 3600;
  const TOPIC_LIST_LIMIT = 50;
  const AUTH_EVENTS = new Set(["INITIAL_SESSION", "SIGNED_IN", "SIGNED_OUT", "USER_UPDATED"]);
  const AUTH_QUERY_PARAMS = ["code", "state", "error", "error_code", "error_description"];
  const AUTH_HASH_PARAMS = [
    "access_token", "refresh_token", "expires_in", "expires_at", "token_type", "type",
    "provider_token", "provider_refresh_token", "error", "error_code", "error_description",
  ];

  const detailOf = (err) => err && (err.message || err.error_description || err.msg || String(err));
  const warn = (what, err) => {
    const detail = detailOf(err);
    console.warn(`[Poken][Store] ${what}${detail ? `: ${detail}` : ""}`);
  };

  // ── Client (lazy, memoized) ──────────────────────────────────────────────
  let clientPromise = null;
  function client() {
    if (!clientPromise) {
      clientPromise = import(SUPABASE_JS_URL)
        .then(({ createClient }) => {
          const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
            auth: { flowType: "pkce" },
          });
          sb.auth.onAuthStateChange(() => { readyPromise = null; });
          return sb;
        })
        .catch((err) => { clientPromise = null; throw err; });
    }
    return clientPromise;
  }

  // ── Auth ─────────────────────────────────────────────────────────────────
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

  async function currentSessionUser() {
    const sb = await client();
    const { data, error } = await sb.auth.getSession();
    if (error) throw error;
    return data?.session?.user || null;
  }

  let signedOutNoted = false;
  let readyPromise = null;
  // The signed-in user's id, or null. Never signs in. The memoized promise is dropped on
  // every auth event (and whenever it resolves to null) so sign-in/out is reflected.
  function ready() {
    if (!readyPromise) {
      const p = (async () => {
        const user = await currentSessionUser();
        if (user?.id) return user.id;
        if (!signedOutNoted) {
          signedOutNoted = true;
          console.info("[Poken][Store] not signed in — the tree is kept in memory only");
        }
        return null;
      })()
        .catch((err) => { warn("ready failed", err); return null; })
        .then((id) => { if (!id && readyPromise === p) readyPromise = null; return id; });
      readyPromise = p;
    }
    return readyPromise;
  }

  async function authed() {
    const userId = await ready();
    if (!userId) return null;
    return { sb: await client(), userId };
  }

  async function currentUser() {
    try {
      return toUser(await currentSessionUser());
    } catch (err) {
      warn("currentUser failed", err);
      return null;
    }
  }

  async function signInWithGoogle() {
    try {
      const sb = await client();
      const { error } = await sb.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: location.origin + location.pathname },
      });
      if (error) throw error;
      return true;
    } catch (err) {
      warn("signInWithGoogle failed", err);
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

  // ── Topics ───────────────────────────────────────────────────────────────
  async function listTopics() {
    try {
      const ctx = await authed();
      if (!ctx) return [];
      const { data, error } = await ctx.sb
        .from("learn_topics")
        .select("id, title, language, updated_at")
        .order("updated_at", { ascending: false })
        .limit(TOPIC_LIST_LIMIT);
      if (error) throw error;
      return data || [];
    } catch (err) {
      warn("listTopics failed", err);
      return [];
    }
  }

  async function createTopic({ title, language } = {}) {
    try {
      const ctx = await authed();
      if (!ctx) return null;
      const { data, error } = await ctx.sb
        .from("learn_topics")
        .insert(compact({ title, language }))
        .select("id")
        .single();
      if (error) throw error;
      return data?.id ?? null;
    } catch (err) {
      warn("createTopic failed", err);
      return null;
    }
  }

  async function deleteTopic(id) {
    try {
      const ctx = await authed();
      if (!ctx) return false;
      await removeTopicDiagrams(ctx, id);
      const { error } = await ctx.sb.from("learn_topics").delete().eq("id", id);
      if (error) throw error;
      return true;
    } catch (err) {
      warn("deleteTopic failed", err);
      return false;
    }
  }

  // Best effort: a failure here must not stop the topic itself from being deleted.
  async function removeTopicDiagrams({ sb, userId }, topicId) {
    try {
      const { data, error } = await sb
        .from("learn_nodes")
        .select("image_path")
        .eq("topic_id", topicId)
        .not("image_path", "is", null);
      if (error) throw error;
      const paths = (data || []).map((n) => n.image_path).filter(Boolean);
      if (!paths.length) return;
      const { error: rmErr } = await sb.storage.from(DIAGRAM_BUCKET).remove(paths);
      if (rmErr) throw rmErr;
    } catch (err) {
      warn(`removing diagrams for topic ${topicId} failed (${userId})`, err);
    }
  }

  // ── Nodes ────────────────────────────────────────────────────────────────
  const NODE_COLUMNS = [
    "id", "topic_id", "parent_id", "kind", "label", "question",
    "after_block", "body", "extras", "image_path", "created_at",
  ];

  async function saveNode(row) {
    try {
      const ctx = await authed();
      if (!ctx) return false;
      const payload = {};
      for (const key of NODE_COLUMNS) {
        if (row && row[key] !== undefined) payload[key] = row[key];
      }
      const { error } = await ctx.sb
        .from("learn_nodes")
        .upsert(payload, { onConflict: "id" });
      if (error) throw error;
      return true;
    } catch (err) {
      warn("saveNode failed", err);
      return false;
    }
  }

  async function loadTree(topicId) {
    try {
      const ctx = await authed();
      if (!ctx) return null;
      const [topicRes, nodesRes] = await Promise.all([
        ctx.sb.from("learn_topics").select("*").eq("id", topicId).maybeSingle(),
        ctx.sb.from("learn_nodes").select("*").eq("topic_id", topicId)
          .order("created_at", { ascending: true }),
      ]);
      if (topicRes.error) throw topicRes.error;
      if (nodesRes.error) throw nodesRes.error;
      if (!topicRes.data) return null;
      return { topic: topicRes.data, nodes: nodesRes.data || [] };
    } catch (err) {
      warn("loadTree failed", err);
      return null;
    }
  }

  // ── Diagrams ─────────────────────────────────────────────────────────────
  async function uploadDiagram(nodeId, base64, mimeType) {
    try {
      const ctx = await authed();
      if (!ctx) return null;
      const path = `${ctx.userId}/${nodeId}.png`;
      const bytes = base64ToBytes(base64);
      const { error } = await ctx.sb.storage
        .from(DIAGRAM_BUCKET)
        .upload(path, bytes, { contentType: mimeType || "image/png", upsert: true });
      if (error) throw error;
      return path;
    } catch (err) {
      warn("uploadDiagram failed", err);
      return null;
    }
  }

  async function diagramUrl(path) {
    try {
      const ctx = await authed();
      if (!ctx) return null;
      const { data, error } = await ctx.sb.storage
        .from(DIAGRAM_BUCKET)
        .createSignedUrl(path, SIGNED_URL_TTL_S);
      if (error) throw error;
      return data?.signedUrl ?? null;
    } catch (err) {
      warn("diagramUrl failed", err);
      return null;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  function compact(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
    return out;
  }

  function base64ToBytes(base64) {
    const raw = String(base64).replace(/^data:[^;]+;base64,/, "");
    const bin = atob(raw);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  window.pokenStore = {
    ready, currentUser, signInWithGoogle, signOut, onAuthChange,
    listTopics, createTopic, saveNode, loadTree, deleteTopic, uploadDiagram, diagramUrl,
  };
})();
