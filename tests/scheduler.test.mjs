// Scheduler and deck tests for the omengram plugin.
//
//   node tests/scheduler.test.mjs
//
// Anki.js is deliberately free of QML types so the scheduling rules can be
// exercised under plain node. Anything that needs a running shell is not
// tested here, apart from the two file-I/O snippets, which are plain sh and
// are run as such.

import { execFileSync, spawn, spawnSync } from "node:child_process"
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
         statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
// Anki.js imports Fsrs.js the QML way; here the import line is dropped and
// the same file is handed in as `Fsrs`.
const src = readFileSync(join(here, "..", "Anki.js"), "utf8").replace(/^\.import "Fsrs\.js" as Fsrs$/m, "")
const fsrsSrc = readFileSync(join(here, "..", "Fsrs.js"), "utf8").replace(/^\.pragma library$/m, "")
const Fsrs = {}
new Function("exports", `${fsrsSrc}\nfor (const k of ${JSON.stringify(
  [...fsrsSrc.matchAll(/^(?:function|var) ([A-Za-z_]\w*)/gm)].map((m) => m[1]))}) exports[k] = eval(k)`)(Fsrs)

const EXPORTS = [
  "MINUTE", "HOUR", "DAY", "GRADES", "LEARNING_STEPS", "RELEARNING_STEPS",
  "STARTING_EASE", "MIN_EASE", "MAX_EASE", "MAX_INTERVAL",
  "newState", "normalizeState", "grade", "previewIntervals", "formatInterval",
  "dayKey", "hashId", "parseDeck", "emptyProgress", "parseProgress",
  "stateFor", "buildQueue", "counts", "serializeProgress", "findEntry",
  "mergeProgress", "introducedToday", "reviewsToday", "remainingToday",
  "deckStats", "percent", "appendCard", "dirOf", "baseOf", "MATURE_INTERVAL",
  "resolveDeck", "sanePerDay", "normalizeTags", "filterByTags", "sectionLabel", "promote", "UNDO_DEPTH",
  "READ_SH", "WRITE_SH", "relativeToHome", "READ_LIMIT", "hitReadLimit",
  "LEECH_THRESHOLD", "isLeechLapse", "leechConfig", "unsuspendAll",
  "RETENTION", "saneRetention", "migrate", "memoryLine",
  "LOG_RECORD_LIMIT", "LOG_READ_LIMIT", "APPEND_SH", "LOGTAIL_SH", "logName", "logNames", "logRecord",
  "undoRecord", "serializeRecord", "parseLog", "logRetention", "retentionText",
  "parseDrill", "drillAnswer",
  "LIST_SH", "deckMatches", "pathMatches", "normalizeDecks", "scopeLabel", "resolveDeckDir",
  "parseListing", "buildDeckTree", "nodeState", "toggleDeck", "toggleTag", "assignDeck",
  "mergeDecks", "deckRows", "tagRows", "normalizeLimits", "withLimit", "stepLimit",
  "deckBudgets", "admit", "addTarget",
  "ANKI_ROOT", "isAnkiDeck", "isAnkiCard", "ankiDeckRows", "pickSource", "ankiState",
  "mergeCounts", "mergeStats", "dropAnkiUndo", "ago", "parseSyncStatus", "syncLine",
]
const G = {}
new Function("exports", "Fsrs", `${src}\nfor (const k of ${JSON.stringify(EXPORTS)}) exports[k] = eval(k)`)(G, Fsrs)

let pass = 0, fail = 0
const t = (name, cond) => {
  if (cond) { pass++; console.log("  ok   " + name) }
  else { fail++; console.log("  FAIL " + name) }
}
const group = (name) => console.log("\n" + name)

const NOW = 1_700_000_000
const { DAY, MINUTE } = G

group("a new card walks the learning steps")
{
  const fresh = G.newState()
  t("starts new with no interval or memory",
    fresh.phase === "new" && fresh.interval === 0 && fresh.stability === null)

  const first = G.grade(fresh, "good", NOW)
  t("good moves to the second step, not to review",
    first.phase === "learning" && first.step === 1 && first.due === NOW + 10 * MINUTE)
  t("the first answer gives the card a memory", first.stability > 0 && first.difficulty > 0)

  const graduated = G.grade(first, "good", NOW + 10 * MINUTE)
  t("good again graduates, two days out as FSRS has it",
    graduated.phase === "review" && graduated.interval === 2 * DAY
    && graduated.due === NOW + 10 * MINUTE + 2 * DAY)

  t("again restarts the steps",
    G.grade(first, "again", NOW).step === 0 && G.grade(first, "again", NOW).due === NOW + MINUTE)
  t("hard repeats the current step",
    G.grade(first, "hard", NOW).step === 1 && G.grade(first, "hard", NOW).due === NOW + 10 * MINUTE)
  const easy = G.grade(fresh, "easy", NOW)
  t("easy graduates straight to eight days", easy.phase === "review" && easy.interval === 8 * DAY)
  t("every answer counts as a rep", first.reps === 1 && graduated.reps === 2)
  t("the answer is stamped", graduated.updated === NOW + 10 * MINUTE && graduated.lastReview === NOW + 10 * MINUTE)
}

group("review intervals follow stability")
{
  // Ten days held, answered on the day it was due: recall is at 90%.
  const review = G.normalizeState({ phase: "review", due: NOW, interval: 10 * DAY, ease: 2500, reps: 5 })
  const hard = G.grade(review, "hard", NOW), good = G.grade(review, "good", NOW), easy = G.grade(review, "easy", NOW)

  t("good moves the card further out", good.interval > 10 * DAY)
  t("hard grows more slowly than good", hard.interval < good.interval)
  t("easy grows faster than good", easy.interval > good.interval)
  t("due follows the new interval", good.due === NOW + good.interval)
  t("hard makes the card harder", hard.difficulty > review.difficulty)
  t("easy makes it easier", easy.difficulty < review.difficulty)
  t("intervals are whole days", [hard, good, easy].every((s) => s.interval % DAY === 0))
}

group("lapses")
{
  const review = G.normalizeState({ phase: "review", due: NOW, interval: 20 * DAY, ease: 2500, reps: 8, lapses: 1 })
  const lapsed = G.grade(review, "again", NOW)

  t("again enters relearning", lapsed.phase === "relearning")
  t("again counts a lapse", lapsed.lapses === 2)
  t("again is due in ten minutes", lapsed.due === NOW + 10 * MINUTE)
  t("forgetting cuts stability", lapsed.stability < review.stability)
  t("and raises difficulty", lapsed.difficulty > review.difficulty)

  const recovered = G.grade(lapsed, "good", NOW + 10 * MINUTE)
  t("leaving relearning returns to review, shorter than before",
    recovered.phase === "review" && recovered.interval >= DAY && recovered.interval < 20 * DAY)
  t("again inside relearning stays there and is not another lapse",
    G.grade(lapsed, "again", NOW).phase === "relearning" && G.grade(lapsed, "again", NOW).lapses === 2)
  t("easy inside relearning leaves immediately",
    G.grade(lapsed, "easy", NOW).phase === "review")
}

group("memory and interval stay in range")
{
  let s = G.normalizeState({ phase: "review", due: NOW, interval: DAY, ease: 2500, reps: 1 })
  let at = NOW
  for (let i = 0; i < 20; i++) { at += DAY; s = G.grade({ ...s, phase: "review" }, "again", at) }
  t("difficulty has a ceiling", s.difficulty <= 10)
  t("stability has a floor", s.stability >= 0.001)

  let e = G.grade(G.newState(), "easy", NOW)
  at = NOW
  for (let i = 0; i < 30; i++) { at = e.due; e = G.grade(e, "easy", at) }
  t("difficulty has a floor", e.difficulty >= 1)
  t("interval has a ceiling", e.interval <= G.MAX_INTERVAL)
}

group("progress from before FSRS carries over")
{
  const sm2 = { phase: "review", due: NOW + 3 * DAY, interval: 12 * DAY, ease: 2500, reps: 6, lapses: 1,
                step: 0, updated: NOW - 9 * DAY, firstDay: "2026-01-01" }
  const m = G.normalizeState(sm2)
  t("stability is the days it was holding", m.stability === 12)
  t("SM-2's starting ease is middling difficulty", m.difficulty === 5)
  t("the lowest ease is the hardest card", G.normalizeState({ ...sm2, ease: G.MIN_EASE }).difficulty === 10)
  t("a high ease is an easier card", G.normalizeState({ ...sm2, ease: G.MAX_EASE }).difficulty < 3)
  t("the last answer is worked back from the due date", m.lastReview === NOW - 9 * DAY)
  t("the due date does not move", m.due === sm2.due)
  t("the stamp is left alone, so a merge still compares like with like", m.updated === sm2.updated)
  t("migrating twice changes nothing",
    JSON.stringify(G.normalizeState(m)) === JSON.stringify(m))
  t("a card still learning has no memory to carry",
    G.normalizeState({ phase: "learning", step: 1, due: NOW }).stability === null)
  t("half a memory state is dropped",
    G.normalizeState({ phase: "learning", stability: 3 }).stability === null)

  const next = G.grade(sm2, "good", NOW + 3 * DAY)
  t("its next answer schedules from the carried memory", next.phase === "review" && next.interval > 12 * DAY)
}

group("the retention setting")
{
  const review = G.normalizeState({ phase: "review", due: NOW, interval: 30 * DAY, ease: 2500, reps: 5 })
  const at = (r) => G.grade(review, "good", NOW, undefined, { retention: r }).interval
  t("lower retention means longer gaps", at(80) > at(90) && at(90) > at(97))
  t("retention is clamped to 70-99", G.saneRetention(10) === 70 && G.saneRetention(100) === 99)
  t("nonsense falls back to 90", G.saneRetention("x") === 90 && G.RETENTION === 90)
  t("the labels price with the setting",
    G.previewIntervals(review, NOW, { retention: 80 }).good !== G.previewIntervals(review, NOW).good)
}

group("hostile state is coerced, never trusted")
{
  t("a nonsense phase becomes a new card", G.normalizeState({ phase: "wat" }).phase === "new")
  t("a null state becomes a new card", G.normalizeState(null).phase === "new")
  t("NaN interval becomes zero", G.normalizeState({ phase: "review", interval: "abc" }).interval === 0)
  t("a negative due is clamped", G.normalizeState({ phase: "review", due: -99 }).due === 0)
  t("an out-of-range ease is clamped", G.normalizeState({ phase: "review", ease: 99999 }).ease === G.MAX_EASE)
  t("an out-of-range step is clamped",
    G.normalizeState({ phase: "learning", step: 47 }).step === G.LEARNING_STEPS.length - 1)
  t("an unknown grade is a no-op",
    G.grade(G.newState(), "excellent", NOW).phase === "new")
}

group("interval labels")
{
  t("seconds", G.formatInterval(30) === "<1m")
  t("minutes", G.formatInterval(10 * MINUTE) === "10m")
  t("hours", G.formatInterval(5 * 3600) === "5h")
  t("days", G.formatInterval(3 * DAY) === "3d")
  t("months", G.formatInterval(60 * DAY) === "2mo")
  t("years", G.formatInterval(730 * DAY) === "2y")

  const preview = G.previewIntervals(G.newState(), NOW)
  t("every grade is priced", G.GRADES.every((g) => preview[g].length > 0))
  t("previewing does not schedule anything", G.newState().reps === 0)
}

group("deck parsing")
{
  const deck = G.parseDeck(JSON.stringify({
    cards: [
      { front: " Capital of France ", back: "Paris" },
      { front: "", back: "dropped" },
      { front: "no back", back: "  " },
      { front: "Capital of France", back: "duplicate" },
      { front: "Tagged", back: "yes", tags: ["geo", 7] },
      "not an object",
    ],
  }))

  t("two usable cards survive", deck.cards.length === 2)
  t("whitespace is trimmed", deck.cards[0].front === "Capital of France")
  t("a duplicate front is dropped", deck.cards.filter((c) => c.front === "Capital of France").length === 1)
  t("tags are coerced to strings", deck.cards[1].tags.join(",") === "geo,7")
  t("a bare array is accepted", G.parseDeck('[{"front":"a","back":"b"}]').cards.length === 1)
  t("broken JSON reports an error", G.parseDeck("{oops").error.length > 0)
  t("a missing cards array reports an error", G.parseDeck('{"deck":[]}').error.length > 0)

  t("the id follows the front, not the position",
    G.parseDeck('[{"front":"a","back":"1"},{"front":"b","back":"2"}]').cards[1].id ===
    G.parseDeck('[{"front":"b","back":"2"},{"front":"a","back":"1"}]').cards[0].id)
  t("editing the back keeps the id",
    G.parseDeck('[{"front":"a","back":"1"}]').cards[0].id ===
    G.parseDeck('[{"front":"a","back":"CHANGED"}]').cards[0].id)
  t("editing the front is a new card",
    G.parseDeck('[{"front":"a","back":"1"}]').cards[0].id !==
    G.parseDeck('[{"front":"A","back":"1"}]').cards[0].id)
  t("an explicit id wins", G.parseDeck('[{"id":"mine","front":"a","back":"1"}]').cards[0].id === "mine")
}

group("drill cards in a deck")
{
  const deck = G.parseDeck(JSON.stringify({ source: "gleamdrill-import", cards: [
    { front: "plain", back: "card" },
    { front: "typed", back: "Paris", kind: "type" },
    { id: "gd:py:x", front: "code it", back: "", kind: "code", lang: "python", answer: "def f():\n    return 1   \n",
      harness: "__case__('a', 1, f())", complexity: "O(1)", nudge: "think",
      alternates: [{ label: "Other", answer: "def f(): return 1" }, { label: "empty", answer: "" }],
      patterns: [{ slug: "p", name: "P", steps: ["s"], notes: [{ id: 1, step: 0, pseudo: "  return one", hint: "h", why: "w" }, { id: 0 }],
                   lines: [{ given: "def f():" }, { text: "  return 1 ", indent: 4, notes: [1, "x"] }, { text: "" }, 7] }] },
    { front: "code without code", back: "notes", kind: "code" },
    { front: "only patterns", back: "b", patterns: [{ slug: "q", lines: [{ text: "x = 1", indent: 0, notes: [1] }] }] },
    { front: "a pattern with nothing to type", back: "b", patterns: [{ slug: "q", lines: [{ given: "x" }] }] },
    { front: "nonsense kind", back: "b", kind: "essay" },
    { front: "no back, no answer", back: "", kind: "code" },
  ] }))
  const [plain, typed, coded, noCode, onlyPatterns, untypable, nonsense] = deck.cards
  t("a deck with a source marker still parses", !deck.error && deck.cards.length === 7)
  t("a plain card has no drill", plain.drill === null)
  t("a typed card", typed.drill.kind === "type" && G.drillAnswer(typed) === "Paris")
  t("a code card keeps its code, indentation and all, trimmed at the end",
    coded.drill.kind === "code" && coded.drill.answer === "def f():\n    return 1" && G.drillAnswer(coded) === coded.drill.answer)
  t("a code card may leave its back for notes", coded.back === "" && coded.id === "gd:py:x")
  t("its language, harness, complexity and nudge",
    coded.drill.lang === "python" && coded.drill.harness.startsWith("__case__") && coded.drill.complexity === "O(1)" && coded.drill.nudge === "think")
  t("alternates without code are dropped", coded.drill.alternates.length === 1 && coded.drill.alternates[0].label === "Other")
  const p = coded.drill.patterns[0]
  t("a pattern's notes, the bad one dropped", p.notes.length === 1 && p.notes[0].pseudo === "  return one")
  t("its lines: given kept as is, typed trimmed with their indent",
    p.lines.length === 2 && p.lines[0].given === "def f():" && p.lines[1].text === "return 1" && p.lines[1].indent === 4
    && JSON.stringify(p.lines[1].notes) === "[1]")
  t("a code card with no code is a plain card", noCode.drill === null)
  t("patterns alone make a drill", onlyPatterns.drill && onlyPatterns.drill.patterns.length === 1 && onlyPatterns.drill.kind === "type")
  t("a pattern with nothing to type is not one", untypable.drill === null)
  t("an unknown kind is a plain card", nonsense.drill === null)
  t("a card with neither back nor answer is dropped", !deck.cards.some((c) => c.front === "no back, no answer"))
  t("the deck's cards keep their drill", G.assignDeck([coded], "d")[0].drill === coded.drill)
}

group("a drill's kind in the log")
{
  const [card] = G.parseDeck(JSON.stringify({ cards: [{ front: "a", back: "", kind: "code", answer: "x = 1" }] })).cards
  const rec = G.logRecord({ card, now: 1000, grade: "good", mode: "free", tests: { pass: 2, total: 3 } })
  t("logged as a code drill", rec.kind === "code")
  t("with its test results", rec.tests.pass === 2 && rec.tests.total === 3)
}

group("tag filtering")
{
  const deck = G.parseDeck(JSON.stringify([
    { front: "a", back: "1", tags: ["omarchy", "cli"] },
    { front: "b", back: "2", tags: ["Spanish"] },
    { front: "c", back: "3" },
    { front: "d", back: "4", tags: ["cli"] },
  ])).cards

  t("no filter keeps the whole deck", G.filterByTags(deck, []).length === 4)
  t("an absent filter keeps the whole deck", G.filterByTags(deck, undefined).length === 4)
  t("a filter keeps only matching cards", G.filterByTags(deck, ["cli"]).map(c => c.front).join("") === "ad")
  t("an untagged card is excluded by any filter", !G.filterByTags(deck, ["cli"]).some(c => c.front === "c"))
  t("several tags are a union, not an intersection",
    G.filterByTags(deck, ["omarchy", "spanish"]).map(c => c.front).join("") === "ab")
  t("matching ignores case on both sides", G.filterByTags(deck, ["SPANISH"]).length === 1)
  t("a bare string works like a one-element list", G.filterByTags(deck, "cli").length === 2)
  t("a filter matching nothing yields nothing", G.filterByTags(deck, ["nope"]).length === 0)
  t("filtering does not mutate the deck", deck.length === 4)

  t("tags are lowercased and de-duplicated",
    G.normalizeTags(["CLI", "cli", " Cli "]).join(",") === "cli")
  t("empty entries are dropped", G.normalizeTags(["", "  ", "a"]).join(",") === "a")
  t("null is an empty filter", G.normalizeTags(null).length === 0)
}

group("the section label")
{
  const review = { phase: "review", due: NOW, interval: 10 * DAY, ease: 2500, reps: 5, lapses: 0, step: 0 }
  t("a new card", G.sectionLabel("reviewing", { phase: "new" }, []) === "NEW")
  t("not reviewing", G.sectionLabel("done", { phase: "new" }, []) === "SESSION")
  t("a review card shows interval and ease",
    G.sectionLabel("reviewing", review, []) === "REVIEW  ·  10d  ·  ease 2.50")
  t("a lapsed card counts its lapses",
    G.sectionLabel("reviewing", { phase: "relearning", lapses: 1 }, []).indexOf("1 lapse") !== -1)
  t("plural lapses",
    G.sectionLabel("reviewing", { phase: "relearning", lapses: 3 }, []).indexOf("3 lapses") !== -1)
  t("an active filter is shown", G.sectionLabel("reviewing", { phase: "new" }, ["cli"]) === "NEW  ·  #cli")
  t("no filter adds nothing", G.sectionLabel("reviewing", { phase: "new" }, []).indexOf("#") === -1)
}

group("the queue")
{
  const cards = G.parseDeck(JSON.stringify([
    { front: "one", back: "1" },
    { front: "two", back: "2" },
    { front: "three", back: "3" },
  ])).cards
  const [a, b, c] = cards.map((x) => x.id)
  const today = G.dayKey(NOW)

  const progress = {
    reviews: {
      [a]: { phase: "review", due: NOW - 100, interval: 5 * DAY, ease: 2500, reps: 3, lapses: 0, step: 0 },
      [b]: { phase: "review", due: NOW + 5 * DAY, interval: 5 * DAY, ease: 2500, reps: 3, lapses: 0, step: 0 },
    },
  }

  const queue = G.buildQueue(cards, progress, NOW, 20)
  t("a due card is queued", queue.includes(a))
  t("a card due in the future is not", !queue.includes(b))
  t("an unseen card is queued", queue.includes(c))
  t("due cards come before new ones", queue.indexOf(a) < queue.indexOf(c))

  t("the new-card allowance is respected",
    G.buildQueue(cards, G.emptyProgress(), NOW, 1).length === 1)

  // Two cards dated today, so the allowance of two is already spent.
  const spentToday = { reviews: {
    [a]: { phase: "review", due: NOW + DAY, interval: DAY, ease: 2500, reps: 1, lapses: 0, step: 0, firstDay: today },
    [b]: { phase: "review", due: NOW + DAY, interval: DAY, ease: 2500, reps: 1, lapses: 0, step: 0, firstDay: today },
  } }
  t("cards introduced today count against it",
    G.buildQueue(cards, spentToday, NOW, 2).length === 0)
  t("the same cards dated yesterday do not", (() => {
    const yesterday = JSON.parse(JSON.stringify(spentToday))
    for (const id of Object.keys(yesterday.reviews)) yesterday.reviews[id].firstDay = "1999-01-01"
    return G.buildQueue(cards, yesterday, NOW, 2).length === 1
  })())
  t("introducedToday counts only today's", G.introducedToday(spentToday, NOW) === 2)
  t("an undated card counts as never introduced",
    G.introducedToday({ reviews: { x: G.newState() } }, NOW) === 0)

  const overdue = {
    reviews: {
      [a]: { phase: "review", due: NOW - 10, interval: DAY, ease: 2500, reps: 1, lapses: 0, step: 0 },
      [b]: { phase: "review", due: NOW - 9999, interval: DAY, ease: 2500, reps: 1, lapses: 0, step: 0 },
    },
  }
  t("the most overdue card comes first", G.buildQueue(cards, overdue, NOW, 0)[0] === b)

  const stats = G.counts(cards, progress, NOW, 20)
  t("counts the due card", stats.due === 1)
  t("counts the new card", stats.fresh === 1)
  t("counts the whole deck", stats.total === 3)
  t("pending is due plus new", stats.pending === 2)
  t("caps new by the day's allowance", G.counts(cards, progress, NOW, 0).fresh === 0)
  t("reports when the next card is due", stats.nextDue === NOW + 5 * DAY)

  const learning = {
    reviews: { [a]: { phase: "learning", due: NOW + 60, interval: 0, ease: 2500, reps: 1, lapses: 0, step: 0 } },
  }
  t("a learning card not yet due is waiting, not due",
    G.counts(cards, learning, NOW, 0).waiting === 1 && G.counts(cards, learning, NOW, 0).due === 0)
}

group("promoting a card for undo")
{
  t("an already-queued card moves to the front",
    G.promote(["a", "b", "c"], "c").join(",") === "c,a,b")
  t("it is not duplicated", G.promote(["a", "b", "c"], "c").length === 3)
  t("a card the rebuild dropped is inserted",
    G.promote(["a", "b"], "z").join(",") === "z,a,b")
  t("the front card stays at the front", G.promote(["a", "b"], "a").join(",") === "a,b")
  t("an empty queue yields just the card", G.promote([], "a").join(",") === "a")
  t("no id leaves the queue alone", G.promote(["a", "b"], "").join(",") === "a,b")
  t("the original queue is not mutated", (() => {
    const q = ["a", "b", "c"]
    G.promote(q, "c")
    return q.join(",") === "a,b,c"
  })())

  t("undo depth is bounded", G.UNDO_DEPTH > 0 && G.UNDO_DEPTH <= 100)
}

group("undo restores what the answer changed")
{
  // The QML owns the stack, but the state arithmetic it puts back is this
  // module's: an answer must be reconstructible from the snapshot alone.
  const fresh = G.newState()
  const answered = G.grade(fresh, "good", NOW)
  t("an answer changes the state", answered.phase !== fresh.phase || answered.due !== fresh.due)
  t("grading never mutates the state handed in",
    fresh.phase === "new" && fresh.reps === 0 && fresh.due === 0)
  t("so the pre-answer state is still a faithful snapshot",
    JSON.stringify(fresh) === JSON.stringify(G.newState()))

  const review = { phase: "review", due: NOW, interval: 10 * DAY, ease: 2500, reps: 5, lapses: 0, step: 0 }
  const lapsed = G.grade(review, "again", NOW)
  t("a lapse changes the memory and the interval",
    lapsed.stability !== G.normalizeState(review).stability && lapsed.interval !== review.interval)
  t("and leaves the original untouched to restore from",
    review.ease === 2500 && review.interval === 10 * DAY && review.lapses === 0)
}

group("the daily review cap")
{
  const cards = G.parseDeck(JSON.stringify(
    Array.from({ length: 5 }, (_, i) => ({ front: "q" + i, back: "a" + i })))).cards
  const today = G.dayKey(NOW)

  // Five cards, all due, all first seen well before today.
  const due = { reviews: {} }
  for (const c of cards)
    due.reviews[c.id] = { phase: "review", due: NOW - 100, interval: 5 * DAY, ease: 2500,
                          reps: 3, lapses: 0, step: 0, updated: 0, firstDay: "1999-01-01" }

  t("no cap serves everything due", G.buildQueue(cards, due, NOW, 0, 0).length === 5)
  t("a cap trims the queue", G.buildQueue(cards, due, NOW, 0, 2).length === 2)
  t("counts agree with the queue", G.counts(cards, due, NOW, 0, 2).due === 2)
  t("what the cap holds back is reported separately", G.counts(cards, due, NOW, 0, 2).held === 3)
  t("nothing is held back without a cap", G.counts(cards, due, NOW, 0, 0).held === 0)

  t("the most overdue survive the trim", (() => {
    const spread = { reviews: {} }
    cards.forEach((c, i) => {
      spread.reviews[c.id] = { phase: "review", due: NOW - (100 - i * 10), interval: DAY,
                               ease: 2500, reps: 3, lapses: 0, step: 0, updated: 0, firstDay: "1999-01-01" }
    })
    return G.buildQueue(cards, spread, NOW, 0, 1)[0] === cards[0].id
  })())

  // Answering today spends the budget.
  const doneToday = JSON.parse(JSON.stringify(due))
  doneToday.reviews[cards[0].id].updated = NOW
  doneToday.reviews[cards[1].id].updated = NOW
  t("cards answered today count as reviews", G.reviewsToday(doneToday, NOW) === 2)
  t("a spent budget serves nothing", G.buildQueue(cards, doneToday, NOW, 0, 2).length === 0)

  t("a card introduced today is not also a review", (() => {
    const fresh = { reviews: { x: { phase: "learning", due: NOW, interval: 0, ease: 2500,
                                    reps: 1, lapses: 0, step: 0, updated: NOW, firstDay: today } } }
    return G.reviewsToday(fresh, NOW) === 0
  })())
  t("an unanswered card is not a review today", G.reviewsToday(due, NOW) === 0)

  t("remainingToday reports an uncapped budget as infinite",
    G.remainingToday(due, NOW, 20, 0).due === Infinity)
  t("and a spent one as zero", G.remainingToday(doneToday, NOW, 20, 2).due === 0)
}

group("deck statistics")
{
  const cards = G.parseDeck(JSON.stringify(
    Array.from({ length: 6 }, (_, i) => ({ front: "q" + i, back: "a" + i })))).cards
  const [a, b, c, d, e, f] = cards.map((x) => x.id)

  const progress = { reviews: {
    [a]: { phase: "review", due: NOW + 30 * DAY, interval: 30 * DAY, ease: 2600, reps: 9, lapses: 0, step: 0, updated: NOW, firstDay: "1999-01-01" },
    [b]: { phase: "review", due: NOW + 2 * DAY, interval: 2 * DAY, ease: 2400, reps: 4, lapses: 1, step: 0, updated: 0, firstDay: "1999-01-01" },
    [c]: { phase: "learning", due: NOW + 60, interval: 0, ease: 2500, reps: 1, lapses: 0, step: 0, updated: NOW, firstDay: G.dayKey(NOW) },
    [d]: { phase: "relearning", due: NOW + 600, interval: DAY, ease: 2300, reps: 7, lapses: 2, step: 0, updated: 0, firstDay: "1999-01-01" },
  } }

  const s = G.deckStats(cards, progress, NOW, 20, 0)
  t("counts the whole deck", s.total === 6)
  t("unanswered cards are new", s.fresh === 2)
  t("a long interval is mature", s.mature === 1)
  t("a short one is young", s.young === 1)
  t("learning and relearning are one bucket", s.learning === 2)
  t("the buckets account for every card", s.fresh + s.mature + s.young + s.learning === s.total)
  t("seen is the deck less the new", s.seen === 4)
  t("lapsed cards are counted once each", s.lapsed === 2)
  t("lapses are totalled", s.lapses === 3)
  t("average difficulty is over cards with a memory only",
    s.difficultyCount === 3 && Math.abs(s.difficulty - (4.5833 + 5.4167 + 5.8333) / 3) < 0.001)
  t("ease is Anki's alone now", s.easeCount === 0 && s.ease === 0)
  t("the memory line says difficulty", G.memoryLine(s) === "difficulty " + s.difficulty.toFixed(1))
  t("answered today is counted", s.answeredToday === 2)
  t("retention falls out of lapses over reps", Math.abs(s.retention - (1 - 3 / 21)) < 0.001)

  t("the forecast buckets by day", s.forecast[0] === 2 && s.forecast[2] === 1)
  t("the forecast spans a week", s.forecast.length === 7)
  t("cards beyond the week are not in it", s.forecast.reduce((x, y) => x + y, 0) === 3)

  const empty = G.deckStats([], G.emptyProgress(), NOW, 20, 0)
  t("an empty deck is all zeroes, not NaN", empty.total === 0 && empty.ease === 0 && empty.retention === 0)
  t("percent formats a fraction", G.percent(0.8) === "80%")
  t("percent clamps", G.percent(9) === "100%" && G.percent(-1) === "0%")
}

group("adding a card to the deck")
{
  const deck = JSON.stringify({ cards: [{ front: "a", back: "1", note: "kept" }] }, null, 2)

  const added = G.appendCard(deck, "b", "2", ["x"])
  t("succeeds", added.error === "")
  t("the new card is appended", JSON.parse(added.raw).cards.length === 2)
  t("the new card holds what was typed", (() => {
    const card = JSON.parse(added.raw).cards[1]
    return card.front === "b" && card.back === "2" && card.tags.join() === "x"
  })())
  t("fields the plugin knows nothing about survive",
    JSON.parse(added.raw).cards[0].note === "kept")
  t("existing cards keep their order", JSON.parse(added.raw).cards[0].front === "a")
  t("input is trimmed", JSON.parse(G.appendCard(deck, "  c  ", "  3  ").raw).cards[1].front === "c")
  t("no tags means no tags key", JSON.parse(G.appendCard(deck, "c", "3").raw).cards[1].tags === undefined)
  t("a bare array deck stays a bare array",
    Array.isArray(JSON.parse(G.appendCard('[{"front":"a","back":"1"}]', "b", "2").raw)))
  t("an absent deck is created", JSON.parse(G.appendCard("", "a", "1").raw).cards.length === 1)

  t("a missing front is refused", G.appendCard(deck, "", "2").error.length > 0)
  t("a missing back is refused", G.appendCard(deck, "b", "  ").error.length > 0)
  t("a duplicate front is refused", G.appendCard(deck, "a", "different").error.length > 0)
  t("a duplicate is refused even against an explicit id",
    G.appendCard(JSON.stringify({ cards: [{ id: G.hashId("z"), front: "other", back: "1" }] }), "z", "2").error.length > 0)

  // The one unrecoverable thing it could do is overwrite a deck it failed to
  // parse, so a broken deck must come back untouched.
  const broken = "{ not json"
  const refused = G.appendCard(broken, "b", "2")
  t("a broken deck is refused", refused.error.length > 0)
  t("and handed back byte for byte", refused.raw === broken)
  t("a deck with no cards array is refused", G.appendCard('{"x":1}', "b", "2").error.length > 0)
}

group("splitting a deck path for the writer")
{
  t("directory", G.dirOf("/home/u/.local/share/omengram/cards.json") === "/home/u/.local/share/omengram")
  t("file name", G.baseOf("/home/u/.local/share/omengram/cards.json") === "cards.json")
  t("a bare name has no directory", G.baseOf("cards.json") === "cards.json")
  t("a root-level file keeps a valid directory", G.dirOf("/cards.json") === "/")
}

group("the study day rolls over at 4am, not midnight")
{
  const at = (h, m) => Math.floor(new Date(2026, 0, 15, h, m, 0).getTime() / 1000)
  t("1am still belongs to the previous day", G.dayKey(at(1, 0)) === "2026-01-14")
  t("3:59am still does", G.dayKey(at(3, 59)) === "2026-01-14")
  t("4am starts the new day", G.dayKey(at(4, 0)) === "2026-01-15")
  t("the afternoon is unsurprising", G.dayKey(at(15, 0)) === "2026-01-15")
}

group("progress round-trips")
{
  const progress = {
    reviews: { abc: { phase: "review", due: NOW, interval: DAY, ease: 2500, reps: 1, lapses: 0, step: 0, updated: NOW, firstDay: "2026-01-15" } },
  }
  const back = G.parseProgress(G.serializeProgress(progress))
  t("card state survives", back.reviews.abc.interval === DAY)
  t("the change stamp survives", back.reviews.abc.updated === NOW)
  t("the introduction date survives", back.reviews.abc.firstDay === "2026-01-15")
  t("a corrupt file is empty, not fatal", Object.keys(G.parseProgress("{not json").reviews).length === 0)
  t("an absent file is empty", Object.keys(G.parseProgress("").reviews).length === 0)
  t("a document written before the tally was derived still loads",
    G.parseProgress(JSON.stringify({ day: "2026-01-01", introduced: 9, reviews: progress.reviews }))
      .reviews.abc.interval === DAY)
  t("an unknown card reads as new", G.stateFor(progress, "nope").phase === "new")
}

group("merging two surfaces' documents")
{
  const at = (t, extra) => Object.assign(
    { phase: "review", due: NOW, interval: DAY, ease: 2500, reps: 1, lapses: 0, step: 0, updated: t, firstDay: "" },
    extra || {})

  // The exact loss reproduced by hand: the overlay answers two cards, the bar
  // panel then saves a copy that predates both. Without merging, the panel's
  // write erased a card outright.
  const overlay = { reviews: { a: at(NOW + 10), b: at(NOW + 20) } }
  const stalePanel = { reviews: {} }
  const merged = G.mergeProgress(stalePanel, overlay)
  t("a stale document cannot erase the other surface's work",
    Object.keys(merged.reviews).sort().join(",") === "a,b")

  t("the newer entry wins", G.mergeProgress(
    { reviews: { a: at(NOW, { reps: 1 }) } },
    { reviews: { a: at(NOW + 5, { reps: 9 }) } }).reviews.a.reps === 9)
  t("and it wins from either side", G.mergeProgress(
    { reviews: { a: at(NOW + 5, { reps: 9 }) } },
    { reviews: { a: at(NOW, { reps: 1 }) } }).reviews.a.reps === 9)
  t("a card only one side knows is kept", G.mergeProgress(
    { reviews: { a: at(NOW) } }, { reviews: { b: at(NOW) } }).reviews.b !== undefined)
  t("a tie is deterministic, keeping mine", G.mergeProgress(
    { reviews: { a: at(NOW, { reps: 1 }) } },
    { reviews: { a: at(NOW, { reps: 9 }) } }).reviews.a.reps === 1)

  t("merging with nothing is a no-op",
    G.mergeProgress({ reviews: { a: at(NOW) } }, G.emptyProgress()).reviews.a !== undefined)
  t("merging into nothing adopts everything",
    G.mergeProgress(G.emptyProgress(), { reviews: { a: at(NOW) } }).reviews.a !== undefined)
  t("null operands are survivable", Object.keys(G.mergeProgress(null, null).reviews).length === 0)
  t("merged entries are normalized, not trusted",
    G.mergeProgress({ reviews: { a: { phase: "nonsense" } } }, null).reviews.a.phase === "new")
  t("merging does not mutate either operand", (() => {
    const mine = { reviews: { a: at(NOW, { reps: 1 }) } }
    G.mergeProgress(mine, { reviews: { a: at(NOW + 5, { reps: 9 }) } })
    return mine.reviews.a.reps === 1
  })())

  // Undo restores an older state, so it must be re-stamped or the merge would
  // hand back the very answer it just took back.
  t("an undo re-stamped as now survives a merge with the answer it undid", (() => {
    const answered = at(NOW + 10, { reps: 5 })
    const restored = at(NOW + 30, { reps: 4 })
    return G.mergeProgress({ reviews: { a: restored } }, { reviews: { a: answered } }).reviews.a.reps === 4
  })())
}

group("answers carry the stamps a merge needs")
{
  const answered = G.grade(G.newState(), "good", NOW)
  t("an answer is stamped with when it happened", answered.updated === NOW)
  t("a card leaving new is dated today", answered.firstDay === G.dayKey(NOW))

  const older = G.grade({ phase: "review", due: NOW, interval: DAY, ease: 2500, reps: 3, lapses: 0, step: 0, firstDay: "1999-01-01" }, "good", NOW)
  t("re-answering an old card keeps its original date", older.firstDay === "1999-01-01")
  t("but restamps when it changed", older.updated === NOW)
}

group("settings are read from wherever the plugin is configured")
{
  const id = "gudetimes.omengram"
  t("from the bar layout",
    G.findEntry({ bar: { layout: { right: [{ id, newPerDay: 5 }] } } }, id).newPerDay === 5)
  t("from the plugins list",
    G.findEntry({ plugins: [{ id, newPerDay: 7 }] }, id).newPerDay === 7)
  t("absent is an empty object", Object.keys(G.findEntry({}, id)).length === 0)
}

group("settings resolution is shared by both surfaces")
{
  const HOME = "/home/u"
  t("an unset deck falls back to the default",
    G.resolveDeck("", HOME) === HOME + "/.local/share/omengram/cards.json")
  t("an undefined deck falls back too",
    G.resolveDeck(undefined, HOME) === HOME + "/.local/share/omengram/cards.json")
  t("a leading ~/ expands", G.resolveDeck("~/notes/spanish.json", HOME) === HOME + "/notes/spanish.json")
  t("a bare ~ expands", G.resolveDeck("~", HOME) === HOME)
  t("an absolute path is left alone", G.resolveDeck("/srv/decks/a.json", HOME) === "/srv/decks/a.json")
  t("a ~ that is not a home reference is left alone",
    G.resolveDeck("/tmp/~weird.json", HOME) === "/tmp/~weird.json")
  t("whitespace is trimmed", G.resolveDeck("  ~/a.json  ", HOME) === HOME + "/a.json")

  t("a sane allowance is kept", G.sanePerDay(5) === 5)
  t("zero is a real choice, not a fallback", G.sanePerDay(0) === 0)
  t("a numeric string is accepted", G.sanePerDay("7") === 7)
  t("a typo falls back to the default", G.sanePerDay("lots") === 20)
  t("undefined falls back to the default", G.sanePerDay(undefined) === 20)
  t("a negative falls back to the default", G.sanePerDay(-3) === 20)
}

// --------------------------------------------------------------- file I/O
//
// READ_SH and WRITE_SH are plain sh, so they are run as plain sh against real
// directories. What is being checked is that neither can be pointed at a file
// it was not meant to touch — including by a symlink planted at any component
// of the path, not merely at the file itself.

const sh = (script, home, rel, input) =>
  spawnSync("sh", ["-c", script, "omengram", home, rel],
            { input: input ?? "", encoding: "utf8" })

const REL = ".local/state/omarchy/omengram.json"
const CHAIN = [".local", ".local/state", ".local/state/omarchy"]

// A home with the chain already present, so a test can replace one link of it.
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "omengram-home-"))
  mkdirSync(join(home, ".local/state/omarchy"), { recursive: true })
  return home
}

function makeDecoy() {
  const dir = mkdtempSync(join(tmpdir(), "omengram-decoy-"))
  writeFileSync(join(dir, "omengram.json"), "untouched\n")
  return dir
}

group("writing creates its own chain, privately")
{
  const home = mkdtempSync(join(tmpdir(), "omengram-fresh-"))
  const doc = G.serializeProgress({ reviews: {} })
  const r = sh(G.WRITE_SH, home, REL, doc)

  t("a write into an empty home succeeds", r.status === 0)
  t("the document lands intact", readFileSync(join(home, REL), "utf8") === doc)
  t("the file is private", (statSync(join(home, REL)).mode & 0o777) === 0o600)
  for (const d of CHAIN)
    t(`${d} is created private`, (statSync(join(home, d)).mode & 0o777) === 0o700)
  t("no temp file is left behind",
    readdirSync(join(home, ".local/state/omarchy")).filter((f) => f.startsWith(".omengram.")).length === 0)
}

group("directories that already exist keep their modes")
{
  // ~/.local and ~/.config are shared with every other application. Tightening
  // them because a flashcard plugin happened to walk past would be overreach.
  const home = mkdtempSync(join(tmpdir(), "omengram-modes-"))
  mkdirSync(join(home, ".local"), { recursive: true, mode: 0o755 })
  chmodSync(join(home, ".local"), 0o755)

  const r = sh(G.WRITE_SH, home, REL, "{}\n")
  t("the write still succeeds", r.status === 0)
  t("an existing directory is left as it was",
    (statSync(join(home, ".local")).mode & 0o777) === 0o755)
  t("but one we create is still private",
    (statSync(join(home, ".local/state")).mode & 0o777) === 0o700)
}

group("a symlink planted at any component redirects nothing")
{
  // The whole point: guarding the final file is worthless if the walk to it
  // was already diverted. Each component gets its turn as the planted link.
  for (const component of CHAIN) {
    const home = makeHome()
    const decoy = makeDecoy()

    rmSync(join(home, component), { recursive: true, force: true })
    symlinkSync(decoy, join(home, component))

    const w = sh(G.WRITE_SH, home, REL, '{"reviews":{"pwned":{}}}\n')
    const r = sh(G.READ_SH, home, REL)

    t(`write is refused when ${component} is a symlink`, w.status === 65)
    t(`  the decoy file is untouched (${component})`,
      readFileSync(join(decoy, "omengram.json"), "utf8") === "untouched\n")
    t(`  no temp file is stranded beside the decoy (${component})`,
      readdirSync(decoy).filter((f) => f.startsWith(".omengram.")).length === 0)
    t(`  read is refused too (${component})`, r.status === 65 && r.stdout === "")
  }
}

group("a symlinked file, and a file where a directory belongs")
{
  const home = makeHome()
  const decoy = makeDecoy()

  symlinkSync(join(decoy, "omengram.json"), join(home, REL))
  t("a symlinked target file is refused on read", sh(G.READ_SH, home, REL).status === 65)

  const w = sh(G.WRITE_SH, home, REL, '{"reviews":{}}\n')
  t("but a write replaces the symlink instead of following it", w.status === 0)
  t("the decoy is untouched", readFileSync(join(decoy, "omengram.json"), "utf8") === "untouched\n")
  t("and the destination is now a real file",
    !lstatSync(join(home, REL)).isSymbolicLink())

  const home2 = mkdtempSync(join(tmpdir(), "omengram-file-"))
  mkdirSync(join(home2, ".local"), { recursive: true })
  writeFileSync(join(home2, ".local/state"), "i am not a directory\n")
  t("a regular file where a directory belongs is refused",
    sh(G.WRITE_SH, home2, REL, "{}\n").status === 66)
}

group("paths that walk out of home are refused before any work")
{
  const home = makeHome()
  for (const [label, rel] of [
    ["an absolute path", "/etc/passwd"],
    ["a parent traversal", ".local/../../etc/passwd"],
    ["a bare traversal", "../escape.json"],
    ["an empty path", ""],
  ]) t(`${label} is refused`, sh(G.WRITE_SH, home, rel, "{}\n").status === 64)

  t("containment is decided before the shell runs",
    G.relativeToHome("/etc/passwd", "/home/u") === "")
  t("a contained path is returned relative",
    G.relativeToHome("/home/u/.local/share/omengram/cards.json", "/home/u") === ".local/share/omengram/cards.json")
  t("home itself is not a file", G.relativeToHome("/home/u", "/home/u") === "")
  t("a sibling that merely shares a prefix is refused",
    G.relativeToHome("/home/user2/deck.json", "/home/u") === "")
  t("a traversal inside a contained path is refused",
    G.relativeToHome("/home/u/../etc/passwd", "/home/u") === "")
  t("a trailing slash on home is tolerated",
    G.relativeToHome("/home/u/a.json", "/home/u/") === "a.json")
  t("a relative path is refused", G.relativeToHome("a.json", "/home/u") === "")
}

group("reading, when there is simply nothing there")
{
  const home = mkdtempSync(join(tmpdir(), "omengram-empty-"))
  t("an unwalked chain reads as empty, not as an error",
    (() => { const r = sh(G.READ_SH, home, REL); return r.status === 0 && r.stdout === "" })())

  const home2 = makeHome()
  t("a missing file reads as empty",
    (() => { const r = sh(G.READ_SH, home2, REL); return r.status === 0 && r.stdout === "" })())

  writeFileSync(join(home2, REL), '{"reviews":{}}\n')
  t("a regular file is read", sh(G.READ_SH, home2, REL).stdout.trim() === '{"reviews":{}}')

  writeFileSync(join(home2, REL), "x".repeat(500_000))
  t("an oversized file is truncated, not swallowed whole",
    sh(G.READ_SH, home2, REL).stdout.length === 262_144)

  // The cap the shell applies and the cap the parser recognises are the same
  // number, so a deck cut off by the first is reported as such by the second.
  t("the shell reads exactly as far as READ_LIMIT says",
    sh(G.READ_SH, home2, REL).stdout.length === G.READ_LIMIT)

  // End to end, through the real read rather than a string sliced to look like
  // one: the shell truncating and the parser noticing are two halves of the
  // same fix, and the bug was that they did not know about each other.
  writeFileSync(join(home2, REL), JSON.stringify({ cards: Array.from(
    { length: 12_000 }, (_, i) => ({ front: "q" + i, back: "a" + i })) }))
  t("a real oversized deck comes back reported as too large",
    /too large/i.test(G.parseDeck(sh(G.READ_SH, home2, REL).stdout).error))
}

group("a deck too large to read says so")
{
  // A truncated deck fails to parse, but not for any reason the user can find
  // by looking at their file. Reporting it as a syntax error sends them
  // hunting for a missing brace that is not there.
  const whole = JSON.stringify({ cards: Array.from({ length: 12_000 },
    (_, i) => ({ front: "q" + i, back: "a" + i })) })
  const cut = whole.slice(0, G.READ_LIMIT)

  t("a deck under the cap still parses",
    G.parseDeck(JSON.stringify({ cards: [{ front: "q", back: "a" }] })).cards.length === 1)

  const r = G.parseDeck(cut)
  t("a truncated deck is reported as too large", /too large/i.test(r.error))
  t("a truncated deck is not blamed on the user's JSON", !/valid JSON/i.test(r.error))
  t("a truncated deck yields no cards", r.cards.length === 0)

  // The distinction has to survive genuinely broken input: a short file with a
  // real syntax error is still a syntax error.
  const broken = G.parseDeck('{"cards": [')
  t("a small unparseable deck is still reported as invalid JSON",
    /valid JSON/i.test(broken.error) && !/too large/i.test(broken.error))

  // The cap counts bytes, so a deck of multi-byte text hits it at far fewer
  // characters than an ASCII one. Measuring the string would miss it.
  const wide = "\u6f22".repeat(Math.ceil(G.READ_LIMIT / 3))
  t("a multi-byte deck is measured in bytes, not characters",
    G.hitReadLimit(wide) && wide.length < G.READ_LIMIT)
  t("an ordinary deck is not mistaken for a truncated one",
    !G.hitReadLimit('{"cards":[]}'))

  // Appending is the only path that writes the deck, so it refuses on size
  // before it parses rather than relying on the parse to fail.
  const a = G.appendCard(cut, "new front", "new back")
  t("appending to a truncated deck is refused", /too large/i.test(a.error))
  t("appending to a truncated deck hands the file back untouched", a.raw === cut)
}

group("intervals are spread so cards do not stay clumped")
{
  const base = G.normalizeState({ phase: "review", due: NOW, interval: 100 * DAY, ease: 2500, reps: 5 })
  const ivl = (roll, state = base, g = "good") => G.grade(state, g, NOW, roll).interval / DAY

  // Without a roll nothing moves: previewIntervals relies on it, so the priced
  // labels hold still while the card is on screen.
  const plain = ivl(undefined)
  t("no roll means no spreading", plain === ivl(null))
  t("a preview and an unfuzzed grade agree",
    G.previewIntervals(base, NOW).good === G.formatInterval(G.grade(base, "good", NOW).due - NOW))

  // FSRS's band: 5% beyond 20 days (plus the narrower bands below it).
  const lo = ivl(0), hi = ivl(0.999999)
  t("the low end is a few percent short", lo < plain && lo >= plain * 0.9)
  t("the high end is a few percent long", hi > plain && hi <= plain * 1.1)
  let inside = true
  for (let r = 0; r < 1; r += 0.05) { const v = ivl(r); inside = inside && v >= lo && v <= hi && v % 1 === 0 }
  t("every roll lands inside the band, on a whole day", inside)
  t("a nonsense roll is ignored rather than propagated", ivl("x") === plain)
  t("a roll out of range is clamped to the band", ivl(5) === hi && ivl(-3) === lo)

  // Short intervals and learning steps have nowhere to spread to.
  const fresh = G.newState()
  t("a learning step is not spread", G.grade(fresh, "good", NOW, 0).due === G.grade(fresh, "good", NOW, 0.99).due)
  t("a lapse is not spread", G.grade(base, "again", NOW, 0).due === G.grade(base, "again", NOW, 0.99).due)
  const graduated = (roll) => G.grade(G.grade(fresh, "good", NOW), "good", NOW + 600, roll).interval
  t("graduating at two days is unchanged by any roll", graduated(0) === graduated(0.99))
}

group("the document itself is never interpolated")
{
  const home = makeHome()
  // Cards are user text and end up inside the document; it travels on stdin,
  // so quoting in a card cannot escape into the shell.
  const nasty = JSON.stringify({ reviews: { 'a"; rm -rf /; #': G.newState() } })
  const r = sh(G.WRITE_SH, home, REL, nasty)
  t("a document full of shell metacharacters is written verbatim",
    r.status === 0 && readFileSync(join(home, REL), "utf8") === nasty)
}

group("a card that keeps lapsing becomes a leech")
{
  const st = (over) => Object.assign(G.newState(), over)
  const review = (lapses, extra) => st(Object.assign(
    { phase: "review", interval: 30 * G.DAY, ease: 2500, reps: 40, lapses }, extra || {}))

  // Anki fires at the threshold, then every half-threshold lapses after it, so
  // a leech deliberately kept is raised at 8, 12, 16 rather than every time.
  const fires = [];
  for (let n = 0; n <= 20; n++) if (G.isLeechLapse(n, 8)) fires.push(n)
  t("the default threshold fires at 8 and every 4 after",
    JSON.stringify(fires) === JSON.stringify([8, 12, 16, 20]))

  t("a card under the threshold is not a leech", !G.isLeechLapse(7, 8))
  t("an odd threshold still advances", G.isLeechLapse(3, 3) && G.isLeechLapse(4, 3))
  t("a threshold of 1 fires on every lapse",
    G.isLeechLapse(1, 1) && G.isLeechLapse(2, 1) && G.isLeechLapse(3, 1))
  t("a threshold of 0 turns leeches off entirely",
    !G.isLeechLapse(0, 0) && !G.isLeechLapse(50, 0))
  t("a nonsense threshold falls back to the default",
    G.isLeechLapse(8, undefined) && G.isLeechLapse(8, "x"))

  // The lapse that reaches the threshold is the one that marks it.
  const seventh = G.grade(review(7), "again", 0)
  t("the lapse that reaches the threshold marks the card",
    seventh.lapses === 8 && seventh.leech === true && seventh.suspended === true)

  const sixth = G.grade(review(6), "again", 0)
  t("the lapse before it does not", sixth.lapses === 7 && !sixth.leech && !sixth.suspended)

  // Suspending hides a card; it does not rewrite what the scheduler did.
  t("a suspended card is still scheduled underneath",
    seventh.phase === "relearning" && seventh.due === 10 * G.MINUTE && seventh.stability > 0)

  t("flagging without suspending is possible",
    (() => {
      const r = G.grade(review(7), "again", 0, undefined, { leechSuspend: false })
      return r.leech === true && r.suspended === false
    })())

  t("a threshold of 0 never marks a card",
    (() => {
      const r = G.grade(review(50), "again", 0, undefined, { leechThreshold: 0 })
      return !r.leech && !r.suspended
    })())

  t("a custom threshold is honoured",
    (() => {
      const r = G.grade(review(2), "again", 0, undefined, { leechThreshold: 3 })
      return r.lapses === 3 && r.leech === true
    })())

  // Only a lapse makes one. A passing grade on an already-marked card must not
  // quietly clear the mark, and must not suspend it either.
  for (const g of ["hard", "good", "easy"]) {
    const r = G.grade(review(8, { leech: true }), g, 0)
    t(`${g} keeps the mark and does not suspend`, r.leech === true && r.suspended === false)
  }
  t("a passing grade never creates a leech",
    !G.grade(review(50), "good", 0).leech)

  // The mark is sticky across a restore, so a restored card that keeps lapsing
  // is raised again at the next half-threshold rather than immediately.
  const restoredThenLapsed = G.grade(review(8, { leech: true, suspended: false }), "again", 0)
  t("a restored leech is not re-suspended on the very next lapse",
    restoredThenLapsed.lapses === 9 && restoredThenLapsed.suspended === false)
  t("but it is raised again at the next half-threshold",
    G.grade(review(11, { leech: true, suspended: false }), "again", 0).suspended === true)

  // Undo restores the whole prior state, so it takes the mark back with it.
  const before = review(7)
  t("the state before the lapse carries no mark", !before.leech && !before.suspended)
}

group("a suspended card leaves the rotation")
{
  const cards = [
    { id: "a", front: "a", back: "a", tags: [] },
    { id: "b", front: "b", back: "b", tags: [] },
    { id: "c", front: "c", back: "c", tags: [] },
  ]
  const due = (over) => Object.assign(G.newState(),
    { phase: "review", due: 100, interval: 30 * G.DAY, reps: 5 }, over || {})

  const progress = { reviews: {
    a: due(),
    b: due({ suspended: true }),
    c: due(),
  }}

  const q = G.buildQueue(cards, progress, 1000, 20, 0)
  t("a suspended card is not queued", q.indexOf("b") === -1)
  t("the others still are", q.length === 2 && q.indexOf("a") !== -1 && q.indexOf("c") !== -1)

  const c = G.counts(cards, progress, 1000, 20, 0)
  t("a suspended card is counted on its own", c.suspended === 1)
  t("and not as due", c.due === 2)
  t("and not as waiting", c.waiting === 0)

  // A deck whose remainder is all suspended should read as done, not as
  // waiting on a card that is never coming.
  const allOut = { reviews: { a: due({ suspended: true }), b: due({ suspended: true }), c: due({ suspended: true }) }}
  const c2 = G.counts(cards, allOut, 1000, 20, 0)
  t("a fully suspended deck has nothing pending", c2.pending === 0 && c2.waiting === 0)
  t("and says how many are out", c2.suspended === 3)

  // The forecast must not promise cards that will not be shown.
  const stats = G.deckStats(cards, progress, 1000, 20, 0)
  t("the forecast leaves out suspended cards", stats.forecast[0] === 2)
  t("statistics count the suspended card", stats.suspended === 1)
  t("a suspended card still counts in the composition",
    stats.mature + stats.young + stats.learning + stats.fresh === 3)

  const marked = { reviews: { a: due({ leech: true }), b: due({ leech: true, suspended: true }), c: due() }}
  const s2 = G.deckStats(cards, marked, 1000, 20, 0)
  t("leeches are counted whether suspended or not", s2.leeches === 2 && s2.suspended === 1)
}

group("suspended cards can be put back")
{
  const due = (over) => Object.assign(G.newState(),
    { phase: "review", due: 100, interval: 30 * G.DAY, reps: 5, updated: 500 }, over || {})

  const progress = { reviews: {
    a: due({ leech: true, suspended: true }),
    b: due(),
    c: due({ leech: true, suspended: true }),
  }}

  const r = G.unsuspendAll(progress, 9000)
  t("it says how many came back", r.restored === 2)
  t("nothing is left suspended",
    !r.progress.reviews.a.suspended && !r.progress.reviews.c.suspended)
  t("the leech mark is kept",
    r.progress.reviews.a.leech === true && r.progress.reviews.c.leech === true)

  // Stamped so the change survives the other surface's read-merge-write, but
  // only for the cards it actually changed.
  t("restored cards are stamped",
    r.progress.reviews.a.updated === 9000 && r.progress.reviews.c.updated === 9000)
  t("untouched cards keep their stamp", r.progress.reviews.b.updated === 500)

  t("the original document is not mutated",
    progress.reviews.a.suspended === true)

  t("restoring nothing is not an error",
    (() => {
      const none = G.unsuspendAll({ reviews: { b: due() } }, 9000)
      return none.restored === 0 && none.progress.reviews.b.updated === 500
    })())

  t("an empty document is handled", G.unsuspendAll(null, 9000).restored === 0)

  // The count must not be written to disk as part of the document.
  t("the saved document carries only reviews",
    Object.keys(JSON.parse(G.serializeProgress(r.progress))).join() === "reviews")

  // A restored card is queued again.
  const cards = [{ id: "a", front: "a", back: "a", tags: [] }]
  t("a restored card returns to the queue",
    G.buildQueue(cards, r.progress, 1000, 20, 0).indexOf("a") !== -1)
}

group("the leech fields survive a round trip")
{
  const s = Object.assign(G.newState(), { phase: "review", leech: true, suspended: true })
  const back = G.parseProgress(G.serializeProgress({ reviews: { a: s } })).reviews.a
  t("leech survives being written and read", back.leech === true)
  t("suspended survives being written and read", back.suspended === true)

  // Both come off disk, where anything could have written them.
  const loose = G.normalizeState({ phase: "review", leech: "yes", suspended: 1 })
  t("only a literal true suspends", loose.suspended === false)
  t("only a literal true marks a leech", loose.leech === false)
  t("a new card carries neither",
    G.newState().leech === false && G.newState().suspended === false)

  // Merging keeps whichever entry is newer, including its suspension.
  const mine = { reviews: { a: Object.assign(G.newState(), { updated: 10, suspended: true }) } }
  const theirs = { reviews: { a: Object.assign(G.newState(), { updated: 20, suspended: false }) } }
  t("a newer restore wins over an older suspension",
    G.mergeProgress(mine, theirs).reviews.a.suspended === false)
  t("a newer suspension wins over an older restore",
    G.mergeProgress(theirs, mine).reviews.a.suspended === false ||
    G.mergeProgress({ reviews: { a: Object.assign(G.newState(), { updated: 30, suspended: true }) } }, theirs)
      .reviews.a.suspended === true)
}

group("answering late credits the wait")
{
  // Recalling a card long after it was due is evidence it is held for longer
  // than it was scheduled for; FSRS's stability grows more for it.
  const late = (days) => G.normalizeState({ phase: "review", interval: 10 * DAY, ease: 2500, reps: 5,
                                             due: NOW - days * DAY })
  const d = (days, g = "good") => G.grade(late(days), g, NOW).interval / DAY
  t("a late good earns a longer gap than an on-time one", d(20) > d(0))
  t("and the later, the longer", d(60) > d(20))
  t("a late easy too", d(20, "easy") > d(0, "easy"))
  t("answering early earns less", G.grade(late(-5), "good", NOW).interval < G.grade(late(0), "good", NOW).interval)
}

group("the three passing grades stay in order")
{
  let ordered = true
  for (const ivl of [1, 3, 10, 40, 200]) for (const ease of [1300, 2500, 3000]) for (const lateBy of [0, 5, 30]) {
    const s = G.normalizeState({ phase: "review", interval: ivl * DAY, ease, reps: 5, due: NOW - lateBy * DAY })
    const [h, g, e] = ["hard", "good", "easy"].map((x) => G.grade(s, x, NOW).interval)
    ordered = ordered && h <= g && g <= e
  }
  t("hard ≤ good ≤ easy for every card", ordered)
}


// ------------------------------------------------------------- review log

group("an answer as the log keeps it")
{
  const card = { id: "c1", deck: "drills/py", kind: "code" }
  const before = G.normalizeState({ phase: "review", due: NOW, interval: 10 * DAY, ease: 2500, reps: 3 })
  const after = G.grade(before, "good", NOW)
  const r = G.logRecord({ card, before, after, grade: "good", now: NOW, ms: 4200.6, mode: "free",
                          tests: { pass: 3, total: 4 }, salt: 0.5 })
  t("versioned, with an id", r.v === 1 && /^\d+-\d+$/.test(r.rid))
  t("names the card, its deck and kind", r.card === "c1" && r.deck === "drills/py" && r.kind === "code")
  t("the grade is 1-4", r.rating === 3)
  t("the phase before the answer", r.sb === "review")
  t("days since the last answer", r.elapsed === 10)
  t("days scheduled", r.sched === after.interval / DAY)
  t("memory after, rounded", r.s === Math.round(after.stability * 1000) / 1000 && r.d > 0)
  t("time on the card, whole ms", r.ms === 4201)
  t("how it was answered", r.mode === "free" && r.revealed === false && r.recall === false)
  t("the tests that ran", r.tests.pass === 3 && r.tests.total === 4)
  t("a new card has no elapsed days", G.logRecord({ card, before: G.newState(), after, grade: "good", now: NOW }).elapsed === -1)
  t("an unknown mode is a plain card", G.logRecord({ card, before, after, grade: "good", now: NOW, mode: "x" }).mode === "card")
  t("a basic card says so", G.logRecord({ card: { id: "x" }, before, after, grade: "again", now: NOW }).kind === "basic")
  const line = G.serializeRecord(r)
  t("one line each", line.endsWith("\n") && line.indexOf("\n") === line.length - 1)
  t("a record too big for one append is refused",
    G.serializeRecord({ ...r, card: "x".repeat(G.LOG_RECORD_LIMIT) }) === "")
}

group("reading the log back")
{
  const rec = (rid, at, rating = 3, sb = "review", card = "c1", mode = "card") =>
    JSON.stringify({ v: 1, rid, card, at, rating, sb, mode })
  const raw = [
    "#omengram-log reviews-2026-11.jsonl 0",
    rec("b", NOW + 20), rec("a", NOW + 10),
    "not json", JSON.stringify({ v: 2, rid: "z", card: "c", at: NOW, rating: 3 }),
    JSON.stringify({ v: 1, rid: "q", card: "c", at: NOW, rating: 9 }),
    JSON.stringify({ v: 1, op: "undo", rid: "b", at: NOW + 30 }),
    "",
    "#omengram-log reviews-2026-10.jsonl 512",
    '{"v":1,"rid":"cut","card":"c1","at":1,"ra',
    rec("c", NOW - 5),
  ].join("\n")
  const log = G.parseLog(raw)
  t("answers come back oldest first", log.map((r) => r.rid).join() === "c,a")
  t("an undone answer is left out", !log.some((r) => r.rid === "b"))
  t("lines that are not v1 records are skipped", !log.some((r) => r.rid === "z" || r.rid === "q"))
  t("the partial line a tail cut leaves is dropped", !log.some((r) => r.rid === "cut"))
  t("nothing at all is no answers", G.parseLog("").length === 0 && G.parseLog(null).length === 0)

  t("this month's file, by study day", G.logName(NOW) === "reviews-" + G.dayKey(NOW).slice(0, 7) + ".jsonl")
  const jan = new Date(2026, 0, 10, 12).getTime() / 1000
  t("a read takes this month and the last, across a year", G.logNames(jan).join() === "reviews-2026-01.jsonl,reviews-2025-12.jsonl")
}

group("retention from the log")
{
  const r = (rid, at, rating, sb = "review", card = "c1", mode = "card") => ({ v: 1, rid, card, at, rating, sb, mode })
  const log = [
    r("1", NOW - 40 * DAY, 1),           // too old
    r("2", NOW - 10 * DAY, 3), r("3", NOW - 9 * DAY, 1), r("4", NOW - 8 * DAY, 4, "review", "c1", "free"),
    r("5", NOW - DAY, 1, "learning"),    // a learning step, not a review
    r("6", NOW - DAY, 3, "review", "other"),
  ]
  const all = G.logRetention(log, NOW)
  t("reviews over the last 30 days", all.reviews === 4 && all.passed === 3 && all.retention === 0.75)
  t("learning steps and old answers are not counted", all.days === 30)
  t("limited to the cards asked about", G.logRetention(log, NOW, { c1: true }).reviews === 3)
  t("split by how the card was answered", all.byMode.free.reviews === 1 && all.byMode.card.reviews === 3)

  const cards = G.parseDeck(JSON.stringify([{ front: "q", back: "a" }])).cards
  const id = cards[0].id
  const s = G.deckStats(cards, { reviews: {} }, NOW, 20, 0, log.map((x) => ({ ...x, card: id })))
  t("deck statistics take it from the log", s.fromLog && s.retentionReviews === 4 && s.retention === 0.75)
  const m = G.mergeStats(s, null)
  t("and say it is a monthly figure", G.retentionText(m) === "75% passed, last 30 days")
  const none = G.mergeStats(G.deckStats(cards, { reviews: {} }, NOW, 20, 0, []), null)
  t("no reviews yet says so", G.retentionText(none) === "no reviews in the last 30 days")
  const both = G.mergeStats(s, { total: 5, retention: 1, retentionReviews: 4, retentionDays: 30 })
  t("with Anki's, weighted by reviews", both.retention === 0.875 && both.retentionLabel === "passed, last 30 days")
}

group("appending to the log")
{
  const home = mkdtempSync(join(tmpdir(), "omengram-log-"))
  const LOG = ".local/state/omarchy/omengram/reviews-2026-11.jsonl"
  const a = sh(G.APPEND_SH, home, LOG, '{"v":1,"n":1}\n')
  const b = sh(G.APPEND_SH, home, LOG, '{"v":1,"n":2}\n')
  t("an append into an empty home succeeds", a.status === 0 && b.status === 0)
  t("lines are added, not replaced", readFileSync(join(home, LOG), "utf8") === '{"v":1,"n":1}\n{"v":1,"n":2}\n')
  t("the file is private", (statSync(join(home, LOG)).mode & 0o777) === 0o600)
  t("its directory too", (statSync(join(home, ".local/state/omarchy/omengram")).mode & 0o777) === 0o700)

  // Two surfaces answering at once: every line arrives whole.
  const line = (i) => JSON.stringify({ v: 1, i, pad: "x".repeat(3000) }) + "\n"
  const procs = Array.from({ length: 24 }, (_, i) =>
    new Promise((res) => {
      const p = spawn("sh", ["-c", G.APPEND_SH, "omengram", home, LOG])
      p.on("exit", res); p.stdin.end(line(i))
    }))
  await Promise.all(procs)
  const lines = readFileSync(join(home, LOG), "utf8").trim().split("\n")
  t("appends running at once do not interleave",
    lines.length === 26 && lines.every((l) => { try { JSON.parse(l); return true } catch { return false } }))

  const decoy = makeDecoy()
  const LINKED = ".local/state/omarchy/omengram/reviews-2026-10.jsonl"
  symlinkSync(join(decoy, "omengram.json"), join(home, LINKED))
  t("a symlinked log file is refused", sh(G.APPEND_SH, home, LINKED, "{}\n").status === 65)
  t("  and its target untouched", readFileSync(join(decoy, "omengram.json"), "utf8") === "untouched\n")

  const home2 = makeHome()
  rmSync(join(home2, ".local/state"), { recursive: true, force: true })
  symlinkSync(decoy, join(home2, ".local/state"))
  t("a symlink on the way is refused", sh(G.APPEND_SH, home2, ".local/state/omarchy/omengram/r.jsonl", "{}\n").status === 65)
}

group("reading the end of the log")
{
  const home = mkdtempSync(join(tmpdir(), "omengram-logtail-"))
  const dir = ".local/state/omarchy/omengram"
  const tail = (...names) => spawnSync("sh", ["-c", G.LOGTAIL_SH, "omengram", home, dir + "/" + names[0], ...names.slice(1)],
                                       { encoding: "utf8" })
  t("no log yet is nothing, quietly", tail("reviews-2026-11.jsonl").status === 0 && tail("reviews-2026-11.jsonl").stdout === "")
  mkdirSync(join(home, dir), { recursive: true })
  writeFileSync(join(home, dir, "reviews-2026-11.jsonl"), '{"v":1,"a":1}\n')
  writeFileSync(join(home, dir, "reviews-2026-10.jsonl"), '{"v":1,"b":1}\n')
  const r = tail("reviews-2026-11.jsonl", "reviews-2026-10.jsonl", "../escape", "missing.jsonl")
  t("both months, each after its header",
    r.stdout === '#omengram-log reviews-2026-11.jsonl 0\n{"v":1,"a":1}\n\n#omengram-log reviews-2026-10.jsonl 0\n{"v":1,"b":1}\n\n')

  const big = Array.from({ length: 20000 }, (_, i) => JSON.stringify({ v: 1, rid: "r" + i, card: "c", at: i + 1, rating: 3, sb: "review" })).join("\n") + "\n"
  writeFileSync(join(home, dir, "reviews-2026-09.jsonl"), big)
  const cut = tail("reviews-2026-09.jsonl")
  const skipped = Buffer.byteLength(big) - G.LOG_READ_LIMIT
  t("a long file is read from its end", cut.stdout.startsWith("#omengram-log reviews-2026-09.jsonl " + skipped + "\n"))
  const parsed = G.parseLog(cut.stdout)
  t("  and parses whole, the cut line dropped",
    parsed.length > 1000 && parsed[parsed.length - 1].rid === "r19999" && parsed.every((x) => x.rating === 3))

  symlinkSync(join(home, dir, "reviews-2026-10.jsonl"), join(home, dir, "reviews-2026-08.jsonl"))
  t("a symlinked month is skipped", tail("reviews-2026-08.jsonl").stdout === "")
}

// ---------------------------------------------------------------- library
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const deckOf = (id, ...fronts) => ({
  id, cards: G.assignDeck(G.parseDeck(JSON.stringify(
    fronts.map((f) => typeof f === "string" ? { front: f, back: "b" } : { back: "b", ...f }))).cards, id)
})

group("the library listing")
{
  const l = G.parseListing([
    "1.5\t10\tzeta.json", "2\t11\tinfra/backend.json", "3\t12\tinfra.json", "4\t13\tinfra extra.json",
    "5\t14\tgleamdrill:NeetCode.json", "6\t15\tnotes.txt", "garbage", "7\t16\t/x.json", "",
  ].join("\n"))
  t("ids are paths without the extension, children after their parent",
    eq(l.map((x) => x.id), ["infra", "infra/backend", "infra extra", "zeta"]))
  t("the stamp covers both time and size", l[0].stamp === "3:12")
  t("a reserved id is not a library deck", !l.some((x) => x.id.startsWith("gleamdrill:")))
  t("an empty listing is no decks", eq(G.parseListing(""), []))
  t("the library defaults and expands ~",
    G.resolveDeckDir("", "/h") === "/h/.local/share/omengram" &&
    G.resolveDeckDir("~/d/", "/h") === "/h/d" && G.resolveDeckDir("/x", "/h") === "/x")
}

group("the library is listed without following anything")
{
  const home = makeHome()
  const LIB = ".local/share/omengram"
  t("an absent library lists as nothing",
    (() => { const r = sh(G.LIST_SH, home, LIB); return r.status === 0 && r.stdout === "" })())
  mkdirSync(join(home, LIB, "infra/[a] *deep"), { recursive: true })
  mkdirSync(join(home, LIB, ".hidden"))
  for (const f of ["cards.json", "infra/backend.json", "infra/[a] *deep/x y.json", ".omengram.abc.json",
                   ".hidden/h.json", "readme.md", "bad\nname.json"])
    writeFileSync(join(home, LIB, f), "{}")
  const decoy = makeDecoy()
  writeFileSync(join(decoy, "secret.json"), "{}")
  symlinkSync(join(decoy, "secret.json"), join(home, LIB, "link.json"))
  symlinkSync(decoy, join(home, LIB, "linkdir"))

  const ids = G.parseListing(sh(G.LIST_SH, home, LIB).stdout).map((x) => x.id)
  t("real decks at any depth are listed, odd names included",
    eq(ids, ["cards", "infra/[a] *deep/x y", "infra/backend"]))
  t("a listed deck with glob characters in its path can be read",
    sh(G.READ_SH, home, LIB + "/infra/[a] *deep/x y.json").stdout === "{}")

  for (const link of [".local", ".local/share", LIB]) {
    const h = mkdtempSync(join(tmpdir(), "omengram-home-"))
    mkdirSync(join(h, dirname(link)), { recursive: true })
    symlinkSync(decoy, join(h, link))
    t(`a symlink at ${link} is refused`, sh(G.LIST_SH, h, LIB).status === 65)
  }
  for (const rel of ["", "/etc", "../x", "a/../../x"])
    t(`listing ${JSON.stringify(rel)} is refused`, sh(G.LIST_SH, home, rel).status === 64)
}

group("the deck tree")
{
  const decks = [deckOf("infra", "own"), deckOf("infra/a", "1", "2"), deckOf("x/y/z", "3")]
  const rows = G.deckRows(decks, G.emptyProgress(), NOW)
  t("implied parents get rows, in order",
    eq(rows.map((r) => [r.id, r.depth, r.own]),
       [["infra", 0, true], ["infra/a", 1, true], ["x", 0, false], ["x/y", 1, false], ["x/y/z", 2, true]]))
  t("a parent counts its children", rows[0].total === 3 && rows[0].fresh === 3 && rows[2].fresh === 1)
  const p = { reviews: { [decks[1].cards[0].id]: { ...G.newState(), phase: "review", due: NOW - 1 } } }
  t("due and new are told apart", eq([G.deckRows(decks, p, NOW)[0]].map((r) => [r.due, r.fresh]), [[1, 2]]))
}

group("picking decks")
{
  const rows = G.buildDeckTree([{ id: "infra" }, { id: "infra/a" }, { id: "infra/b" }, { id: "infra/b/c" }, { id: "z" }])
  const tog = (sel, id) => G.toggleDeck(rows, sel, id)
  t("nothing picked is everything", G.deckMatches("anything", []))
  t("a parent includes its children", G.deckMatches("infra/b/c", ["infra"]))
  t("but not a deck that only shares a prefix", !G.deckMatches("infragood", ["infra"]))
  t("ticking from nothing picks just that", eq(tog([], "z"), ["z"]))
  t("unticking the last goes back to everything", eq(tog(["z"], "z"), []))
  t("ticking a parent replaces its children", eq(tog(["infra/a", "z"], "infra"), ["z", "infra"]))

  const split = tog(["infra"], "infra/a")
  t("unticking a child keeps the rest of the parent",
    G.deckMatches("infra", split) && G.deckMatches("infra/b", split) &&
    G.deckMatches("infra/b/c", split) && !G.deckMatches("infra/a", split))
  t("the parent then shows as partly picked", G.nodeState("infra", split, "/") === "some")
  t("ticking the child again folds the parent back", eq(tog(split, "infra/a"), ["infra"]))

  const deep = tog(["infra"], "infra/b/c")
  t("unticking a grandchild keeps every other level",
    ["infra", "infra/a", "infra/b"].every((d) => G.deckMatches(d, deep)) && !G.deckMatches("infra/b/c", deep))
  t("and folds all the way back up", eq(tog(deep, "infra/b/c"), ["infra"]))
  t("ticking a partly picked parent takes all of it", eq(tog(split, "infra"), ["infra"]))
  t("a deck that is gone is dropped", eq(tog(["gone", "z"], "infra/a"), ["z", "infra/a"]))
  t("every row toggled twice from any one selection is where it started", rows.every((r) =>
    [[], ["infra"], ["z"], ["infra/a"]].every((sel) => {
      const members = (x) => rows.map((q) => x.length > 0 && G.deckMatches(q.id, x))
      return G.nodeState(r.id, sel, "/") === "some" || eq(members(tog(tog(sel, r.id), r.id)), members(sel))
    })))
  const qmlList = { 0: "a", 1: "b", length: 2 }
  t("a list QML does not call an array is still a list",
    eq(G.normalizeDecks(qmlList), ["a", "b"]) && eq(G.normalizeTags(qmlList), ["a", "b"]))
  t("selections are cleaned on the way in", eq(G.normalizeDecks([" a ", "a", "", null]), ["a"]))
}

group("cards in scope")
{
  const decks = [deckOf("a", { front: "shared" }, "one"), deckOf("b", { front: "shared" }, "two")]
  t("a card in two decks is shown once", G.mergeDecks(decks, []).length === 3)
  t("and is found from either deck", G.mergeDecks(decks, ["b"]).map((c) => c.front).join() === "shared,two")
  t("cards know their deck", G.mergeDecks(decks, ["b"])[0].deck === "b")
  t("nothing matching is no cards", eq(G.mergeDecks(decks, ["gone"]), []))
}

group("tags nest")
{
  const cards = deckOf("d",
    { front: "1", tags: ["sd::caching"] }, { front: "2", tags: ["SD::messaging", "sd::caching"] },
    { front: "3", tags: ["sdx"] }, { front: "4" }).cards
  const fronts = (tags) => G.filterByTags(cards, tags).map((c) => c.front).join("")
  t("a parent tag takes its children", fronts(["sd"]) === "12")
  t("a child tag takes only itself", fronts(["sd::messaging"]) === "2")
  t("rows count cards, not tags", eq(G.tagRows(cards).map((r) => [r.id, r.total]),
    [["sd", 2], ["sd::caching", 2], ["sd::messaging", 1], ["sdx", 1]]))
  t("a picked tag no card here carries keeps its row", eq(
    G.tagRows(cards, ["other", "sd::."]).map((r) => [r.id, r.total]).slice(0, 2), [["other", 0], ["sd", 2]]))
  t("tags toggle like decks", eq(G.toggleTag(G.tagRows(cards), ["sd"], "sd::caching"), ["sd::messaging"]))
}

group("a limit per deck")
{
  const decks = [deckOf("p/a", "a1", "a2", "a3"), deckOf("p/b", "b1", "b2", "b3"), deckOf("q", "q1", "q2")]
  const cards = G.mergeDecks(decks, [])
  const q = (limits, progress = G.emptyProgress(), newPer = 20, rev = 0, from = cards) =>
    G.buildQueue(from, progress, NOW, newPer, rev, { limits, library: cards })
     .map((id) => cards.find((c) => c.id === id).front)
  const id = (f) => cards.find((c) => c.front === f).id

  t("no limits changes nothing", q({}).length === 8)
  t("a deck's cap holds only that deck", eq(q({ "p/a": { new: 1 } }), ["a1", "b1", "b2", "b3", "q1", "q2"]))
  t("a parent's cap covers its children together", eq(q({ p: { new: 4 } }), ["a1", "a2", "a3", "b1", "q1", "q2"]))
  t("a card has to fit under every cap above it",
    eq(q({ p: { new: 4 }, "p/a": { new: 1 } }), ["a1", "b1", "b2", "b3", "q1", "q2"]))
  t("the overall cap still holds", q({ "p/a": { new: 1 } }, undefined, 3).length === 3)
  t("a deck's zero is none", eq(q({ p: { new: 0 } }), ["q1", "q2"]))

  const seen = { reviews: { [id("a1")]: { ...G.newState(), phase: "review", due: NOW + G.DAY,
                                          firstDay: G.dayKey(NOW), updated: NOW } } }
  t("what was introduced today is spent", eq(q({ "p/a": { new: 2 } }, seen).filter((f) => f[0] === "a"), ["a2"]))
  t("and stays spent when the selection changes since",
    eq(q({ p: { new: 1 } }, seen, 20, 0, G.mergeDecks(decks, ["p/b"])), []))

  const due = (f, over, phase = "review") => ({ [id(f)]: { ...G.newState(), phase, due: NOW - over, firstDay: "2020-01-01" } })
  const p2 = { reviews: { ...due("a1", 10), ...due("a2", 30), ...due("a3", 20), ...due("q1", 5) } }
  const dueOnly = (limits, pr = p2, rev = 0) => q(limits, pr, 0, rev)
  t("a review cap keeps the most overdue", eq(dueOnly({ "p/a": { reviews: 2 } }), ["a2", "a3", "q1"]))
  t("a held card leaves its overall place to another", eq(dueOnly({ "p/a": { reviews: 1 } }, p2, 2), ["a2", "q1"]))
  t("a card still in learning is not held by a deck's review cap",
    eq(dueOnly({ p: { reviews: 0 } }, { reviews: { ...due("a1", 1, "learning"), ...due("a2", 1) } }), ["a1"]))

  // The badge and the queue come from one place; check they say the same.
  for (const limits of [{}, { p: { new: 2, reviews: 1 } }, { "p/a": { reviews: 0 }, q: { new: 0 } }]) {
    const c = G.counts(cards, p2, NOW, 3, 3, { limits, library: cards })
    t("the count is the queue's length under " + JSON.stringify(limits),
      c.pending === G.buildQueue(cards, p2, NOW, 3, 3, { limits, library: cards }).length && c.due + c.held === 4)
  }
}

group("limits as typed")
{
  t("only sane values survive", eq(G.normalizeLimits(
    { a: { new: "5", reviews: -1 }, b: { new: null }, c: 4, " d ": { reviews: 2.4 }, e: { new: "x" } }),
    { a: { new: 5 }, d: { reviews: 2 } }))
  t("a list or nothing is no limits", eq(G.normalizeLimits([1]), {}) && eq(G.normalizeLimits(undefined), {}))
  t("setting one leaves the other", eq(G.withLimit({ a: { new: 5 } }, "a", "reviews", 9), { a: { new: 5, reviews: 9 } }))
  t("clearing the last drops the deck", eq(G.withLimit({ a: { new: 5 } }, "a", "new", null), {}))
  t("stepping up from no cap starts at a step", G.stepLimit(null, 1, 5) === 5)
  t("stepping lands on multiples", G.stepLimit(7, 1, 5) === 10 && G.stepLimit(7, -1, 5) === 5)
  t("down goes to zero, then to no cap", G.stepLimit(3, -1, 5) === 0 && G.stepLimit(0, -1, 5) === null &&
    G.stepLimit(null, -1, 5) === null)
}

group("saying what is being studied")
{
  const st = { phase: "new" }
  t("nothing picked says nothing", G.scopeLabel([], []) === "")
  t("one deck is named by its last part", G.scopeLabel(["infra/backend"], []) === "backend")
  t("an own-only entry is named by its deck", G.scopeLabel(["infra/."], []) === "infra")
  t("more are counted", G.scopeLabel(["a", "b"], ["x"]) === "2 decks  ·  #x")
  t("many tags are counted", G.scopeLabel([], ["a", "b", "c", "d"]) === "4 tags")
  t("the header carries it", G.sectionLabel("reviewing", st, ["sd"], ["infra"]) === "NEW  ·  infra  ·  #sd")
}

group("where a new card goes")
{
  const decks = [deckOf("a", "1"), deckOf("f/b", "2")]
  t("the deck on screen first", G.addTarget("x", decks, ["a"]) === "x")
  t("then the first picked, through a parent", G.addTarget("", decks, ["f"]) === "f/b")
  t("else the default file", G.addTarget("", decks, []) === "cards" && G.addTarget("", [], ["gone"]) === "cards")
}

group("settings are found wherever the widget sits")
for (const s of ["left", "centerBegin", "center", "centerEnd", "right", "tray"])
  t("in " + s, G.findEntry({ bar: { layout: { [s]: [{ id: "p", tags: ["x"] }] } } }, "p").tags?.[0] === "x")

group("Anki decks in the picker")
{
  const rows = G.ankiDeckRows([
    { id: "anki:/Spanish", name: "Spanish", total: 7, due: 2, fresh: 5 },
    { id: "anki:/Spanish/Verbs", name: "Spanish::Verbs", total: 3, due: 1, fresh: 2 },
    { id: "anki:/Python", name: "Python", total: 2, due: 0, fresh: 2 },
  ])
  t("a root row for the whole collection comes first", rows[0].id === "anki:" && rows[0].name === "Anki" && !rows[0].own)
  t("the root sums the top decks only", rows[0].total === 9 && rows[0].due === 2 && rows[0].fresh === 7)
  t("subdecks sit under their parent", rows.find((r) => r.id === "anki:/Spanish/Verbs").parent === "anki:/Spanish")
  t("nothing from Anki is no rows", G.ankiDeckRows([]).length === 0)
  t("ids", G.isAnkiDeck("anki:") && G.isAnkiDeck("anki:/a") && !G.isAnkiDeck("anki") && !G.isAnkiDeck("ankix/a"))
  t("cards", G.isAnkiCard("anki-cid:12") && !G.isAnkiCard("anki:guid:0"))

  const all = rows.concat(G.deckRows([deckOf("infra", "1")], G.emptyProgress(), NOW))
  t("ticking an Anki subdeck", JSON.stringify(G.toggleDeck(all, [], "anki:/Spanish/Verbs")) === '["anki:/Spanish/Verbs"]')
  t("ticking every top deck folds into the root",
    JSON.stringify(G.toggleDeck(all, ["anki:/Spanish"], "anki:/Python")) === '["anki:"]')
  const libOnly = G.deckRows([deckOf("infra", "1"), deckOf("go", "2")], G.emptyProgress(), NOW)
  t("Anki picks survive while Anki is away",
    JSON.stringify(G.toggleDeck(libOnly, ["anki:/Spanish", "infra"], "go")) === '["anki:/Spanish","infra","go"]')
  t("the root is named in the header", G.scopeLabel(["anki:"], []) === "Anki")
  t("a library file may not claim the Anki prefix",
    G.parseListing("1\t2\tanki:/x.json\n1\t2\tok.json").map((f) => f.id).join() === "ok")
  t("a card is never added to an Anki deck", G.addTarget("anki:/Spanish", [deckOf("a", "1")], []) === "cards")

  const tags = G.tagRows([{ id: "1", tags: ["code"] }], ["gone"], { "grammar": 5, "grammar::verbs": 3, "code": 1 })
  const tag = (id) => tags.find((r) => r.id === id)
  t("Anki's tag counts join the library's", tag("code").total === 2 && tag("grammar").total === 5)
  t("and nest", tag("grammar::verbs").parent === "grammar")
  t("a picked tag keeps its row", tag("gone").total === 0)
}

group("one session from two sources")
{
  const ankiNew = { id: "anki-cid:1", state: { phase: "new" } }
  const ankiDue = { id: "anki-cid:2", state: { phase: "review" } }
  const card = { id: "x" }
  const fresh = G.newState()
  const due = Object.assign(G.newState(), { phase: "review" })
  t("Anki's due card first", G.pickSource(ankiDue, card, due) === "anki")
  t("then the library's due card", G.pickSource(ankiNew, card, due) === "json")
  t("then Anki's new card", G.pickSource(ankiNew, card, fresh) === "anki")
  t("then the library's", G.pickSource(null, card, fresh) === "json")
  t("nothing", G.pickSource(null, null, null) === "")

  const st = G.ankiState({ state: { phase: "relearning", interval: 86400, ease: 2300, lapses: 2, reps: 9 } })
  t("Anki's state reads like ours", st.phase === "relearning" && st.lapses === 2 && st.ease === 2300)
  t("in the header", G.sectionLabel("reviewing", st, [], []).indexOf("RELEARNING  ·  2 lapses") === 0)

  const c = G.mergeCounts({ total: 3, due: 1, fresh: 2, learning: 0, waiting: 1, nextDue: NOW + 50, held: 4 },
                          { total: 10, due: 2, fresh: 5, learning: 1, waiting: 1, nextDue: NOW + 20 })
  t("counts add up", c.total === 13 && c.due === 3 && c.fresh === 7 && c.pending === 10 && c.held === 4)
  t("the sooner learning card wins", c.nextDue === NOW + 20 && c.waiting === 2)
  t("Anki missing", G.mergeCounts({ due: 1, fresh: 1 }, null).pending === 2)

  const s = G.mergeStats(
    { total: 4, fresh: 1, reps: 10, easeSum: 5000, easeCount: 2, retention: 0.5, forecast: [1, 0, 0, 0, 0, 0, 0], freshLeft: 3 },
    { total: 6, fresh: 2, reps: 30, easeSum: 2500, easeCount: 1, retention: 0.9, retentionReviews: 30,
      retentionDays: 30, forecast: [2, 1, 0, 0, 0, 0, 0] })
  t("totals add", s.total === 10 && s.fresh === 3 && s.forecast[0] === 3 && s.forecast[1] === 1)
  t("ease from the sums", Math.abs(s.ease - 2.5) < 1e-9)
  t("retention weighted by what it measured", Math.abs(s.retention - 0.8) < 1e-9 && s.retentionLabel === "retained")
  t("Anki alone says what it measured",
    G.mergeStats({ total: 0 }, { total: 2, retention: 1, retentionReviews: 4, retentionDays: 30 }).retentionLabel
      === "passed, last 30 days")
  t("library alone is unchanged", G.mergeStats({ total: 1, reps: 2, retention: 0.5 }, null).retentionLabel === "never relearned")

  const stack = [{ source: "anki", id: "anki-cid:1" }, { id: "x", had: true }, { source: "json", id: "y" }]
  t("a sync drops only Anki's undo", G.dropAnkiUndo(stack).map((e) => e.id).join() === "x,y")
}

group("the sync line")
{
  const at = NOW - 3 * 60
  t("never", G.syncLine({}, NOW, false).text === "Not synced yet")
  t("running", G.syncLine({ status: "ok" }, NOW, true).text === "Syncing with AnkiWeb…")
  t("ok", G.syncLine({ status: "ok", lastSuccess: at, pulled: 4 }, NOW, false).text
    === "Synced 3 min ago  ·  4 reviews from AnkiWeb")
  t("one review", G.syncLine({ status: "ok", lastSuccess: at, pulled: 1, pushed: 2 }, NOW, false).text
    === "Synced 3 min ago  ·  1 review from AnkiWeb  ·  2 sent")
  const off = G.syncLine({ status: "network", lastSuccess: NOW - 2 * 3600 }, NOW, false)
  t("offline is not the reader's to fix", off.text === "Offline  ·  last synced 2 h ago" && !off.urgent)
  const out = G.syncLine({ status: "signedOut", message: "Not signed in to AnkiWeb — sync once from Anki" }, NOW, false)
  t("signed out is", out.urgent && out.text.indexOf("Not signed in") === 0)
  t("a one-way sync is", G.syncLine({ status: "fullSyncRequired", message: "m" }, NOW, false).urgent)
  t("ago", G.ago(30) === "just now" && G.ago(DAY + 5) === "yesterday" && G.ago(3 * DAY) === "3 days ago")
  t("a broken status file is no status", JSON.stringify(G.parseSyncStatus("{oops")) === "{}"
    && JSON.stringify(G.parseSyncStatus("[1]")) === "{}")
}

// This is a fork installed beside the plugin it came from. Anything that still
// answers to that plugin's name shares its decks, its progress or its IPC, and
// merging from it is how one gets back in.
group("nothing answers to the plugin this was forked from")
{
  const root = join(dirname(fileURLToPath(import.meta.url)), "..")
  const shipped = ["manifest.json", ...readdirSync(root).filter((f) => /\.(qml|js)$/.test(f)),
    ...["tools", "bridge", "anki-addon", "bin", "skills/apkg-to-omengram"].flatMap((d) =>
      readdirSync(join(root, d)).filter((f) => /\.(py|md)$|^[a-z-]+$/.test(f)).map((f) => d + "/" + f))]
  t("there are files to check", shipped.length > 10)
  for (const f of shipped)
    t(f, !/omanki|yamz8/i.test(readFileSync(join(root, f), "utf8")))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
