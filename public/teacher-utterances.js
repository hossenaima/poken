(() => {
  function createTracker({ createEntry, maxEntries = 20 } = {}) {
    const entries = new Map();

    function getOrCreate(utt) {
      let entry = entries.get(utt);
      let created = false;
      if (!entry) {
        entry = createEntry();
        entries.set(utt, entry);
        created = true;
        while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      }
      entry.utt = utt;
      return { entry, created };
    }

    return {
      preview(utt, text) {
        const result = getOrCreate(utt);
        result.entry.preview = true;
        result.entry.rawText = text;
        return result;
      },
      final(utt, text, clean) {
        const result = getOrCreate(utt);
        result.entry.preview = false;
        result.entry.clean = !!clean;
        result.entry.rawText = text;
        return result;
      },
      get(utt) {
        return entries.get(utt);
      },
      size() {
        return entries.size;
      },
    };
  }

  globalThis.PokenTeacherUtterances = { createTracker };
})();
