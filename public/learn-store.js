// ── Learn Mode storage (Phase 4) ─────────────────────────────────────────────
// The browser talks to Supabase directly; the Node server stays stateless.
// Every function below is async, never throws, and returns a documented failure
// value — persistence must never break learning. See docs/LEARN_MODE_PLAN.md §4b.
// Saving needs a signed-in (Google) user; signed out, every data function returns
// its failure value and nothing is persisted. No anonymous users are ever created.
(() => {
  const DIAGRAM_BUCKET = "learn-diagrams";
  const SIGNED_URL_TTL_S = 3600;
  const TOPIC_LIST_LIMIT = 50;

  const detailOf = (err) => err && (err.message || err.error_description || err.msg || String(err));
  const warn = (what, err) => {
    const detail = detailOf(err);
    console.warn(`[Poken][Store] ${what}${detail ? `: ${detail}` : ""}`);
  };

  let signedOutNoted = false;
  let readyPromise = null;
  // The client and every identity concern live in auth.js; this module only stores things.
  const auth = () => window.pokenAuth;
  const client = () => auth().client();
  auth().onAuthReset(() => { readyPromise = null; });

  async function currentSessionUser() {
    const sb = await client();
    const { data, error } = await sb.auth.getSession();
    if (error) throw error;
    return data?.session?.user || null;
  }

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
    "after_block", "body", "extras", "image_path", "mastery", "created_at",
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

  // Explanations across every saved topic that mention any of these words. Used when an open
  // question has no tree of its own, so the answer may be sitting in something else you studied.
  // Filtering in Postgres rather than pulling every node down: bodies run to 20k chars each.
  const NODE_SEARCH_LIMIT = 60;

  async function searchNodes(words, limit = NODE_SEARCH_LIMIT) {
    try {
      const ctx = await authed();
      // `or` takes a comma-separated filter list, so a word containing a comma, parenthesis or
      // wildcard would change the query's shape. wordsOf upstream keeps letters and digits only;
      // this is the belt to that braces.
      const safe = (Array.isArray(words) ? words : [])
        .map(w => String(w).replace(/[^\p{L}\p{N}]/gu, ""))
        .filter(w => w.length > 2)
        .slice(0, 6);
      if (!ctx || !safe.length) return [];
      const { data, error } = await ctx.sb
        .from("learn_nodes")
        .select("id, topic_id, body")
        .or(safe.map(w => `body.ilike.%${w}%`).join(","))
        .limit(limit);
      if (error) throw error;
      return (data || []).map(r => ({ id: r.id, topicId: r.topic_id, body: r.body || "" }));
    } catch (err) {
      warn("searchNodes failed", err);
      return [];
    }
  }

  // ── Open questions ───────────────────────────────────────────────────────
  // Questions a student asked that the teacher left hanging. Grouped per topic by
  // topic_title, which is the one key present whether or not the session was taught off a
  // Learn Mode tree. Closing is a timestamp, never a delete.
  const OPEN_QUESTION_REASONS = ["deferred", "skipped", "wrong", "unanswered"];
  const OPEN_QUESTION_LIST_LIMIT = 200;

  // Exported for the tests; snake_case in the database, camelCase in the API.
  function toOpenQuestion(row) {
    if (!row || typeof row !== "object") return null;
    return {
      id: row.id,
      topicId: row.topic_id ?? null,
      topicTitle: row.topic_title || "",
      language: row.language || "English",
      question: row.question || "",
      reason: row.reason,
      createdAt: row.created_at || null,
      closedAt: row.closed_at ?? null,
    };
  }

  // Rejects anything the table's check constraints would reject, so a bad model output
  // fails here with a warning instead of as an opaque 400 from PostgREST.
  function toOpenQuestionRow(q, topic, userId) {
    if (!q || typeof q !== "object") return null;
    const question = typeof q.question === "string" ? q.question.trim() : "";
    const title = typeof topic?.title === "string" ? topic.title.trim() : "";
    if (!q.id || !question || question.length > 1000) return null;
    if (!OPEN_QUESTION_REASONS.includes(q.reason)) return null;
    if (!title || title.length > 200) return null;
    return {
      id: q.id,
      user_id: userId,
      topic_id: topic.id || null,
      topic_title: title,
      language: (topic.language || "English").slice(0, 40),
      question,
      reason: q.reason,
    };
  }

  async function listOpenQuestions({ includeClosed = false } = {}) {
    try {
      const ctx = await authed();
      if (!ctx) return [];
      let q = ctx.sb
        .from("open_questions")
        .select("id, topic_id, topic_title, language, question, reason, created_at, closed_at")
        .order("created_at", { ascending: false })
        .limit(OPEN_QUESTION_LIST_LIMIT);
      if (!includeClosed) q = q.is("closed_at", null);
      const { data, error } = await q;
      if (error) throw error;
      return (data || []).map(toOpenQuestion).filter(Boolean);
    } catch (err) {
      warn("listOpenQuestions failed", err);
      return [];
    }
  }

  async function saveOpenQuestions(topic, questions) {
    try {
      const ctx = await authed();
      if (!ctx) return 0;
      const rows = (Array.isArray(questions) ? questions : [])
        .map(q => toOpenQuestionRow(q, topic || {}, ctx.userId))
        .filter(Boolean);
      if (!rows.length) return 0;
      const { error } = await ctx.sb.from("open_questions").upsert(rows, { onConflict: "id" });
      if (error) throw error;
      return rows.length;
    } catch (err) {
      warn("saveOpenQuestions failed", err);
      return 0;
    }
  }

  async function setOpenQuestionClosed(id, closedAt) {
    try {
      const ctx = await authed();
      if (!ctx || !id) return false;
      const { error } = await ctx.sb
        .from("open_questions")
        .update({ closed_at: closedAt })
        .eq("id", id);
      if (error) throw error;
      return true;
    } catch (err) {
      warn("setOpenQuestionClosed failed", err);
      return false;
    }
  }

  const closeOpenQuestion  = (id) => setOpenQuestionClosed(id, new Date().toISOString());
  const reopenOpenQuestion = (id) => setOpenQuestionClosed(id, null);

  window.pokenStore = {
    ready,
    currentUser: (...a) => auth().currentUser(...a),
    signInWithGoogle: () => auth().signIn("learn"),
    signOut: (...a) => auth().signOut(...a),
    onAuthChange: (...a) => auth().onAuthChange(...a),
    listTopics, createTopic, saveNode, loadTree, deleteTopic, uploadDiagram, diagramUrl, searchNodes,
    listOpenQuestions, saveOpenQuestions, closeOpenQuestion, reopenOpenQuestion,
    _openQuestions: { toOpenQuestion, toOpenQuestionRow, OPEN_QUESTION_REASONS },
  };
})();
