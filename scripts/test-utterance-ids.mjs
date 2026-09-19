// Runnable check for teacher transcript utterance ID tracking:
//   node scripts/test-utterance-ids.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(fs.readFileSync(new URL('../public/teacher-utterances.js', import.meta.url), 'utf8'));

let nextId = 0;
const createEntry = () => ({ id: ++nextId, rawText: "" });
const tracker = PokenTeacherUtterances.createTracker({ createEntry, maxEntries: 20 });

const firstPreview = tracker.preview(1, "the water");
const secondPreview = tracker.preview(1, "the water cycle");
assert.equal(secondPreview.created, false);
assert.equal(secondPreview.entry, firstPreview.entry);
const secondEntry = tracker.preview(2, "and then").entry;
const firstFinal = tracker.final(1, "The water cycle.", true);
assert.equal(tracker.size(), 2);
assert.equal(firstFinal.created, false);
assert.equal(firstFinal.entry.rawText, "The water cycle.");
assert.equal(firstFinal.entry.preview, false);
assert.equal(firstFinal.entry.clean, true);
assert.equal(secondEntry.rawText, "and then");
assert.equal(secondEntry.preview, true);

const unknownFinal = tracker.final(3, "done", true);
assert.equal(unknownFinal.created, true);
assert.equal(tracker.size(), 3);
assert.equal(tracker.preview(3, "done now").created, false);

const capped = PokenTeacherUtterances.createTracker({ createEntry, maxEntries: 20 });
for (let utt = 1; utt <= 25; utt++) capped.preview(utt, `preview ${utt}`);
assert.equal(capped.size(), 20);
assert.equal(capped.get(1), undefined);
assert.ok(capped.get(6));
assert.ok(capped.get(25));

const latePreview = tracker.preview(1, "late preview");
assert.equal(latePreview.created, false);
assert.equal(latePreview.entry, firstFinal.entry);
assert.equal(latePreview.entry.preview, true);
assert.equal(latePreview.entry.rawText, "late preview");

console.log("test-utterance-ids: OK");
