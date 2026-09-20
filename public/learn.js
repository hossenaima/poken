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
  const bannerEl   = document.getElementById("learnSaveBanner");
  const fileInput  = document.getElementById("learnFile");
  const uploadEl   = document.getElementById("learnUploadLabel");
  const uploadText = document.getElementById("learnUploadText");

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
  // Blocks are chunks separated by blank lines, each a paragraph, a "###" subhead or a list.
  // The prompt allows exactly that plus **bold**; everything else the model may emit anyway
  // (links, code, tables, blockquotes, emoji, [1]-style citations, *emphasis*) is stripped
  // so it never shows or reaches the teaching notes. A chunk with no markdown lines stays one
  // paragraph with the exact text the old paragraph-only splitter produced — saved trees
  // address children by block index, so markdown-free text must split identically.
  const LINE = {
    fence: /^\s*(`{3,}|~{3,})/,
    heading: /^\s*#{1,6}\s+(.*)$/,
    bullet: /^\s*[-*•]\s+(.*)$/,
    numbered: /^\s*\d{1,3}[.)]\s+(.*)$/,
    quote: /^\s*>\s?/,
    tableRule: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
    tableRow: /^\s*\|.*\|\s*$/,
  };
  const EMOJI = / ?(?:[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}]|(?![©®])\p{Extended_Pictographic})+/gu;

  // Inline pass: plain text plus the ranges of it that were **bold**. Bold is the only inline
  // markup kept; the rest is flattened to its visible text before the bold scan.
  function parseInline(raw) {
    const flat = raw
      .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")   // [label](url) → label
      .replace(/`([^`\n]*)`/g, "$1")
      .replace(EMOJI, "");
    let text = "";
    const bold = [], italic = [];
    // Longest delimiter first: *** is both, ** bold, * italic. Underscores are deliberately not
    // emphasis — prose rarely means them that way and snake_case identifiers would be mangled.
    const re = /\*\*\*([^*\n]+?)\*\*\*|\*\*([^*\n]+?)\*\*|\*([^*\n]+?)\*/g;
    let last = 0, m;
    while ((m = re.exec(flat))) {
      text += flat.slice(last, m.index);
      const body = m[1] ?? m[2] ?? m[3];
      const range = [text.length, text.length + body.length];
      if (m[1] != null) { bold.push(range); italic.push(range); }
      else if (m[2] != null) bold.push(range);
      else italic.push(range);
      text += body;
      last = m.index + m[0].length;
    }
    text += flat.slice(last);
    // Citation markers, then trim — offsets shift with the removals, so recompute them through
    // a position map rather than re-parsing.
    const keep = [];
    let cursor = 0;
    for (const c of text.matchAll(/\s?\[\d+(?:\s*,\s*\d+)*\]/g)) { keep.push([cursor, c.index]); cursor = c.index + c[0].length; }
    keep.push([cursor, text.length]);
    const removedBefore = (i) => { let r = 0, end = 0; for (const [s, e] of keep) { if (i <= s) break; r += s - end; end = e; if (i <= e) break; } return r; };
    const stripped = keep.map(([s, e]) => text.slice(s, e)).join("");
    const lead = stripped.length - stripped.trimStart().length;
    const out = stripped.trim();
    const remap = (ranges) => ranges
      .map(([s, e]) => [s - removedBefore(s) - lead, e - removedBefore(e) - lead])
      .map(([s, e]) => [Math.max(0, s), Math.min(out.length, e)])
      .filter(([s, e]) => e > s);
    return { text: out, bold: remap(bold), italic: remap(italic) };
  }

  function blocksOf(text) {
    const blocks = [];
    for (const chunk of text.split(/\n\s*\n/)) {
      let para = [], list = null, quote = [], table = null;
      const flush = () => {
        if (para.length) {
          const inline = parseInline(para.join("\n"));
          if (inline.text) blocks.push({ kind: "paragraph", ...inline });
        }
        if (list?.items.length) blocks.push({ ...list, text: list.items.map(i => i.text).join("\n") });
        if (quote.length) {
          const inline = parseInline(quote.join(" "));
          if (inline.text) blocks.push({ kind: "quote", ...inline });
        }
        if (table?.rows.length) {
          blocks.push({ ...table, text: table.rows.map(r => r.map(c => c.text).join(" · ")).join("\n") });
        }
        para = []; list = null; quote = []; table = null;
      };
      // Split a | a | b | row into its cells, tolerating a missing leading or trailing pipe.
      const cellsOf = (line) => line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map(c => parseInline(c.trim()));
      for (const line of chunk.split("\n")) {
        if (LINE.fence.test(line)) continue;
        // The |---|---| rule line only marks the header, it is not a row of its own.
        if (LINE.tableRule.test(line)) { if (table) table.headerDone = true; continue; }
        let m;
        if ((m = LINE.heading.exec(line))) {
          flush();
          const inline = parseInline(m[1]);
          if (inline.text) blocks.push({ kind: "subhead", ...inline });
        } else if ((m = LINE.bullet.exec(line)) || (m = LINE.numbered.exec(line))) {
          const ordered = !LINE.bullet.test(line);
          if (para.length || quote.length || table || (list && list.ordered !== ordered)) flush();
          list ??= { kind: "list", ordered, items: [] };
          const item = parseInline(m[1]);
          if (item.text) list.items.push(item);
        } else if (LINE.quote.test(line)) {
          if (para.length || list || table) flush();
          quote.push(line.replace(LINE.quote, ""));
        } else if (LINE.tableRow.test(line)) {
          if (para.length || list || quote.length) flush();
          table ??= { kind: "table", rows: [], headerDone: false };
          // Rows before the |---| rule are the header; without a rule the first row is.
          const cells = cellsOf(line);
          if (cells.length) { table.rows.push(cells); if (!table.headerDone) table.header = table.rows.length; }
        } else {
          if (list || quote.length || table) flush();
          para.push(line);
        }
      }
      flush();
    }
    return blocks;
  }
  const plainBlocksOf = (text) => blocksOf(text).map(b => b.text);

  function reset() {
    nodes = []; seq = 0; pending = null; streamingCount = 0;
    topicId = null; topicReady = null;
    treeEl.innerHTML = "";
    hideToolbar();
    teachBtn.disabled = true;
    updateBanner();
  }

  // ── Uploaded material ───────────────────────────────────────────────────
  // Slides, a PDF or a photo, read once on the server and kept here as text. It is not part of
  // the saved tree: the explanations it produced are what's worth keeping, not the raw file.
  const MAX_UPLOAD_MB = 8;
  let materialText = "";

  function setUpload(state, label) {
    uploadEl.classList.toggle("busy", state === "busy");
    uploadEl.classList.toggle("has-file", state === "ready");
    uploadText.textContent = label;
    fileInput.disabled = state === "busy";
  }

  function clearUpload() {
    materialText = "";
    fileInput.value = "";
    setUpload("empty", "Upload");
  }

  async function onFilePicked() {
    const file = fileInput.files?.[0];
    if (!file) return;
    // Checked here as well as on the server so an oversized file fails instantly instead of
    // after the upload; the server check is the one that actually enforces it.
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      setUpload("empty", `Too big (max ${MAX_UPLOAD_MB} MB)`);
      fileInput.value = "";
      setTimeout(() => { if (!materialText) setUpload("empty", "Upload"); }, 4000);
      return;
    }
    setUpload("busy", "Reading…");
    try {
      const base64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1] || "");
        r.onerror = () => reject(new Error("read failed"));
        r.readAsDataURL(file);
      });
      const res = await fetch("/api/learn/material", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, mimeType: file.type, base64 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.text) throw new Error(data.error || `HTTP ${res.status}`);
      materialText = data.text;
      const short = file.name.length > 22 ? file.name.slice(0, 20) + "…" : file.name;
      setUpload("ready", `${short} ✕`);
      uploadEl.title = `Using ${file.name}${data.truncated ? " (truncated)" : ""} — click to remove`;
      // Nothing to learn about yet: offer the filename as the topic so Learn is one click away.
      if (!topicEl.value.trim()) topicEl.value = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
    } catch (err) {
      console.warn("[Poken][Learn] upload failed:", err);
      setUpload("empty", err.message?.slice(0, 40) || "Couldn't read that");
      fileInput.value = "";
      setTimeout(() => { if (!materialText) setUpload("empty", "Upload"); }, 5000);
    }
  }

  fileInput?.addEventListener("change", onFilePicked);
  // Once a file is attached the control becomes its own remove button.
  uploadEl?.addEventListener("click", (e) => {
    if (!materialText) return;              // no file yet: let the label open the picker
    e.preventDefault();
    clearUpload();
  });

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
    blocksOf(node.text).forEach((block, i) => {
      // A table is the one block that can be wider than the column, so it is wrapped in a
      // scroller and the WRAPPER carries .learn-block — block indexing, drag-select and the
      // collapse rules all need the indexed element to be a direct child of the node.
      const TAGS = { subhead: "h4", quote: "blockquote", table: "div" };
      const tag = TAGS[block.kind] || (block.kind === "list" ? (block.ordered ? "ol" : "ul") : "p");
      const p = document.createElement(tag);
      // Every block carries .learn-block whatever its tag: drag-select, block indexing and the
      // collapse rules all key off that one class, so a new kind must never opt out of it.
      // Assigned, not added, so anything else must come after this line or it gets wiped.
      p.className = "learn-block";
      if (block.kind === "table") p.classList.add("learn-table-wrap");
      p.dataset.nodeId = node.id;
      p.dataset.blockIdx = i;
      if (block.kind === "table") {
        const table = document.createElement("table");
        block.rows.forEach((cells, r) => {
          const tr = document.createElement("tr");
          for (const cell of cells) {
            const td = document.createElement(r < (block.header || 0) ? "th" : "td");
            decorateTerms(td, cell, node.terms, usedTerms);
            tr.append(td);
          }
          table.append(tr);
        });
        p.append(table);
      } else if (block.kind === "list") {
        // Newlines between items so textContent (what selection and context read) keeps them apart.
        block.items.forEach((item, j) => {
          if (j) p.append("\n");
          const li = document.createElement("li");
          decorateTerms(li, item, node.terms, usedTerms);
          p.append(li);
        });
      } else {
        decorateTerms(p, block, node.terms, usedTerms);
      }
      node.el.appendChild(p);
      for (const child of children.get(i) || []) node.el.appendChild(child);
    });
    if (node.suggestEl) node.el.appendChild(node.suggestEl);   // suggestions stay last
  }

  // Append text[from, to) to el, wrapping bold ranges in <strong> and italic ranges in <em>.
  // The two sets can overlap (***both***), so cut at every boundary instead of walking one set.
  function appendRich(el, inline, from, to) {
    const { text } = inline;
    const bold = inline.bold || [], italic = inline.italic || [];
    const cuts = new Set([from, to]);
    for (const [s, e] of [...bold, ...italic]) {
      if (s > from && s < to) cuts.add(s);
      if (e > from && e < to) cuts.add(e);
    }
    const points = [...cuts].sort((a, b) => a - b);
    const covers = (ranges, i) => ranges.some(([s, e]) => i >= s && i < e);
    for (let k = 0; k < points.length - 1; k++) {
      const a = points[k], b = points[k + 1];
      if (b <= a) continue;
      let node = document.createTextNode(text.slice(a, b));
      if (covers(italic, a)) { const em = document.createElement("em"); em.append(node); node = em; }
      if (covers(bold, a)) { const st = document.createElement("strong"); st.append(node); node = st; }
      el.append(node);
    }
  }

  // Wrap the first occurrence of each key term in a span that shows its gloss on hover/focus.
  // Text-only DOM (textContent/createElement), so model output is never parsed as HTML.
  // Terms are matched on the plain text, so a term inside a bolded phrase is still glossed.
  function decorateTerms(p, inline, terms, used) {
    const { text } = inline;
    if (!terms?.length) { appendRich(p, inline, 0, text.length); return; }
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
      appendRich(p, inline, cursor, h.at);
      const span = document.createElement("span");
      span.className = "learn-term";
      span.tabIndex = 0;
      span.dataset.gloss = h.t.gloss;
      appendRich(span, inline, h.at, h.end);
      p.append(span);
      cursor = h.end;
      used.add(h.key);
    }
    appendRich(p, inline, cursor, text.length);
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
        body: JSON.stringify({ topic, text: plainBlocksOf(node.text).join("\n\n"), language: langEl.value }),
      });
      if (!res.ok) return;
      const extras = await res.json();
      if (!byId(node.id)) return;   // tree was reset meanwhile
      applyExtras(node, extras);
      persist(node);
    } catch (_) { /* extras are optional */ }
  }

  // A branch folds away everything below its crumb. Collapsing is per node and survives
  // re-renders because the class lives on node.el, which renderBlocks never replaces.
  function wireFold(node) {
    const btn = node.el.querySelector(":scope > .learn-crumb-row > .learn-fold");
    if (!btn) return;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();   // the crumb row sits inside a node that has its own handlers
      setFolded(node, !node.el.classList.contains("collapsed"));
    });
  }

  function setFolded(node, folded) {
    node.el.classList.toggle("collapsed", folded);
    const btn = node.el.querySelector(":scope > .learn-crumb-row > .learn-fold");
    if (!btn) return;
    btn.innerHTML = folded ? "&#9656;" : "&#9662;";
    btn.setAttribute("aria-expanded", folded ? "false" : "true");
    btn.title = folded ? "Expand" : "Collapse";
  }

  // Opening a saved topic starts folded: you came back to navigate, not to re-read every
  // rabbit hole you opened last time. A fresh tree you are actively building stays open.
  function foldAllBranches() {
    for (const n of nodes) if (n.parentId != null) setFolded(n, true);
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
    node.el.innerHTML = `<div class="learn-crumb-row">${parentId != null ? `<button type="button" class="learn-fold" aria-expanded="true" title="Collapse">&#9662;</button>` : ""}<div class="learn-crumb">${crumbHtml(node)}</div></div>`
      + (question ? `<p class="learn-question">Q: ${esc(question)}</p>` : "")
      + `<div class="learn-thinking" role="status"><span class="learn-spinner"></span><span>Thinking…</span></div>`;
    if (parentId != null) wireFold(node);
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
        // The upload rides along on every explanation, root and rabbit hole alike, so going
        // deeper stays anchored to the learner's own slides rather than drifting to the topic.
        body: JSON.stringify(materialText ? { ...body, material: materialText } : body),
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
    const parentText = parentTextOverride || context || plainBlocksOf(parent.text)[blockIdx] || "";
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
    const section = (n) => `## ${[topic, ...chainOf(n).map(c => c.selection)].join(" → ")}\n\n${plainBlocksOf(n.text).join("\n\n")}`;
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

  // The saved learn_topics row this session was taught off, so an open question can point back
  // at the tree. Null for a straight-to-teaching session, which is why open_questions.topic_id
  // is nullable and topic_title is what the page actually groups by.
  window.pokenLearnTopicId = (sessionTopic) => (isThisTopic(sessionTopic) ? topicId : null);

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
  // Mastery only: the reflection page itself offers the way back, one button per concept.
  window.pokenLearnReflection = (data) => {
    const taught = nodes.filter(n => n.text.trim());
    if (!taught.length) return;
    const shaky = new Set((data?.gapNodes || []).map(g => g?.nodeId).filter(Boolean));
    for (const node of taught) {
      if (shaky.has(node.id)) setMastery(node, "shaky");
      else setMastery(node, node.mastery === "taught" || node.mastery === "solid" ? "solid" : "taught");
    }
  };

  // Reflection → Learn Mode for one concept: the explanation it came from when we know it,
  // otherwise a fresh topic. Never discards a tree with unsaved work — that one waits for a click.
  window.pokenLearnRevisit = (label, nodeId, gapText = "") => {
    if (nodeId && byId(nodeId)) { digInto(nodeId, label, gapText); return; }
    const t = String(label || "").trim();
    if (!t) return;
    disconnect(true);
    document.getElementById("reflection-screen").style.display = "none";
    document.getElementById("reflection-loading-screen")?.classList.remove("visible");
    show();
    topicEl.value = t;
    if (hasUnsavedWork()) { topicEl.focus(); return; }
    form.requestSubmit();
  };

  // ── "Learn this" → the paragraph it is actually about ───────────────────
  const STOPWORDS = new Set(("the a an and or but of in on at to for from with as is are was were be been being " +
    "it its this that these those they them their there here how why what when which who whom whose not no " +
    "can could should would will shall may might do does did done have has had you your we our i").split(" "));

  const wordsOf = (s) => String(s || "").toLowerCase().replace(/\*+/g, " ")
    .split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2 && !STOPWORDS.has(w));

  // Which paragraph of this explanation is the gap about? Score each block by how many of the
  // concept's distinct content words it contains, longer words first — "photolysis" identifies a
  // paragraph, "process" does not. A tie goes to the earlier block, and a zero score to the whole
  // node, because a wrong confident highlight is worse than none.
  function bestBlockFor(node, ...phrases) {
    const want = new Set(phrases.flatMap(wordsOf));
    if (!want.size) return null;
    const blocks = [...node.el.querySelectorAll(":scope > .learn-block")];
    let best = null, bestScore = 0;
    for (const el of blocks) {
      const have = new Set(wordsOf(el.textContent));
      let score = 0;
      for (const w of want) if (have.has(w)) score += Math.min(w.length, 12);
      if (score > bestScore) { best = el; bestScore = score; }
    }
    return bestScore >= 6 ? best : null;
  }

  function clearHighlight() {
    treeEl.querySelectorAll(".learn-hl").forEach(el => el.classList.remove("learn-hl"));
  }

  // Unfold every collapsed ancestor, or the target sits inside a hidden branch.
  function revealAncestors(el) {
    for (let p = el.parentElement; p && p !== treeEl; p = p.parentElement) {
      if (p.classList?.contains("learn-node") && p.classList.contains("collapsed")) {
        const n = byId(p.dataset.nodeId);
        if (n) setFolded(n, false); else p.classList.remove("collapsed");
      }
    }
  }

  // Reflection screen → Learn Mode, scrolled to the paragraph the concept came from.
  function digInto(nodeId, label = "", gapText = "") {
    disconnect(true);   // app.js: clean up socket/mic/audio without navigating
    document.getElementById("reflection-screen").style.display = "none";
    document.getElementById("reflection-loading-screen")?.classList.remove("visible");
    show();
    const node = byId(nodeId);
    if (!node) return;
    clearHighlight();
    const target = bestBlockFor(node, label, gapText);
    revealAncestors(target || node.el);
    if (target) {
      target.classList.add("learn-hl");
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    // No paragraph clearly matched: fall back to the old behaviour rather than guessing.
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

  // In-app confirm (app.js); falls back to the browser's confirm() if it isn't loaded.
  const ask = (opts) => typeof window.pokenConfirm === "function"
    ? window.pokenConfirm({ danger: true, ...opts })
    : Promise.resolve(confirm(opts.body || opts.title));

  async function showTopics() {
    const s = store();
    topicsEl.replaceChildren();
    if (!s || !user) return;
    const list = await s.listTopics();
    if (nodes.length || !list.length) return;   // a tree opened meanwhile, or nothing saved yet
    const h = document.createElement("div");
    h.className = "learn-topics-title";
    const hText = document.createElement("span");
    hText.textContent = "Your topics";
    const clearAll = document.createElement("button");
    clearAll.type = "button";
    clearAll.className = "learn-topics-clear";
    clearAll.textContent = "Delete all";
    clearAll.addEventListener("click", async () => {
      const n = list.length;
      const ok = await ask({
        title: `Delete all ${n} topic${n === 1 ? "" : "s"}?`,
        body: "Everything you explored in them will be removed. This can't be undone.",
        confirmLabel: "Delete all",
      });
      if (!ok) return;
      clearAll.disabled = true;
      for (const t of list) await s.deleteTopic(t.id);   // failures stay in the list; re-render shows survivors
      showTopics();
    });
    h.append(hText, clearAll);
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
        const ok = await ask({ title: "Delete this topic?", body: `Delete "${t.title}" and everything you explored in it?` });
        if (!ok) return;
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
    foldAllBranches();   // reopened from My topics: navigate first, read second
    updateBanner();
  }

  // ── Accounts ────────────────────────────────────────────────────────────
  // Signing in leaves the page for Google, which would lose an unsaved tree, so it's stashed
  // in sessionStorage first and rebuilt on return (then saved, now that there's a user).
  const STASH_KEY = "poken_learn_stash";

  function stashTree() {
    // Only the tree's contents; app.js decides which screen the return from Google opens.
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

  // Any sign-in anywhere may navigate away, so the tree has to be stashed first.
  window.pokenStashForSignIn = () => { stashTree(); leavingForSignIn = true; };

  // The control itself is rendered by app.js for every [data-poken-account] mount.
  function renderAccount() {
    if (typeof window.renderAccountControls === "function") window.renderAccountControls(user);
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

  window.pokenScreens?.register("learn", () => show());

  const stash = takeStash();
  let firstAuthEvent = true;
  store()?.onAuthChange((u) => {
    const wasSignedIn = !!user;
    user = u;
    renderAccount();
    topicsBtn.hidden = !user;
    if (firstAuthEvent) {
      firstAuthEvent = false;
      // Back from Google: rebuild the tree that was on screen. Which screen to open is the
      // return intent's job (app.js), so a sign-in started elsewhere doesn't land in Learn Mode.
      if (stash?.rows?.length) rebuild(stash.topic, stash.language, stash.rows);
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
  // Leaving the screen drops the highlight: it marks why you arrived this time, so coming
  // back later must not find the paragraph still yellow.
  function hide() { hideToolbar(); clearHighlight(); screen.style.display = "none"; }

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
