// ── Learn Mode ───────────────────────────────────────────────────────────────
// A knowledge tree: the root is the topic's explanation; every drag-select → "Go deeper"
// (or Ask / Simplify / Show me) spawns a child node rendered right under the block it came
// from. Trees are saved to Supabase through window.pokenStore (public/learn-store.js) when
// it's present; without it, or while Supabase is unreachable, everything still works in
// memory. See docs/LEARN_MODE_PLAN.md.
(() => {
  const screen     = document.getElementById("learn-screen");
  const form       = document.getElementById("learnForm");
  const topicEl    = document.getElementById("learnTopic");
  const langEl     = document.getElementById("learnLanguage");
  const goBtn      = document.getElementById("learnGoBtn");
  const treeEl     = document.getElementById("learnTree");
  const hintEl     = document.getElementById("learnHint");
  const topicsEl   = document.getElementById("learnTopics");
  const topicsBtn  = document.getElementById("learnTopicsBtn");
  const toolbar    = document.getElementById("learnToolbar");
  const deeperBtn  = document.getElementById("learnDeeperBtn");
  const askBtn     = document.getElementById("learnAskBtn");
  const simplifyBtn = document.getElementById("learnSimplifyBtn");
  const visualBtn  = document.getElementById("learnVisualBtn");
  const actionsEl  = document.getElementById("learnToolbarActions");
  const askForm    = document.getElementById("learnAskForm");
  const askInput   = document.getElementById("learnAskInput");
  const teachBtn   = document.getElementById("learnTeachBtn");
  const backBtn    = document.getElementById("learnBackBtn");
  const learnFirst = document.getElementById("learnFirstBtn");
  const landing    = document.getElementById("landing-screen");
  const accountEl  = document.getElementById("learnAccount");
  const bannerEl   = document.getElementById("learnSaveBanner");

  // Persistence is optional: learn-store.js defines window.pokenStore (never throws).
  // Saving needs a signed-in (Google) user; signed out, the tree lives in memory only.
  // A store without the accounts API (onAuthChange etc., #25) is treated as absent.
  const store = () => (typeof window.pokenStore?.onAuthChange === "function" ? window.pokenStore : null);
  let user = null;               // { id, email, name, avatarUrl } while signed in
  let bannerDismissed = false;   // per page load
  let leavingForSignIn = false;  // suppress the leave warning during the Google redirect

  // ── Tree ────────────────────────────────────────────────────────────────
  let topic = "";
  // node: { id (uuid), seq, createdAt, parentId, kind, label, question, afterBlock, text, el, streaming,
  //         terms?, suggestions?, suggestEl?, imagePath?, imageData? }   label = selection or question
  // imageData = { base64, mimeType } of a diagram drawn while signed out, uploaded on sign-in.
  let nodes = [];
  let seq = 0;             // creation order ("oldest first" when trimming teaching notes)
  let topicId = null;      // this tree's learn_topics row, once saved
  let topicReady = null;   // Promise<topicId|null>; node saves wait on it
  let pending = null;      // current selection: { nodeId, blockIdx, text, context }
  let askMode = false;     // toolbar shows the question input; ignore selection changes meanwhile
  let streamingCount = 0;

  const byId = (id) => nodes.find(n => n.id === id);
  const chainOf = (node) => {           // ancestors' labels, root → node (root has none)
    const out = [];
    for (let n = node; n && n.parentId != null; n = byId(n.parentId)) out.unshift({ selection: n.label });
    return out;
  };
  // Paragraphs are the blocks. The prompt forbids markdown and citations, but the model
  // sometimes emphasizes with *asterisks* or adds [1]-style markers anyway; strip both so
  // they never show (or reach the teaching notes).
  const blocksOf = (text) => text.split(/\n\s*\n/)
    .map(s => s.replace(/\*{1,2}([^*\n]+?)\*{1,2}/g, "$1").replace(/\s?\[\d+(?:\s*,\s*\d+)*\]/g, "").trim())
    .filter(Boolean);

  function reset() {
    nodes = []; seq = 0; pending = null; streamingCount = 0;
    topicId = null; topicReady = null;
    treeEl.innerHTML = "";
    hideToolbar();
    teachBtn.disabled = true;
    updateBanner();
  }

  // ── Saving ──────────────────────────────────────────────────────────────
  // Fire-and-forget: a failed save never interrupts learning (the store logs it).
  // Only for a signed-in user; otherwise topicReady stays null and nothing is written.
  function startSavedTopic(title, language) {
    const s = store();
    topicReady = null;
    if (!s || !user) return;
    topicReady = s.createTopic({ title, language }).then(id => (topicId = id));
  }

  // Per node, so the warning stays honest after a sign-out (what's already saved, stays saved).
  const hasUnsavedWork = () => nodes.some(n => (n.text.trim() || n.imageData) && !n.saved);

  // Signed in with a tree that isn't saved yet (made while signed out, or carried across the
  // Google redirect): create the topic and write every node, parents first.
  async function saveAll() {
    const s = store();
    if (!s || !user || topicReady || !nodes.length || !hasUnsavedWork()) return;
    startSavedTopic(topic, langEl.value);
    if (!(await topicReady)) return;
    for (const node of [...nodes].sort((a, b) => a.seq - b.seq)) {
      if (node.imageData && !node.imagePath) {
        node.imagePath = await s.uploadDiagram(node.id, node.imageData.base64, node.imageData.mimeType);
        if (node.imagePath) node.imageData = null;
      }
      await persist(node);
    }
    updateBanner();
  }

  async function persist(node) {
    const s = store();
    if (!s || !topicReady || !byId(node.id)) return;
    if (!node.text.trim() && !node.imagePath) return;   // nothing worth saving (e.g. a failed branch)
    const tid = await topicReady;
    if (!tid || tid !== topicId) return;                 // not saved, or the tree was switched
    const ok = await s.saveNode({
      id: node.id,
      topic_id: tid,
      parent_id: node.parentId,
      kind: node.kind,
      label: node.label,
      question: node.question,
      after_block: node.afterBlock,
      // Creation time, not first-save time: a quick branch finishes (and saves) before a slow
      // sibling, and loadTree orders by created_at — siblings would come back swapped.
      created_at: node.createdAt,
      mastery: node.mastery,
      body: node.text,
      extras: node.terms || node.suggestions ? { keyTerms: node.terms || [], suggestions: node.suggestions || [] } : null,
      image_path: node.imagePath || null,
    });
    if (ok) node.saved = true;
    updateBanner();
  }

  // ── Render ──────────────────────────────────────────────────────────────
  function crumbHtml(node) {
    const trail = [topic, ...chainOf(node).map(c => c.selection)];
    return trail.map((t, i) => i === trail.length - 1 ? `<b>${esc(t)}</b>` : esc(t)).join(" → ");
  }
  const esc = (s) => s.replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

  function renderBlocks(node) {
    // Children hang off specific blocks; keep them attached across re-renders.
    const children = new Map();
    node.el.querySelectorAll(":scope > .learn-node.child").forEach(el => {
      const i = Number(el.dataset.afterBlock);
      children.set(i, [...(children.get(i) || []), el]);
    });
    node.el.querySelectorAll(":scope > .learn-block, :scope > .learn-node.child").forEach(el => el.remove());
    const usedTerms = new Set();   // gloss each key term once per node, at its first occurrence
    blocksOf(node.text).forEach((text, i) => {
      const p = document.createElement("p");
      p.className = "learn-block";
      p.dataset.nodeId = node.id;
      p.dataset.blockIdx = i;
      decorateTerms(p, text, node.terms, usedTerms);
      node.el.appendChild(p);
      for (const child of children.get(i) || []) node.el.appendChild(child);
    });
    if (node.suggestEl) node.el.appendChild(node.suggestEl);   // suggestions stay last
  }

  // Wrap the first occurrence of each key term in a span that shows its gloss on hover/focus.
  // Text-only DOM (textContent/createElement), so model output is never parsed as HTML.
  function decorateTerms(p, text, terms, used) {
    if (!terms?.length) { p.append(text); return; }
    const lower = text.toLowerCase();
    const hits = [];
    for (const t of terms) {
      const key = t.term.toLowerCase();
      if (used.has(key)) continue;
      const at = lower.indexOf(key);
      if (at >= 0) hits.push({ at, end: at + key.length, t, key });
    }
    hits.sort((a, b) => a.at - b.at);
    let cursor = 0;
    for (const h of hits) {
      if (h.at < cursor) continue;   // overlaps a term already wrapped
      p.append(text.slice(cursor, h.at));
      const span = document.createElement("span");
      span.className = "learn-term";
      span.tabIndex = 0;
      span.dataset.gloss = h.t.gloss;
      span.textContent = text.slice(h.at, h.end);
      p.append(span);
      cursor = h.end;
      used.add(h.key);
    }
    p.append(text.slice(cursor));
  }

  // Key-term glosses + "go deeper" suggestion chips (fresh from the server or from a saved tree).
  function applyExtras(node, { keyTerms = [], suggestions = [] }) {
    node.terms = keyTerms;
    node.suggestions = [...suggestions];
    node.suggestEl = null;
    if (node.suggestions.length) {
      const row = document.createElement("div");
      row.className = "learn-suggest";
      const label = document.createElement("span");
      label.className = "learn-suggest-label";
      label.textContent = "Go deeper:";
      row.append(label);
      for (const s of node.suggestions) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = s;
        b.addEventListener("click", () => {
          b.remove();
          node.suggestions = node.suggestions.filter(x => x !== s);
          if (!row.querySelector("button")) { row.remove(); node.suggestEl = null; }
          persist(node);   // a used suggestion stays used after reload
          const blocks = blocksOf(node.text);
          spawn({ nodeId: node.id, blockIdx: blocks.length - 1, text: s }, "deeper", "", node.text);
        });
        row.append(b);
      }
      node.suggestEl = row;
    }
    renderBlocks(node);
  }

  // After a node finishes. Optional — on any failure the explanation simply stays as it is.
  async function addExtras(node) {
    try {
      const res = await fetch("/api/learn/extras", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, text: blocksOf(node.text).join("\n\n"), language: langEl.value }),
      });
      if (!res.ok) return;
      const extras = await res.json();
      if (!byId(node.id)) return;   // tree was reset meanwhile
      applyExtras(node, extras);
      persist(node);
    } catch (_) { /* extras are optional */ }
  }

  function showFigure(node, src, alt) {
    const fig = document.createElement("figure");
    fig.className = "learn-figure";
    const img = document.createElement("img");
    img.src = src;
    img.alt = alt;
    const cap = document.createElement("figcaption");
    cap.textContent = "AI-generated diagram — check labels against the explanation.";
    fig.append(img, cap);
    node.el.appendChild(fig);
  }

  function createNode(parentId, label, afterBlockIdx, question = "", { id, kind, createdAt, mastery } = {}) {
    const node = {
      id: id || crypto.randomUUID(), seq: seq++, createdAt: createdAt || new Date().toISOString(),
      mastery: mastery || "read",
      parentId, kind: kind || (parentId == null ? "root" : "deeper"),
      label, question, afterBlock: parentId == null ? null : afterBlockIdx,
      text: "", el: document.createElement("div"), streaming: true,
    };
    node.el.className = "learn-node" + (parentId != null ? " child" : "");
    node.el.dataset.nodeId = node.id;
    node.el.dataset.mastery = node.mastery;
    node.el.innerHTML = `<div class="learn-crumb">${crumbHtml(node)}</div>`
      + (question ? `<p class="learn-question">Q: ${esc(question)}</p>` : "")
      + `<div class="learn-thinking" role="status"><span class="learn-spinner"></span><span>Thinking…</span></div>`;
    nodes.push(node);
    if (parentId == null) {
      treeEl.appendChild(node.el);
    } else {
      node.el.dataset.afterBlock = afterBlockIdx;
      const parent = byId(parentId);
      const anchor = parent.el.querySelector(`:scope > .learn-block[data-block-idx="${afterBlockIdx}"]`);
      if (!anchor) {
        parent.el.appendChild(node.el);   // saved tree whose paragraph count changed; keep it visible
      } else {
        // Insert after the anchor block and after any children already hanging off it.
        let after = anchor;
        while (after.nextElementSibling && after.nextElementSibling.classList.contains("child")) after = after.nextElementSibling;
        after.insertAdjacentElement("afterend", node.el);
      }
    }
    return node;
  }

  // ── Streaming ───────────────────────────────────────────────────────────
  async function explain(node, body) {
    node.el.classList.add("streaming");
    streamingCount++;
    setGoBusy(true);
    // "Thinking…" until the first words arrive; say more if it's taking long, so a slow
    // connection doesn't look like a hang.
    const thinking = node.el.querySelector(".learn-thinking");
    const slowTimer = setTimeout(() => {
      if (thinking?.isConnected) thinking.lastElementChild.textContent = "Still thinking… this can take a moment on a slow connection.";
    }, 8000);
    const stopThinking = () => { clearTimeout(slowTimer); thinking?.remove(); };
    try {
      const res = await fetch("/api/learn/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop();
        for (const ev of events) {
          const line = ev.split("\n").find(l => l.startsWith("data:"));
          if (!line) continue;
          const msg = JSON.parse(line.slice(5));
          if (msg.error) throw new Error(msg.error);
          if (msg.text) { stopThinking(); node.text += msg.text; renderBlocks(node); }
        }
      }
      if (!node.text) throw new Error("No explanation came back. Try again.");
      persist(node);
      updateBanner();
      addExtras(node);   // not awaited: the explanation is usable now
    } catch (e) {
      node.text = "";     // a half-written explanation isn't saved
      const err = document.createElement("p");
      err.className = "learn-error";
      err.textContent = (e instanceof TypeError ? "Couldn't reach the server — check your connection and try again." : e.message) || "Explanation failed.";
      node.el.appendChild(err);
    } finally {
      stopThinking();
      node.streaming = false;
      node.el.classList.remove("streaming");
      streamingCount--;
      setGoBusy(streamingCount > 0);
      teachBtn.disabled = nodes.length === 0;
    }
  }

  function setGoBusy(busy) {
    goBtn.disabled = busy;
    goBtn.innerHTML = busy ? '<span class="learn-spinner"></span>Learning…' : "Learn";
  }

  // ── Selection → toolbar ─────────────────────────────────────────────────
  function hideToolbar() {
    toolbar.hidden = true; pending = null; askMode = false;
    askForm.hidden = true; actionsEl.hidden = false; askInput.value = "";
  }

  function showToolbarFor(range, { node, blockIdx, text, context }) {
    pending = { nodeId: node.id, blockIdx, text, context };
    const r = range.getBoundingClientRect();
    toolbar.hidden = false;
    toolbar.style.left = `${r.left + r.width / 2 + window.scrollX}px`;
    toolbar.style.top  = `${r.top + window.scrollY}px`;
  }

  document.addEventListener("selectionchange", () => {
    if (screen.style.display === "none" || !screen.style.display) return;
    if (askMode) return;   // typing the question moves the selection into the input
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { hideToolbar(); return; }
    const range = sel.getRangeAt(0);
    const info = selectionInfo(range);
    if (!info || info.node.streaming || info.text.length < 2) { hideToolbar(); return; }
    showToolbarFor(range, info);
  });

  // The selected text within ONE explanation, possibly across several of its paragraphs.
  // A selection that runs on into a nested explanation is clamped to the one it started in.
  // The branch attaches under the last selected paragraph; all selected paragraphs are context.
  function selectionInfo(range) {
    const blockOf = (n) => (n.nodeType === 1 ? n : n.parentElement)?.closest(".learn-block");
    const anchor = blockOf(range.startContainer) || blockOf(range.endContainer);
    if (!anchor) return null;
    const node = byId(anchor.dataset.nodeId);
    if (!node) return null;
    const blocks = [...node.el.querySelectorAll(":scope > .learn-block")].filter(b => range.intersectsNode(b));
    // Character offset of a DOM boundary within the block's text (terms are nested spans).
    const offsetIn = (b, container, offset) => {
      const r = document.createRange();
      r.selectNodeContents(b);
      r.setEnd(container, offset);
      return r.toString().length;
    };
    // Dragging selects characters, not words: widen a boundary that splits a word ("detec|ts")
    // to the whole word. Not for Han characters — no spaces, so "the word" would be the sentence.
    const inWord = (c) => !!c && /[\p{L}\p{N}]/u.test(c) && !/\p{Script=Han}/u.test(c);
    const parts = blocks.map(b => {
      const full = b.textContent;
      let s = b.contains(range.startContainer) ? offsetIn(b, range.startContainer, range.startOffset) : 0;
      let e = b.contains(range.endContainer) ? offsetIn(b, range.endContainer, range.endOffset) : full.length;
      while (s > 0 && inWord(full[s - 1]) && inWord(full[s])) s--;
      while (e < full.length && inWord(full[e]) && inWord(full[e - 1])) e++;
      return full.slice(s, e).replace(/\s+/g, " ").trim();
    });
    const used = blocks.filter((_, i) => parts[i]);
    if (!used.length) return null;
    return {
      node,
      blockIdx: Number(used[used.length - 1].dataset.blockIdx),
      text: parts.filter(Boolean).join("\n\n"),
      context: used.map(b => b.textContent).join("\n\n"),
    };
  }

  // Keep the toolbar's own clicks from clearing the selection first (but let the input take focus).
  toolbar.addEventListener("mousedown", e => { if (e.target !== askInput) e.preventDefault(); });

  // Branch off a selection. mode: "deeper" | "ask" (with question) | "simplify" | "visual".
  function spawn({ nodeId, blockIdx, text, context }, mode, question = "", parentTextOverride = "") {
    const parent = byId(nodeId);
    const parentText = parentTextOverride || context || blocksOf(parent.text)[blockIdx] || "";
    // Breadcrumb label: a multi-paragraph selection would make an unreadable trail. Also keeps
    // labels inside the database's 400-char limit (a question's full text is saved separately).
    const shorten = (s) => { const f = s.replace(/\s+/g, " "); return f.length > 90 ? `${f.slice(0, 90).trimEnd()}…` : f; };
    const short = shorten(text);
    const label = mode === "ask" ? shorten(question)
      : mode === "simplify" ? `In simpler words: ${short}`
      : mode === "visual" ? `Picture: ${short}`
      : short;
    const node = createNode(nodeId, label, blockIdx, question, { kind: mode });
    node.el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    if (mode === "visual") return draw(node, { topic, selection: text, parentText });
    explain(node, {
      topic, language: langEl.value, chain: chainOf(node), selection: text, parentText, question,
      mode: mode === "simplify" ? "simplify" : undefined,
    });
  }

  function branch(mode, question = "") {
    if (!pending) return;
    const sel = pending;
    hideToolbar();
    document.getSelection()?.removeAllRanges();
    spawn(sel, mode, question);
  }

  // "Show me": an image node. Its text stays empty, so it is left out of the teaching notes.
  async function draw(node, body) {
    node.el.classList.add("streaming");
    streamingCount++;
    setGoBusy(true);
    const thinking = node.el.querySelector(".learn-thinking");
    if (thinking) thinking.lastElementChild.textContent = "Drawing… images take 10–20 seconds.";
    try {
      const res = await fetch("/api/learn/visual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.base64) throw new Error(data.error || `HTTP ${res.status}`);
      showFigure(node, `data:${data.mimeType};base64,${data.base64}`, `Diagram: ${body.selection}`);
      // Save the picture too, so it's there when the tree is reopened. Signed out, keep the
      // bytes so saveAll() can upload them after sign-in.
      const s = store();
      if (s && topicReady && await topicReady) {
        node.imagePath = await s.uploadDiagram(node.id, data.base64, data.mimeType);
        persist(node);
      } else {
        node.imageData = { base64: data.base64, mimeType: data.mimeType };
      }
      updateBanner();
    } catch (e) {
      const err = document.createElement("p");
      err.className = "learn-error";
      err.textContent = (e instanceof TypeError ? "Couldn't reach the server — check your connection and try again." : e.message) || "Image failed.";
      node.el.appendChild(err);
    } finally {
      thinking?.remove();
      node.streaming = false;
      node.el.classList.remove("streaming");
      streamingCount--;
      setGoBusy(streamingCount > 0);
    }
  }

  deeperBtn.addEventListener("click", () => branch("deeper"));
  simplifyBtn.addEventListener("click", () => branch("simplify"));
  visualBtn.addEventListener("click", () => branch("visual"));

  askBtn.addEventListener("click", () => {
    if (!pending) return;
    askMode = true;   // set before focus: focusing the input moves the selection out of the text
    actionsEl.hidden = true;
    askForm.hidden = false;
    askInput.focus();
  });
  askForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = askInput.value.trim();
    if (q) branch("ask", q);
  });
  askInput.addEventListener("keydown", (e) => { if (e.key === "Escape") hideToolbar(); });
  // Clicking anywhere else abandons the question.
  document.addEventListener("mousedown", (e) => { if (askMode && !toolbar.contains(e.target)) hideToolbar(); });

  // ── Handoff: tree → teaching notes (Phase 2) ────────────────────────────
  // app.js's connect() asks for notes on the session topic; the tree belongs to its topic,
  // so Teach this, Teach Again and a setup-screen start on the same topic all get it.
  // Budget: materials_text caps at 60k shared with uploaded files (plan §3), so aim for 30k,
  // dropping the deepest, then oldest, branches first. The root explanation always stays.
  const LEARN_NOTES_BUDGET = 30_000;

  function compileNotes(budget = LEARN_NOTES_BUDGET) {
    const depth = (n) => { let d = 0; for (let p = n; p.parentId != null; p = byId(p.parentId)) d++; return d; };
    // Document order: each deep-dive right after the paragraph it came from.
    const ordered = [...treeEl.querySelectorAll(".learn-node")]
      .map(el => byId(el.dataset.nodeId))
      .filter(n => n && n.text.trim());
    if (!ordered.length) return "";
    const section = (n) => `## ${[topic, ...chainOf(n).map(c => c.selection)].join(" → ")}\n\n${blocksOf(n.text).join("\n\n")}`;
    const keep = new Set(ordered);
    const size = () => ordered.reduce((s, n) => s + (keep.has(n) ? section(n).length + 2 : 0), 0);
    const droppable = ordered.filter(n => n.parentId != null).sort((a, b) => depth(b) - depth(a) || a.seq - b.seq);
    while (size() > budget && droppable.length) keep.delete(droppable.shift());
    const dropped = ordered.length - keep.size;
    const header = `What the teacher studied in Learn Mode about "${topic}" (${keep.size} explanation${keep.size === 1 ? "" : "s"}`
      + (dropped ? `; ${dropped} deeper one${dropped === 1 ? "" : "s"} left out for length` : "") + "):";
    return `${header}\n\n${ordered.filter(n => keep.has(n)).map(section).join("\n\n")}`.slice(0, budget);
  }

  const isThisTopic = (sessionTopic) =>
    !!topic && !!sessionTopic && sessionTopic.trim().toLowerCase() === topic.toLowerCase();

  window.pokenLearnNotes = (sessionTopic, budget) => (isThisTopic(sessionTopic) ? compileNotes(budget) : "");

  // ── The loop: reflection → mastery → dig back in (Phase 5) ──────────────
  // Sent when a session starts, so the reflection can tag each gap with the explanation it
  // belongs to. Only explanations with text (a diagram can't be "taught").
  window.pokenLearnIndex = (sessionTopic) => (isThisTopic(sessionTopic)
    ? nodes.filter(n => n.text.trim()).sort((a, b) => a.seq - b.seq)
        .map(n => ({ id: n.id, label: n.label || topic })).slice(0, 60)
    : []);

  function setMastery(node, mastery) {
    if (node.mastery === mastery) return;
    node.mastery = mastery;
    node.el.dataset.mastery = mastery;
    persist(node);
  }

  // After a teaching session: what the reflection flagged is shaky, what it didn't is a level
  // better. Only explanations that were actually taught (in the index we sent) move.
  window.pokenLearnReflection = (data) => {
    const digBack = document.getElementById("reflectionDigBack");
    digBack.replaceChildren();
    digBack.hidden = true;
    const taught = nodes.filter(n => n.text.trim());
    if (!taught.length) return;
    const shaky = new Set((data?.gapNodes || []).map(g => g?.nodeId).filter(Boolean));
    for (const node of taught) {
      if (shaky.has(node.id)) setMastery(node, "shaky");
      else setMastery(node, node.mastery === "taught" || node.mastery === "solid" ? "solid" : "taught");
    }
    const weak = taught.filter(n => shaky.has(n.id));
    if (!weak.length) return;
    const label = document.createElement("span");
    label.className = "reflection-digback-label";
    label.textContent = weak.length === 1 ? "Dig back into:" : "Dig back into the shaky parts:";
    digBack.append(label);
    for (const node of weak) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = node.label || topic;
      b.addEventListener("click", () => digInto(node.id));
      digBack.append(b);
    }
    digBack.hidden = false;
  };

  // Reflection screen → Learn Mode, scrolled to that explanation.
  function digInto(nodeId) {
    disconnect(true);   // app.js: clean up socket/mic/audio without navigating
    document.getElementById("reflection-screen").style.display = "none";
    document.getElementById("reflection-loading-screen")?.classList.remove("visible");
    show();
    const node = byId(nodeId);
    if (!node) return;
    node.el.scrollIntoView({ behavior: "smooth", block: "center" });
    node.el.classList.add("focus");
    setTimeout(() => node.el.classList.remove("focus"), 2000);
  }

  // ── Saved topics ────────────────────────────────────────────────────────
  const ago = (iso) => {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(iso).toLocaleDateString();
  };

  async function showTopics() {
    const s = store();
    topicsEl.replaceChildren();
    if (!s || !user) return;
    const list = await s.listTopics();
    if (nodes.length || !list.length) return;   // a tree opened meanwhile, or nothing saved yet
    const h = document.createElement("div");
    h.className = "learn-topics-title";
    h.textContent = "Your topics";
    topicsEl.append(h);
    for (const t of list) {
      const row = document.createElement("div");
      row.className = "learn-topic";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "learn-topic-open";
      const title = document.createElement("span");
      title.textContent = t.title;
      const meta = document.createElement("small");
      meta.textContent = `${t.language} · ${ago(t.updated_at)}`;
      open.append(title, meta);
      open.addEventListener("click", () => openTopic(t.id));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "learn-topic-delete";
      del.title = `Delete "${t.title}"`;
      del.setAttribute("aria-label", `Delete ${t.title}`);
      del.textContent = "×";
      del.addEventListener("click", async () => {
        if (!confirm(`Delete "${t.title}" and everything you explored in it?`)) return;
        if (await s.deleteTopic(t.id)) row.remove();
        if (!topicsEl.querySelector(".learn-topic")) topicsEl.replaceChildren();
      });
      row.append(open, del);
      topicsEl.append(row);
    }
  }

  // Rebuild a tree exactly as it was: same nesting, glosses, suggestions and diagrams.
  // Rows use the learn_nodes column names, oldest first so a parent renders before its
  // children. `image_data` (not a column) carries an unsaved diagram across the redirect.
  function rebuild(title, language, rows, { saved = false } = {}) {
    reset();
    topicsEl.replaceChildren();
    topic = title;
    topicEl.value = title;
    langEl.value = language;
    for (const row of rows) {
      if (row.parent_id && !byId(row.parent_id)) continue;   // orphan (shouldn't happen)
      const node = createNode(row.parent_id, row.label, row.after_block, row.question, { id: row.id, kind: row.kind, createdAt: row.created_at, mastery: row.mastery });
      node.el.querySelector(".learn-thinking")?.remove();
      node.streaming = false;
      node.saved = saved;            // from the database: already saved; from the stash: not yet
      node.text = row.body || "";
      renderBlocks(node);
      if (row.extras) applyExtras(node, row.extras);
      if (row.image_data) {
        node.imageData = row.image_data;
        showFigure(node, `data:${row.image_data.mimeType};base64,${row.image_data.base64}`, `Diagram: ${node.label}`);
      } else if (row.image_path) {
        node.imagePath = row.image_path;
        store()?.diagramUrl(row.image_path).then(url => { if (url && byId(node.id)) showFigure(node, url, `Diagram: ${node.label}`); });
      }
    }
    teachBtn.disabled = nodes.length === 0;
    window.scrollTo(0, 0);
  }

  async function openTopic(id) {
    if (streamingCount) return;
    const s = store();
    const data = s && await s.loadTree(id);
    if (!data) return;
    rebuild(data.topic.title, data.topic.language, data.nodes, { saved: true });
    topicId = id;
    topicReady = Promise.resolve(id);
    updateBanner();
  }

  // ── Accounts ────────────────────────────────────────────────────────────
  // Signing in leaves the page for Google, which would lose an unsaved tree, so it's stashed
  // in sessionStorage first and rebuilt on return (then saved, now that there's a user).
  const STASH_KEY = "poken_learn_stash";

  function stashTree() {
    // Even with no tree, stash so the return from Google lands back in Learn Mode.
    const rows = [...nodes].sort((a, b) => a.seq - b.seq).map(n => ({
      id: n.id, parent_id: n.parentId, kind: n.kind, label: n.label, question: n.question,
      after_block: n.afterBlock, body: n.text, created_at: n.createdAt,
      extras: n.terms || n.suggestions ? { keyTerms: n.terms || [], suggestions: n.suggestions || [] } : null,
      image_data: n.imageData || null,
    }));
    const stash = { topic, language: langEl.value, rows };
    try { sessionStorage.setItem(STASH_KEY, JSON.stringify(stash)); }
    catch (_) {
      // Over the ~5 MB quota (diagrams are big): keep the text, drop the pictures.
      try { sessionStorage.setItem(STASH_KEY, JSON.stringify({ ...stash, rows: rows.map(r => ({ ...r, image_data: null })) })); }
      catch (_) { /* can't stash; the leave warning was the last line of defence */ }
    }
  }

  function takeStash() {
    try {
      const raw = sessionStorage.getItem(STASH_KEY);
      sessionStorage.removeItem(STASH_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  async function signIn() {
    const s = store();
    if (!s) return;
    stashTree();
    leavingForSignIn = true;
    if (!(await s.signInWithGoogle())) {
      leavingForSignIn = false;
      takeStash();   // didn't leave after all; the tree is still on screen
      alert("Couldn't start Google sign-in. Please try again.");
    }
  }

  function renderAccount() {
    accountEl.replaceChildren();
    if (!store()) return;
    if (!user) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "learn-google";
      b.textContent = "Sign in with Google";
      b.addEventListener("click", signIn);
      accountEl.append(b);
      return;
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
    out.addEventListener("click", () => store().signOut());
    wrap.append(name, out);
    accountEl.append(wrap);
  }

  // "Not saved" banner: signed out, with at least one finished explanation or diagram.
  function updateBanner() {
    bannerEl.hidden = !store() || !!user || bannerDismissed || !hasUnsavedWork();
  }
  document.getElementById("learnBannerSignIn").addEventListener("click", signIn);
  document.getElementById("learnBannerClose").addEventListener("click", () => { bannerDismissed = true; updateBanner(); });

  // Browsers only allow their own generic "Leave site?" dialog here — custom text is ignored.
  window.addEventListener("beforeunload", (e) => {
    if (leavingForSignIn || user || !hasUnsavedWork()) return;
    e.preventDefault();
    e.returnValue = "";
  });

  const stash = takeStash();
  let firstAuthEvent = true;
  store()?.onAuthChange((u) => {
    const wasSignedIn = !!user;
    user = u;
    renderAccount();
    topicsBtn.hidden = !user;
    if (firstAuthEvent) {
      firstAuthEvent = false;
      // Back from Google: return to Learn Mode, rebuild the tree that was on screen, and save
      // it if sign-in worked (saveAll below). A cancelled sign-in still gets the tree back.
      if (stash) {
        show();
        if (stash.rows?.length) rebuild(stash.topic, stash.language, stash.rows);
      }
    }
    if (user && !wasSignedIn) saveAll();
    if (!user && wasSignedIn) { topicReady = null; topicId = null; }   // keep the tree on screen, stop saving
    if (!nodes.length && screen.style.display === "block") showTopics();
    updateBanner();
  });

  // ── Start / navigation ──────────────────────────────────────────────────
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const t = topicEl.value.trim();
    if (!t || streamingCount) return;
    topic = t;
    reset();
    topicsEl.replaceChildren();
    hintEl.style.display = "";
    startSavedTopic(topic, langEl.value);
    explain(createNode(null, "", 0), { topic, language: langEl.value });
  });

  function show() {
    landing.style.display = "none";
    screen.style.display = "block";
    window.scrollTo(0, 0);
    // Match the setup screen's language if the user picked one there.
    const sessionLang = document.getElementById("sessionLanguage");
    if (sessionLang?.value && !nodes.length) langEl.value = sessionLang.value;
    if (!nodes.length) showTopics();
    topicEl.focus();
  }
  function hide() { hideToolbar(); screen.style.display = "none"; }

  learnFirst.addEventListener("click", show);
  backBtn.addEventListener("click", () => { hide(); landing.style.display = "flex"; });
  // Leave the current tree (it's saved) and pick another.
  topicsBtn.addEventListener("click", () => {
    if (streamingCount) return;
    reset();
    topic = "";
    topicEl.value = "";
    showTopics();
  });
  topicsBtn.hidden = !user;   // onAuthChange keeps this in sync
  renderAccount();

  // Hand off straight into a teaching session. connect() (app.js) reads the setup
  // fields, so fill them first, and pulls the compiled tree via pokenLearnNotes().
  // The student persona is changeable in-session.
  teachBtn.addEventListener("click", async () => {
    if (!nodes.length || teachBtn.disabled) return;
    const customTopic = document.getElementById("customTopic");
    const sessionLang = document.getElementById("sessionLanguage");
    if (customTopic) customTopic.value = topic;
    if (sessionLang) sessionLang.value = langEl.value;
    teachBtn.disabled = true;
    hide();
    await connect();
    teachBtn.disabled = false;
  });

  // After a teaching session: back into the same tree (it's still in memory), so the
  // gaps the reflection just named can be dug into. Topic carries over if there's no tree.
  document.getElementById("backToLearnBtn")?.addEventListener("click", () => {
    disconnect(true);   // app.js: clean up socket/mic/audio without navigating
    document.getElementById("reflection-screen").style.display = "none";
    document.getElementById("reflection-loading-screen")?.classList.remove("visible");
    if (!nodes.length) topicEl.value = document.getElementById("customTopic")?.value || "";
    show();
  });
})();
