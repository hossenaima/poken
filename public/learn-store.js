// ── Learn Mode storage (Phase 4) ─────────────────────────────────────────────
// The browser talks to Supabase directly; the Node server stays stateless.
// Every function below is async, never throws, and returns a documented failure
// value — persistence must never break learning. See docs/LEARN_MODE_PLAN.md §4b.
(() => {
  // Public by design: the publishable key only identifies the project; Row-Level Security
  // on every table is what protects data. Never put a secret / service_role key here.
  const SUPABASE_URL = "https://qdaqmtgfikkrtnjsjmnu.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_bv-rl4U4GZVc1j7gb8eTbQ_7BdK0hX8";

  const SUPABASE_JS_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/+esm";
  const DIAGRAM_BUCKET = "learn-diagrams";
  const SIGNED_URL_TTL_S = 3600;
  const TOPIC_LIST_LIMIT = 50;

  const warn = (what, err) => {
    const detail = err && (err.message || err.error_description || err.msg || String(err));
    console.warn(`[Poken][Store] ${what}${detail ? `: ${detail}` : ""}`);
  };

  // ── Client (lazy, memoized) ──────────────────────────────────────────────
  let clientPromise = null;
  function client() {
    if (!clientPromise) {
      clientPromise = import(SUPABASE_JS_URL)
        .then(({ createClient }) => createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY))
        .catch((err) => { clientPromise = null; throw err; });
    }
    return clientPromise;
  }

  // ── Auth ─────────────────────────────────────────────────────────────────
  let readyPromise = null;
  async function ready() {
    if (!readyPromise) {
      readyPromise = (async () => {
        const sb = await client();
        const { data: sessionData, error: sessionErr } = await sb.auth.getSession();
        if (sessionErr) throw sessionErr;
        if (sessionData?.session?.user?.id) return sessionData.session.user.id;
        const { data, error } = await sb.auth.signInAnonymously();
        if (error) throw error;
        const id = data?.user?.id || data?.session?.user?.id;
        if (!id) throw new Error("anonymous sign-in returned no user");
        return id;
      })().catch((err) => {
        readyPromise = null;
        warn("ready failed", err);
        return null;
      });
    }
    return readyPromise;
  }

  async function authed() {
    const userId = await ready();
    if (!userId) return null;
    return { sb: await client(), userId };
  }

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
    "after_block", "body", "extras", "image_path",
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
    ready, listTopics, createTopic, saveNode, loadTree, deleteTopic, uploadDiagram, diagramUrl,
  };
})();
