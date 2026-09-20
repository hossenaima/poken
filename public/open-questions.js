// ── Open questions ───────────────────────────────────────────────────────────
// Questions a student asked that the teacher left hanging. The reflection detects them
// (api/server.ts, `openQuestions`); this screen is where they come back.
//
// The closing rule is deliberate and narrow: a question closes only when the teacher
// TEACHES it or dismisses it with the ×. Going off to *read* about it does not close it —
// understanding you have not yet had to explain is not understanding you have demonstrated,
// which is the whole premise of the app.
//
// Signed out there is nothing to show, so the landing entry point stays hidden: without an
// account no session was ever saved, so an empty page would be a dead end, not a state.
(() => {
  const screenEl = document.getElementById("questions-screen");
  const listEl   = document.getElementById("questionsList");
  const linkEl   = document.getElementById("openQuestionsLink");
  const backBtn  = document.getElementById("questionsBackBtn");
  const landing  = document.getElementById("landing-screen");
  if (!screenEl || !listEl || !linkEl) return;

  const store = () => (typeof window.pokenStore?.listOpenQuestions === "function" ? window.pokenStore : null);
  let user = null;
  let rows = [];

  // The reason tag is shown bare, with no sentence explaining it. Across seven live probe
  // sessions the model labelled the same event wrong / unanswered / skipped on different runs,
  // so a sentence like "the answer wasn't right" asserts something we know is often false.
  // The tag alone groups and colours the row without claiming anything about the teacher.

  function when(iso) {
    const t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return "";
    const days = Math.floor((Date.now() - t) / 86_400_000);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 30) return `${days} days ago`;
    const months = Math.floor(days / 30);
    return months === 1 ? "a month ago" : `${months} months ago`;
  }

  // Grouped by topic title, because that is the one key present whether or not the session
  // was taught off a Learn Mode tree (topic_id is null for a straight-to-teaching session).
  function groupByTopic(list) {
    const groups = new Map();
    for (const q of list) {
      const key = (q.topicTitle || "").trim() || "Untitled topic";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(q);
    }
    return groups;
  }

  function show() {
    if (landing) landing.style.display = "none";
    screenEl.style.display = "block";
    screenEl.classList.add("fade-in");
    setTimeout(() => screenEl.classList.remove("fade-in"), 300);
    render();
    load();
  }

  function hide() {
    screenEl.style.display = "none";
  }

  function toLanding() {
    hide();
    if (typeof window.pokenShowLanding === "function") window.pokenShowLanding();
    else if (landing) landing.style.display = "flex";
  }

  async function load() {
    const s = store();
    if (!s || !user) { rows = []; render(); return; }
    rows = await s.listOpenQuestions();
    render();
  }

  function render() {
    listEl.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "q-empty";
      empty.textContent = "Nothing open. Teach something and see what your students ask.";
      listEl.append(empty);
      return;
    }
    for (const [topicTitle, items] of groupByTopic(rows)) {
      const block = document.createElement("div");
      block.className = "q-topic";

      const head = document.createElement("div");
      head.className = "q-topic-head";
      const name = document.createElement("span");
      name.className = "q-topic-name";
      name.textContent = topicTitle;
      const count = document.createElement("span");
      count.className = "q-topic-count";
      count.textContent = items.length === 1 ? "1 question" : `${items.length} questions`;
      head.append(name, count);
      block.append(head);

      for (const q of items) block.append(itemEl(q, topicTitle));
      listEl.append(block);
    }
  }

  function itemEl(q, topicTitle) {
    const row = document.createElement("div");
    row.className = "q-item";

    const body = document.createElement("div");
    body.className = "q-body";
    const text = document.createElement("div");
    text.className = "q-text";
    text.textContent = q.question;
    const meta = document.createElement("div");
    meta.className = "q-meta";
    const reason = document.createElement("span");
    reason.className = `q-reason ${q.reason}`;
    reason.textContent = q.reason;
    const age = document.createElement("span");
    const ago = when(q.createdAt);
    age.textContent = ago ? `· ${ago}` : "";
    meta.append(reason, age);
    body.append(text, meta);

    const actions = document.createElement("div");
    actions.className = "q-actions";

    // Two ways out of a question, in the order you'd want them: go read about it, or go prove
    // you can answer it. Learning about it deliberately does NOT close the question.
    const learn = document.createElement("button");
    learn.type = "button";
    learn.className = "q-learn";
    learn.textContent = "Learn about it";
    learn.addEventListener("click", () => learnIt(q, learn));

    const teach = document.createElement("button");
    teach.type = "button";
    teach.className = "q-teach";
    teach.textContent = "I can answer this now";
    teach.addEventListener("click", () => teachIt(q, topicTitle, teach));

    const x = document.createElement("button");
    x.type = "button";
    x.className = "q-x";
    x.setAttribute("aria-label", "Close this question");
    x.title = "Close this question";
    x.textContent = "×";
    x.addEventListener("click", () => closeIt(q));

    actions.append(learn, teach, x);
    row.append(body, actions);
    return row;
  }

  async function closeIt(q) {
    const s = store();
    rows = rows.filter(r => r.id !== q.id);   // optimistic: the row is gone either way
    render();
    if (s) await s.closeOpenQuestion(q.id);
  }

  // Read about it in Learn Mode, at the paragraph most likely to answer it. The question stays
  // open: studying is not answering, which is the whole distinction this page is built on.
  async function learnIt(q, btn) {
    btn.disabled = true;
    const was = btn.textContent;
    btn.textContent = "Opening…";
    try {
      const ok = await window.pokenLearnFromQuestion?.({
        topicId: q.topicId, topicTitle: q.topicTitle, question: q.question,
      });
      if (ok) { hide(); return; }
      btn.textContent = "No saved notes";
      setTimeout(() => { btn.textContent = was; btn.disabled = false; }, 2500);
    } catch (err) {
      console.warn("[Poken] learn from question failed:", err);
      btn.textContent = was;
      btn.disabled = false;
    }
  }

  // Straight into a teaching session whose student opens by asking this question. Only the
  // topic name and the question travel — never the previous transcript, which would cost far
  // more tokens than the context is worth.
  async function teachIt(q, topicTitle, btn) {
    btn.disabled = true;
    btn.textContent = "Starting…";
    const customTopic = document.getElementById("customTopic");
    const sessionLang = document.getElementById("sessionLanguage");
    if (customTopic) customTopic.value = topicTitle;
    if (sessionLang && q.language) sessionLang.value = q.language;
    window.pokenSeedQuestion = { id: q.id, question: q.question };
    hide();
    try {
      await window.pokenConnect?.();
    } finally {
      btn.disabled = false;
      btn.textContent = "I can answer this now";
    }
  }

  // Called by app.js when a reflection comes back, so a seeded question closes itself once
  // the teacher has actually answered it.
  window.pokenSettleSeedQuestion = async (data) => {
    const seed = window.pokenSeedQuestion;
    window.pokenSeedQuestion = null;
    if (!seed || !data || data.seededAnswered !== true) return;
    const s = store();
    if (s) await s.closeOpenQuestion(seed.id);
    rows = rows.filter(r => r.id !== seed.id);
  };

  // Saves what a reflection found. Called by app.js with the session's topic.
  window.pokenSaveOpenQuestions = async (topic, data) => {
    const s = store();
    const list = Array.isArray(data?.openQuestions) ? data.openQuestions : [];
    if (!s || !user || !list.length || !topic?.title) return 0;
    const withIds = list.map(q => ({ id: crypto.randomUUID(), question: q.question, reason: q.reason }));
    return await s.saveOpenQuestions(topic, withIds);
  };

  linkEl.addEventListener("click", show);
  backBtn?.addEventListener("click", toLanding);

  // The entry point exists only for signed-in users: signed out, nothing was ever saved.
  // Only an actual sign-out leaves the screen: the first (signed-out) auth event must not
  // undo a restore that just re-opened it after the Google redirect.
  window.pokenAuth?.onAuthChange((u) => {
    const wasSignedIn = !!user;
    user = u;
    linkEl.hidden = !u;
    if (!u) {
      rows = [];
      if (wasSignedIn && screenEl.style.display === "block") toLanding();
    } else if (screenEl.style.display === "block") {
      load();
    }
  });

  window.pokenScreens?.register("questions", () => show());
})();
