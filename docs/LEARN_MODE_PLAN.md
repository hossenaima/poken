# Learn Mode — research and implementation plan

Poken is a learn-by-teaching app: you teach an AI student over Gemini Live. This plan adds a
learning phase in front of teaching and connects the two into a loop:
**learn → teach → reflect → learn the gaps → teach again.** No code yet.

Written against `8969fca` (Cloud Run, with mid-session language switching). If
`api/server.ts` has moved much since then, check the line references in §3 before relying
on them.

---

## 0. What aima's Cloud Run rebuild changed for this plan

| Change since the Vercel build | Effect on Learn Mode |
|---|---|
| One Node process on Cloud Run (`main.ts` → `api/server.ts`), with Hono serving `public/`, `/api/*` and `/ws/live` | Learn endpoints are just more Hono routes in the same process. No new service, no new deploy target. |
| Classroom mode removed. One student, three personas (`eager`, `skeptic`, `confused`) | The handoff targets one student. Nothing here depends on multi-student. |
| Deliberately stateless: "Nothing is written to disk", "add storage only if a feature actually needs files to outlive a session" (`NOTES.md`) | The knowledge tree is exactly that kind of feature. Supabase is the first persistence, and the server can **stay stateless** (§4). |
| 60-minute socket, Gemini `goAway` handled by reopening in place, handover hourly | Learn Mode doesn't touch any of it. It's plain HTTP. |
| Secrets come from Secret Manager via `--set-secrets` in `cloudbuild.yaml` | Supabase keys follow the same path. |
| Pasted notes moved off the URL into a pre-session `materials_text` frame (`8316b1f`) | This is the handoff route. See §3. |
| Session language is now live state and can switch mid-lesson (`8969fca`) | Learn Mode takes a language, and the handoff passes it to the teaching session. |

---

## 1. What Google's Learn About actually is

I checked this against the live product at `learning.google.com/experiments/learn-about`,
plus the LearnLM paper and launch coverage.

**The pitch:** "Ask big or small questions, upload material or explore curated topics."
You type a topic and get a structured, textbook-style explainer rather than a chat reply. It
combines text with images, videos and articles from the web.

**The three learning aids**, named on the product page itself:

| Aid | What it does |
|---|---|
| **Simplify** | Rewrites the current explanation at a lower reading level |
| **Go Deeper** | Expands a sub-concept into its own explanation |
| **Get images** | Brings in a visual for the concept |

It also has a sidebar of related topics, textbook-style boxes with extra detail, curated
starter topics, and file upload.

**The key structural fact:** the aids attach to **blocks of content**, not to a chat input.
The unit you interact with is a paragraph, not a message. That's why it feels like a textbook
that responds instead of a chatbot, and it's the property Poken needs for drag-selection.

### What powers it

Learn About runs on **LearnLM**, and there is no LearnLM API to call. LearnLM's method is
**pedagogical instruction following**: the model is trained to follow a system instruction
that describes the teaching behavior you want, instead of one fixed idea of good teaching.
That capability now ships in standard Gemini (announced at I/O 2025).

So **the pedagogy is a system prompt, not a dependency.** We write the instruction and
standard Gemini follows it.

The learning-science principles LearnLM targets, which our prompts should also target:
- make the learner an **active participant**, not a passive reader
- encourage **reasoning and application**, not just recall
- **break down complexity** and manage cognitive load
- **adapt tone and difficulty** to the learner

The ICAP framework (Interactive > Constructive > Active > Passive) backs this up: interactive
learning builds deeper understanding and better retention than reading or listening.
Teaching is the top of that ladder, which is the bet Poken already makes.

### Where Poken deliberately differs

| Learn About | Poken |
|---|---|
| Buttons act on whole blocks | **Drag-select any span**, and the aids act on the selection |
| Each session is throwaway | Each session builds a **persistent knowledge tree** |
| Ends when your curiosity does | Ends by **handing off to a teaching session** |
| No assessment | Teaching **is** the assessment, and gaps route back into learning |

Drag-select is the sharper idea. Learn About makes you go deeper on whatever the model decided
was a unit. Poken lets you go deeper on the seven words that confused you. The catch is that
every rendered span must be addressable, and that drives the data model in §4.

---

## 2. Corrections to the Gemini blueprint

- **Hosting:** the blueprint assumed Vercel edge functions. Poken is one long-lived Node
  process on Cloud Run.
- **Image models:** Imagen is shut down, and images now come from the Nano Banana family.
  But `gemini-2.5-flash-image` is **already wired in** as `IMAGE_MODEL` (`api/server.ts:59`)
  for student diagrams. Reuse it for "Get images". The `-preview` image models were shut down
  on 2026-06-25, so any snippet naming one is already stale.
- **Structured output:** returning JSON is right, but use a `responseSchema` rather than
  "return ONLY valid JSON" in the prompt. `generateReflection` (`api/server.ts:388`) still
  strips ```` ```json ```` fences and calls `JSON.parse` (`:445`); Learn Mode shouldn't copy that.
- **Pedagogy:** the blueprint's Socratic prompt (never give answers, always quiz) is wrong
  for Poken. See §5.

---

## 3. The main architectural finding

**Both halves of the loop already exist in the codebase. They just aren't connected.**

### Learn → Teach: already works, with no server change

The student prompt treats study materials as the student's **own half-understood notes**:

> "You've gone through them but didn't fully understand everything — some parts confused you
> or didn't stick … Refer to these naturally as **your notes**"
> — `getStudentInstruction`, `api/server.ts:244`

A finished learn session produces exactly that: a body of text the learner just worked
through. And there's already a way to get it in: the **`materials_text`** pre-session frame
(`api/server.ts:1557`), which carries pasted notes. It becomes the `materials` string at the
head of `materialsContext`, and the hourly handover already carries `materialsContext`.

So the handoff is: **compile the learn tree to text on the client, send it as
`materials_text` before `ready_to_start`, and prefill `topic` and `language`.** Zero server
changes.

Why `materials_text` and not a `text/plain` `material_file` (the earlier plan):
- It's raw text with no "the teacher has shared a file" wrapper (`processMaterialFile`,
  `:1335`), so it lands exactly as the "your notes" framing intends.
- It's capped at 60k (`MAX_MATERIALS_CHARS × 2`, `:1039`) instead of 20k per file (`:1336`).
- It skips the file-processing progress UI, which would be confusing for text the learner
  just wrote.

**One slot:** `materials_text` is also where pasted notes go, and a second frame overwrites
the first. If the learner both pasted notes and brings a learn tree, the client joins them
into one frame (tree first).

**Size budget:** the 60k cap covers the notes and any uploaded files together, and anything
over it gets truncated from the end. The compiler should aim for about 30k, trimming the
deepest and least-recent branches first, so there's room left for files.

**Never the URL.** The frame exists because pasted notes used to travel in the WebSocket
URL, which put them in Cloud Run request logs and under URL length limits. Fixed in
`8316b1f`, and `NOTES.md` records the rule.

### Teach → Learn: half-built

`generateReflection` already outputs `gaps` (concepts missed, skipped or explained unclearly)
and `keyVocabulary`. They reach the client as `{type:'reflection'}` (`api/server.ts:1613`),
get shown once, and are thrown away.

The missing piece is **tagging gaps with node ids**, so each gap points to a specific block
of the tree. That's the one server change the loop needs (§5, Phase 5).

**So the loop is persistence plus one small change to the reflection.** That's why this can
ship in phases instead of as a rewrite.

---

## 4. Data model: the knowledge tree

```
topic (root: "photosynthesis")
 └── node              one generated explanation block
      ├── blocks[]     typed paragraphs, each with a stable id
      ├── sources[]    web citations from grounding
      ├── parent_id + selection {block_id, start, end, text}   what spawned it
      ├── kind         root | deeper | simplified
      └── mastery      unseen → read → taught → shaky → solid
```

- **Nodes are the addressable unit.** Every generated block gets a stable id before it
  reaches the DOM.
- **A rabbit hole is an edge**, recording the exact text you selected and its character
  offsets in the parent. The chain of ancestors is the breadcrumb trail
  ("photosynthesis → light reactions → splitting water → why manganese").
- **Mastery lives on the node**, and only teaching can raise it past `read`. That's what
  makes this a self-improving loop rather than a pile of saved articles: reading a block
  doesn't mean you know it.

### 4a. What mastery per node means

- **unseen**: suggested, but not opened yet
- **read**: you've read it. Learn Mode can only take you this far.
- **taught**: you explained it and the reflection found no gap
- **shaky**: the reflection flagged a gap in it
- **solid**: taught cleanly more than once, or taught cleanly again after being shaky

Why per node rather than per key term: knowing the word "NADPH" isn't knowing why light
reactions produce it. Terms also appear across many nodes, so a shaky term has no single
place to send you back to. **A node is where you go back to.** Terms stay as hover glosses
on nodes, not as a mastery unit.

### 4b. Storage: Supabase, with the server staying stateless (decided)

Jerry has Supabase Pro. Tables: `topics`, `nodes` (`parent_id`, JSON `blocks`, JSON
`sources`, `mastery`), `teach_sessions` (reflection plus the node ids it covered). A
recursive CTE fetches any subtree in one query.

**The browser talks to Supabase directly, protected by Row-Level Security**
(`user_id = auth.uid()` on every table). The server never touches the database. That:
- keeps `api/server.ts` stateless, matching aima's design and `NOTES.md`
- needs no new server auth, JWT checks or DB client in the Node process
- puts only the **anon key** (public by design) in the frontend. The service-role key isn't
  needed anywhere.

The Node server keeps doing only what needs the Gemini key: the generation calls.

Identity starts as Supabase **anonymous sign-in** and upgrades to a real account later
without losing the tree. The frontend has no bundler, so load `supabase-js` from jsDelivr as
an ES module.

---

## 5. Service design

### Learn Mode is plain HTTP on the existing process

Teaching needs Gemini Live (WebSocket, audio, handover). Learn Mode needs none of that. It's
turn-based text generation. New Hono routes go next to `/api/topics`, and they stream with
Hono's SSE helper. Cloud Run supports streaming responses, and nothing here needs session
affinity.

### Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/learn/start` | topic (+ optional extracted material) → root node, streamed |
| `POST /api/learn/deeper` | ancestor chain + selected span → child node, streamed |
| `POST /api/learn/simplify` | node → rewritten node |
| `POST /api/learn/visual` | node or selection → image via existing `IMAGE_MODEL` |

All of them are stateless: the client sends the context each call needs (ancestor
summaries, not whole ancestors, to keep prompts small). Nothing is stored server-side.

Every endpoint takes a `language` and writes in it. The learner picks it once on the learn
screen, and the handoff passes it as the teaching session's `language`. The teaching session
can still switch mid-lesson (`8969fca`), but it should start in the language the learner
studied in.

Reuse `/api/materials/extract` (`api/server.ts:860`) for "upload material to learn from"
instead of building a second path. There's no `/compile` endpoint, because the client
compiles (§3).

### Pedagogy: Learn Mode explains, Teach Mode tests

One shared system instruction built on the LearnLM principles. The important constraint:

> Explain the concept at the requested depth. Do **not** quiz the learner, and do **not**
> hold back information Socratically. Assessment happens in the teaching phase.

This deliberately departs from the Socratic tutor prompt in Gemini's note. That prompt suits
products where one AI has to both teach and test. Poken splits those jobs. A Learn Mode that
refused to give answers would be doing the teaching phase's job, and the loop would get
slower and more annoying.

What each endpoint adds:
- **deeper**: gets the ancestor chain for context and the selection as its subject. Explains
  mechanism, origin and edge cases, and does **not** re-summarize the parent.
- **simplify**: lower reading level, a concrete analogy, no jargon, hard length cap
- **visual**: a flat-vector educational diagram of the concept

### Web sources: two passes, not one (decided: in)

Grounding with Google Search plus `responseSchema` in one call only works on **Gemini 3**
models. Even there, there's a reported issue where the combination returns
`web_search_queries` but **empty `grounding_chunks` / `grounding_supports`**: the search ran,
but the citations are missing. Citations are the whole point.

So each learn call runs in two steps:

1. **Grounded pass:** with the `google_search` tool, returning plain prose. Sources come back
   in `groundingMetadata` (URLs, plus which spans of text each one supports). This is
   reliable.
2. **Structuring pass:** a cheap, fast model with `responseSchema` turns the prose into typed
   blocks. The server attaches sources to blocks using the span offsets from
   `grounding_supports`.

**URLs only ever come from grounding metadata**, never from the model writing them. That's
where made-up links come from.

Output schema for pass 2:
```
{ summary, blocks: [{ id, kind: prose|definition|example|aside, text }],
  keyTerms: [{ term, gloss }], suggestedDeeper: [string] }
```

Latency: stream pass 1's prose to the screen while pass 2 runs, then swap in the structured
blocks. The learner is reading either way. If the metadata bug gets fixed, collapse this to
one call.

Search grounding is billed per grounded prompt. Check current pricing before launch.

### The one server change: reflection tagged by node

Phase 5 extends `generateReflection` to receive the list of nodes the session covered (id
plus a one-line summary, sent by the client pre-session) and return `gaps` tagged with node
ids via `responseSchema`. No fuzzy string matching of gap text against node text afterwards.
Converting it to `responseSchema` also removes the fragile fence-stripping at `:381`.

---

## 6. Frontend

`public/app.js` (3,301 lines) and `public/index.html` (1,525 lines) are vanilla JS with
screens toggled by id: `landing`, `setup`, `session`, `reflection-loading`, `reflection`.
Learn Mode adds a `learn-screen` in the same style. No framework: adding one here would be a
rewrite disguised as a feature.

**Heed `NOTES.md`:** a range deletion by anchors in the stylesheet once silently took about
100 lines of unrelated styles with it. Add new markup and CSS as new blocks, and don't
restructure existing ones.

The selection mechanic:
1. Blocks render with `data-node-id` and `data-block-id`.
2. On `selectionchange`, compute character offsets within the block.
3. A floating toolbar appears at the selection: **Go Deeper · Simplify · Get images**.
4. The result renders as a child, indented under its parent with a breadcrumb, so the rabbit
   hole shows up as a structure instead of a lost scroll position.
5. A persistent **Teach this** button, always enabled, because switching is the learner's
   call.
6. Each block shows its sources as citation chips (favicon + domain) that link out.

Edge cases: a selection may span several paragraphs of one explanation; the branch attaches
under the last selected paragraph and all selected paragraphs go to the model as context
(long selections get a shortened breadcrumb and search Wikipedia by topic instead). A
selection that runs on into a nested explanation is clamped to the one it started in.
Boundaries that split a word are widened to the whole word (not for Han script, which has no
spaces). Selecting inside an existing child is fine, since trees nest to any depth.

### Nudges (decided: learner's call, nudged)

No gates. Nudges go both ways, can be dismissed, and never block:

- **Learn → Teach:** nudge when the tree has depth, e.g. 3 or more levels down one branch, or
  6 or more nodes read on the topic. Example: "You've gone 3 levels into light reactions —
  try teaching it?" The thresholds are guesses; make them constants and tune them from real
  use.
- **Teach → Learn:** for each shaky node, the reflection screen offers "Dig back into
  [node]", which opens Learn Mode on that node.
- No second nudge after a dismissal on the same topic in the same session.

---

## 7. Phasing

Reordered from the Vercel-era plan. **The handoff needs no server change**, so it moves ahead
of persistence: the first half of the loop works before any database exists.

**Phase 1 — Learn Mode vertical slice.** `start` + `deeper` + drag-select + streaming render
+ breadcrumbs. The tree lives in memory only. Proves the core interaction is pleasant before
anything is saved. *Built:* `server/learn.ts` (one route, `POST /api/learn/explain`, SSE),
`public/learn.js`, a `learn-screen` in `index.html`, three lines in `api/server.ts`.
Simplification: **blocks are paragraphs** — the model writes prose split by blank lines and
the client splits on them, so there is no structuring pass yet. Typed blocks with
`responseSchema` arrive with web sources in Phase 3. "Teach this" skips the setup screen
and starts the teaching session directly (topic + language carried over); the student
persona is a dropdown in the session top bar and switches mid-lesson via a `set_persona`
frame (a `[SYSTEM]` note, same mechanism as language switching — no Gemini reopen). The
`materials_text` compile is Phase 2. The selection toolbar also has **Ask a question** (the
same endpoint with a `question` field; answer-first, shorter), every node shows a spinner
until its first words arrive (with a slow-connection note after 8s), and the reflection
screen has **Back to learning**, which returns to the same in-memory tree — the first
manual version of the Phase 5 return path.

**Phase 2 — Learn → Teach handoff.** Client-side compiler (tree → about 30k chars of text) →
sent as a `materials_text` frame (joined with any pasted notes), with topic and language
prefilled. **The first half of the loop works here**, with no server change and no database.
*Built:* `compileNotes()` in `public/learn.js` writes the tree in document order (each
deep-dive right after its paragraph) as `## trail` sections under a one-line header, drops
the deepest-then-oldest branches past 30k and says how many it left out. It is exposed as
`window.pokenLearnNotes(topic)`; `connect()` in `app.js` calls it, so **the tree belongs to
its topic** — Teach this, Teach Again and a setup-screen start on the same topic
(case-insensitive) all carry it; a different topic gets nothing. A toast tells the teacher
the student has read their notes. Verified: the student cited "my notes" and made its
deliberate mistake against them ("chlorophyll absorbs green light the strongest").

**Phase 3 status (2026-09-19).** *Built:* **Simplify** and **Show me** in the selection
toolbar (same nesting as Go deeper; Show me uses `gemini-3.1-flash-image`, picked over
2.5-flash-image after a side-by-side where 2.5 garbled diagram labels), **key-term glosses**
(dotted underline, definition on hover/focus) and **suggested rabbit holes** (chips under each
explanation) via `POST /api/learn/extras` with `responseSchema`. Image nodes carry no text, so
they stay out of the teaching notes.

*Blocked — web sources.* The Gemini API terms for Grounding with Google Search
(ai.google.dev/gemini-api/terms, read 2026-09-19) forbid modifying or interspersing content
with Grounded Results, caching/analyzing/learning from them or using them "for another
purpose", storing them beyond the end user's own chat history, and tracking interactions with
a specific Grounded Result; Search Suggestions must always be shown with them. Poken nests
deep-dives inside explanations, feeds the tree to the AI student (Phase 2), persists it
(Phase 4) and tracks mastery per block (Phase 5) — each conflicts. The two-pass design below
(rewriting grounded prose into blocks) is itself a modification. Options: a separate,
read-only "On the web" box per explanation that shows Google's grounded result unmodified with
its Search Suggestions and is never nested into, stored, or sent to the student; or a
third-party search API whose results feed Gemini as ordinary context, so the explanation cites
real URLs and stays usable everywhere.

*Decided and built: Wikipedia.* Free, no signup, CC BY-SA (usable anywhere with attribution),
and a curated source fits a learning app better than the open web. Each explanation fetches up
to 3 article intros (exact-title lookup + search in parallel, redirects followed,
disambiguation pages skipped, 4s timeout, in the session language's Wikipedia; `zh` uses
`variant=zh-cn`) and passes them to Gemini as background reference. **Backend only (product
decision): the learner sees no citations, links or mention of Wikipedia**; nothing about
sources goes over the wire, and the client strips any stray `[n]` marker. Simplify skips the
lookup. Because there is no visible credit, the prompt's "own words, never copy" rule is what
keeps this within CC BY-SA (attribution is owed for reused wording, not for facts informing
original prose) — measured against the intros, the longest verbatim run was 0–6 words.
Tavily/Brave/Exa can slot in behind `wikipediaSources()` later if Wikipedia-only proves too
narrow.

**Phase 3 — Web sources and the rest of the aids.** Two-pass grounding with citation chips,
plus Simplify, Get images, key terms and suggested rabbit holes. Matches Learn About.

**Phase 4 — Persistence and identity.** Supabase tables with RLS, anonymous sign-in,
browser-direct access. The tree survives the tab. Supabase URL and anon key go through
`cloudbuild.yaml` like `gemini-api-key` does. The anon key is public, but keep it config
rather than hardcoding it.

**Phase 5 — Teach → Learn return path.** Reflection gaps tagged by node id (the one server
change), mastery updated in Supabase from the client, "Dig back into" on the reflection
screen. **The loop closes here.**

**Phase 6 — The map.** A view of the tree with mastery states: solid, shaky, unexplored.
This is the retention feature and the reason to come back.

Phases 1–3 need no database. Phases 1–2 touch no existing server code.

---

## 8. Decisions

1. **Storage + auth → Supabase**, with RLS and browser-direct access. The server stays
   stateless. §4b.
2. **Web sources → in**, via two-pass grounding. §5.
3. **Mode switching → the learner's call**, nudged both ways, never gated. §6.
4. **Mastery → per node**, with reflection gaps tagged by node id. §4a.

## 9. Still open

- **Which Gemini 3 model** runs the grounded pass. Pick it in Phase 3 from the current models
  page, not from a name written here, because preview model names have already changed once.
- **Video sources.** Learn About embeds YouTube, but grounding returns web pages. Video would
  need the YouTube Data API. Defer until text sources prove out.

## 10. Resolved since the first draft

All fixed in `8316b1f` and live since `poken-00006`:
- README and NOTES no longer describe Vercel.
- Pasted notes no longer travel in the WebSocket URL. They go as a `materials_text` frame,
  which is also the handoff route in §3.

Still open, from reading the repo: `README.md` says `cp .env.example .env`, but no
`.env.example` is committed.

---

## References

- Learn About — https://learning.google.com/experiments/learn-about
- LearnLM: Improving Gemini for Learning — https://arxiv.org/abs/2412.16429
- LearnLM prompt guide — https://services.google.com/fh/files/misc/learnlm_prompt_guide.pdf
- LearnLM in Gemini 2.5 (I/O 2025) — https://blog.google/products-and-platforms/products/education/google-gemini-learnlm-update/
- Gemini structured outputs — https://ai.google.dev/gemini-api/docs/structured-output
- Grounding with Google Search — https://ai.google.dev/gemini-api/docs/google-search
- Empty grounding metadata with structured output (forum) — https://discuss.ai.google.dev/t/grounding-metadata-grounding-chunks-grounding-supports-empty-when-using-structured-output-with-google-search-tool/113240
- Gemini image generation — https://ai.google.dev/gemini-api/docs/image-generation
- Cloud Run request timeout — https://docs.cloud.google.com/run/docs/configuring/request-timeout
