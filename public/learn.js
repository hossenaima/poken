// ── Learn Mode (Phase 1) ─────────────────────────────────────────────────────
// A knowledge tree kept in memory: the root is the topic's explanation; every
// drag-select → "Go deeper" spawns a child node rendered right under the block
// it came from. Nothing is persisted yet (Phase 4). See docs/LEARN_MODE_PLAN.md.
(() => {
  const screen     = document.getElementById("learn-screen");
  const form       = document.getElementById("learnForm");
  const topicEl    = document.getElementById("learnTopic");
  const langEl     = document.getElementById("learnLanguage");
  const goBtn      = document.getElementById("learnGoBtn");
  const treeEl     = document.getElementById("learnTree");
  const hintEl     = document.getElementById("learnHint");
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

  // ── Tree ────────────────────────────────────────────────────────────────
  let topic = "";
  let nodes = [];          // { id, parentId, label, text, el, streaming, terms?, suggestEl? }  label = selection or question
  let nextId = 1;
  let pending = null;      // current selection: { nodeId, blockIdx, text }
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
    nodes = []; nextId = 1; pending = null; streamingCount = 0;
    treeEl.innerHTML = "";
    hideToolbar();
    teachBtn.disabled = true;
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
      children.set(Number(el.dataset.afterBlock), el);
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
      const child = children.get(i);
      if (child) node.el.appendChild(child);
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

  // After a node finishes: key-term glosses + "go deeper" suggestions. Optional —
  // on any failure the explanation simply stays as it is.
  async function addExtras(node) {
    try {
      const res = await fetch("/api/learn/extras", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, text: blocksOf(node.text).join("\n\n"), language: langEl.value }),
      });
      if (!res.ok) return;
      const { keyTerms = [], suggestions = [] } = await res.json();
      if (!byId(node.id)) return;   // tree was reset meanwhile
      node.terms = keyTerms;
      if (suggestions.length) {
        const row = document.createElement("div");
        row.className = "learn-suggest";
        const label = document.createElement("span");
        label.className = "learn-suggest-label";
        label.textContent = "Go deeper:";
        row.append(label);
        for (const s of suggestions) {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = s;
          b.addEventListener("click", () => {
            b.remove();
            if (!row.querySelector("button")) { row.remove(); node.suggestEl = null; }
            const blocks = blocksOf(node.text);
            spawn({ nodeId: node.id, blockIdx: blocks.length - 1, text: s }, "deeper", "", node.text);
          });
          row.append(b);
        }
        node.suggestEl = row;
      }
      renderBlocks(node);
    } catch (_) { /* extras are optional */ }
  }

  function createNode(parentId, label, afterBlockIdx, question = "") {
    const node = { id: nextId++, parentId, label, text: "", el: document.createElement("div"), streaming: true };
    node.el.className = "learn-node" + (parentId != null ? " child" : "");
    node.el.dataset.nodeId = node.id;
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
      // Insert after the anchor block and after any children already hanging off it.
      let after = anchor;
      while (after.nextElementSibling && after.nextElementSibling.classList.contains("child")) after = after.nextElementSibling;
      after.insertAdjacentElement("afterend", node.el);
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
      addExtras(node);   // not awaited: the explanation is usable now
    } catch (e) {
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
    const node = byId(Number(anchor.dataset.nodeId));
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
    // Breadcrumb label: a multi-paragraph selection would make an unreadable trail.
    const flat = text.replace(/\s+/g, " ");
    const short = flat.length > 90 ? `${flat.slice(0, 90).trimEnd()}…` : flat;
    const label = mode === "ask" ? question
      : mode === "simplify" ? `In simpler words: ${short}`
      : mode === "visual" ? `Picture: ${short}`
      : short;
    const node = createNode(nodeId, label, blockIdx, question);
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
      const fig = document.createElement("figure");
      fig.className = "learn-figure";
      const img = document.createElement("img");
      img.src = `data:${data.mimeType};base64,${data.base64}`;
      img.alt = `Diagram: ${body.selection}`;
      const cap = document.createElement("figcaption");
      cap.textContent = "AI-generated diagram — check labels against the explanation.";
      fig.append(img, cap);
      node.el.appendChild(fig);
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
      .map(el => byId(Number(el.dataset.nodeId)))
      .filter(n => n && n.text.trim());
    if (!ordered.length) return "";
    const section = (n) => `## ${[topic, ...chainOf(n).map(c => c.selection)].join(" → ")}\n\n${blocksOf(n.text).join("\n\n")}`;
    const keep = new Set(ordered);
    const size = () => ordered.reduce((s, n) => s + (keep.has(n) ? section(n).length + 2 : 0), 0);
    const droppable = ordered.filter(n => n.parentId != null).sort((a, b) => depth(b) - depth(a) || a.id - b.id);
    while (size() > budget && droppable.length) keep.delete(droppable.shift());
    const dropped = ordered.length - keep.size;
    const header = `What the teacher studied in Learn Mode about "${topic}" (${keep.size} explanation${keep.size === 1 ? "" : "s"}`
      + (dropped ? `; ${dropped} deeper one${dropped === 1 ? "" : "s"} left out for length` : "") + "):";
    return `${header}\n\n${ordered.filter(n => keep.has(n)).map(section).join("\n\n")}`.slice(0, budget);
  }

  window.pokenLearnNotes = (sessionTopic, budget) =>
    topic && sessionTopic && sessionTopic.trim().toLowerCase() === topic.toLowerCase() ? compileNotes(budget) : "";

  // ── Start / navigation ──────────────────────────────────────────────────
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const t = topicEl.value.trim();
    if (!t || streamingCount) return;
    topic = t;
    reset();
    hintEl.style.display = "";
    explain(createNode(null, "", 0), { topic, language: langEl.value });
  });

  function show() {
    landing.style.display = "none";
    screen.style.display = "block";
    window.scrollTo(0, 0);
    // Match the setup screen's language if the user picked one there.
    const sessionLang = document.getElementById("sessionLanguage");
    if (sessionLang?.value) langEl.value = sessionLang.value;
    topicEl.focus();
  }
  function hide() { hideToolbar(); screen.style.display = "none"; }

  learnFirst.addEventListener("click", show);
  backBtn.addEventListener("click", () => { hide(); landing.style.display = "flex"; });

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
