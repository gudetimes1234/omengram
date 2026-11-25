// Scheduling and deck logic for omanki. Kept free of QML types so the
// algorithm is readable on its own and testable under plain node, leaving the
// .qml files as presentation only.

var MINUTE = 60
var HOUR = 3600
var DAY = 86400

// The study day rolls over at 4am rather than midnight, the way Anki's does:
// a card answered at 1am belongs to the day you are still awake in, not the
// one the clock just started.
var ROLLOVER_HOUR = 4

// A new card is shown again after a minute, then after ten, then it graduates.
// Short enough that both steps land inside one sitting.
var LEARNING_STEPS = [1 * MINUTE, 10 * MINUTE]
var RELEARNING_STEPS = [10 * MINUTE]

var GRADUATING_INTERVAL = 1 * DAY
var EASY_INTERVAL = 4 * DAY

// Ease is carried in permille so the arithmetic stays in integers; 2500 is
// SM-2's starting factor of 2.5.
var STARTING_EASE = 2500
var MIN_EASE = 1300
var MAX_EASE = 3000

var HARD_MULTIPLIER = 1.2
var EASY_BONUS = 1.3
// How much of a lapsed card's interval survives the lapse, as a percentage.
//
// Anki calls this "New interval" and defaults it to 0%, which sends a forgotten
// card back to the minimum interval - a day - however long it had been holding.
// That is a real position: the card was forgotten, so the spacing that produced
// the forgetting has been disproved.
//
// This defaults to 50% instead, which is a common choice among Anki users for
// the opposite reason: one slip on a card held for months is weak evidence
// against months of successful recall, and starting over throws away the rest.
//
// Neither is obviously right, which is exactly why Anki makes it a setting
// rather than a constant, and why this does too. A percentage rather than a
// fraction because that is the way Anki words it and because it keeps the
// setting an integer.
var LAPSE_PERCENT = 50

var MIN_REVIEW_INTERVAL = 1 * DAY
var MAX_INTERVAL = 36500 * DAY

var GRADES = ["again", "hard", "good", "easy"]

// A card that keeps lapsing is a leech. Past some number of forgettings the
// card itself is the problem - the question is ambiguous, or it is really two
// facts wearing one front - and grinding it every few days costs more than it
// returns. Anki's threshold is eight lapses, and it acts again every
// half-threshold lapses after that rather than on every one, so a card you
// have chosen to keep does not nag on every slip.
var LEECH_THRESHOLD = 8

// Anki tags the note "leech" as well as suspending it. This plugin cannot: the
// deck is the user's own file, only ever written through the `a` composer, and
// writing a tag into it on a lapse would break that promise for a card the
// user never touched. The mark lives in the progress file, which is ours.
var LEECH_SUSPEND = true

// The most we will pull off disk in one read. An inflated file should not be
// dragged into a process the whole desktop shares, so the read stops here —
// which means a deck past it arrives with its tail cut off rather than whole.
// READ_SH applies this and parseDeck recognises having hit it, so the two have
// to agree; that is why it is named once here instead of written twice.
var READ_LIMIT = 262144

function isGrade(g) {
  return GRADES.indexOf(g) !== -1
}

function clampEase(ease) {
  return Math.max(MIN_EASE, Math.min(MAX_EASE, Math.round(ease)))
}

// Has this lapse just made the card a leech? Anki fires at the threshold and
// then every half-threshold lapses after it, so a leech left in the deck is
// raised again at 8, 12, 16 rather than every single time.
//
// A threshold of 0 turns leeches off entirely, which is what the setting's 0
// means and what a deck of deliberately hard cards wants.
function isLeechLapse(lapses, threshold) {
  var lf = Math.max(0, Math.round(num(threshold, LEECH_THRESHOLD)))
  if (!lf || lapses < lf) return false
  return (lapses - lf) % Math.max(1, Math.floor(lf / 2)) === 0
}

// The share of the interval a lapse keeps, as a fraction. Clamped to 0-100%: a
// negative share is meaningless and one above 100 would make forgetting a card
// lengthen it.
//
// At 0% the multiplication gives nothing and clampInterval floors the result at
// one day, which is exactly Anki's pairing of a 0% new interval with a one-day
// minimum. The minimum is not separately configurable here; Anki exposes it,
// but a day is the only value that has ever made sense for it.
function lapseFactor(opts) {
  var o = opts || {}
  return Math.max(0, Math.min(100, Math.round(num(o.lapsePercent, LAPSE_PERCENT)))) / 100
}

// Leech settings, defaulted. Kept in one place because grade() and the surfaces
// both need them and a disagreement would be invisible.
function leechConfig(opts) {
  var o = opts || {}
  return {
    threshold: Math.max(0, Math.round(num(o.leechThreshold, LEECH_THRESHOLD))),
    suspend: o.leechSuspend !== false
  }
}

function clampInterval(seconds) {
  return Math.max(MIN_REVIEW_INTERVAL, Math.min(MAX_INTERVAL, Math.round(seconds)))
}

// Cards answered in one sitting come due in one sitting, and answering them
// together again keeps them together — a deck studied in a few sessions
// collapses into a few permanent clumps. Anki spreads each interval over a
// small band around itself to break that up, widening with the interval, and
// these are its ranges.
//
// The roll is handed in rather than drawn here so that grade() stays pure: the
// same state, grade and roll always produce the same answer. That is what lets
// previewIntervals price all four buttons by calling grade() itself — it
// passes no roll, so the labels show the unfuzzed interval and hold still
// under the cursor instead of flickering on every repaint.
function fuzzInterval(seconds, roll) {
  var r = Number(roll)
  if (!isFinite(r)) return seconds        // no roll: previews, and the tests
  r = Math.max(0, Math.min(0.999999, r))

  var days = Math.round(seconds / DAY)
  if (days < 2) return seconds            // a day cannot be spread anywhere

  var low, high
  if (days === 2) {
    // Anki's one asymmetric case: never pull a 2-day card back to 1 day.
    low = 2
    high = 3
  } else {
    var band
    if (days < 7) band = Math.floor(days * 0.25)
    else if (days < 30) band = Math.max(2, Math.floor(days * 0.15))
    else band = Math.max(4, Math.floor(days * 0.05))
    band = Math.max(1, band)
    low = days - band
    high = days + band
  }

  return clampInterval((low + Math.floor(r * (high - low + 1))) * DAY)
}

// How many whole days later than scheduled this answer is. Anki counts in days
// and never below zero: answering early earns no credit, and must not be turned
// into a penalty either.
//
// Only a review card can be late in the sense that matters. A learning card is
// measured in minutes and its steps are fixed, so lateness there is not
// evidence of anything.
function daysLate(state, now) {
  if (state.phase !== "review") return 0
  return Math.max(0, Math.floor((now - state.due) / DAY))
}

// Anki's _constrainedIvl. Every successful answer has to move the card further
// out than the grade below it, even when the multiplier rounds to nothing —
// otherwise a card with a short interval and a low ease can sit at the same
// spacing forever, and a harsher grade can end up scheduling a longer gap than
// a kinder one.
//
// Spreading happens before the floor, not after, which is also Anki's order. A
// band reaching below the floor is meant to be cut off by it; spreading
// afterwards would push a grade back under the one it has to beat.
function constrainIvl(seconds, floorSeconds, roll) {
  return clampInterval(Math.max(fuzzInterval(seconds, roll), floorSeconds + DAY))
}

function newState() {
  return {
    phase: "new",
    due: 0,
    interval: 0,
    ease: STARTING_EASE,
    reps: 0,
    lapses: 0,
    step: 0,
    // When this card last changed, so two surfaces writing the same file can
    // be reconciled per card instead of one overwriting the other wholesale.
    updated: 0,
    // The study day this card stopped being new. The day's new-card allowance
    // is counted from these rather than from a stored tally, so the count
    // cannot drift, double-count, or regress when documents are merged.
    firstDay: "",
    // Flagged as a leech at some point. Sticky, and kept after the card is
    // restored, so the statistics can still say which cards have been trouble.
    leech: false,
    // Taken out of the rotation. The queue and the counts skip it entirely, so
    // it is neither shown nor counted as waiting.
    suspended: false
  }
}

function num(value, fallback) {
  var n = Number(value)
  return isFinite(n) ? n : fallback
}

// State comes off disk, where anything running as the user could have written
// it, so every field is coerced back into range before it reaches the
// scheduler. A nonsense phase is treated as a new card: re-learning something
// is cheap, and scheduling off a garbage interval is not.
function normalizeState(state) {
  if (!state || typeof state !== "object") return newState()

  var phase = String(state.phase || "new")
  if (["new", "learning", "review", "relearning"].indexOf(phase) === -1) return newState()

  var steps = phase === "relearning" ? RELEARNING_STEPS : LEARNING_STEPS
  return {
    phase: phase,
    due: Math.max(0, num(state.due, 0)),
    interval: Math.max(0, Math.min(MAX_INTERVAL, num(state.interval, 0))),
    ease: clampEase(num(state.ease, STARTING_EASE)),
    reps: Math.max(0, Math.round(num(state.reps, 0))),
    lapses: Math.max(0, Math.round(num(state.lapses, 0))),
    step: Math.max(0, Math.min(steps.length - 1, Math.round(num(state.step, 0)))),
    updated: Math.max(0, num(state.updated, 0)),
    firstDay: text(state.firstDay),
    // Anything but a literal true is false: this comes off disk, and a card
    // that is accidentally unsuspended is recoverable where one accidentally
    // suspended just silently stops appearing.
    leech: state.leech === true,
    suspended: state.suspended === true
  }
}

// Answer one card. Returns the next state and never mutates the one passed in,
// so a caller can price every button (see previewIntervals) before committing
// to any of them.
//
// `roll` is an optional number in [0, 1) used to spread the resulting interval
// (see fuzzInterval). Omitting it means no spreading, which is what pricing a
// button wants; the one call site that actually commits an answer passes one.
//
// `opts` carries the settings a grade depends on: `lapsePercent` (see
// LAPSE_PERCENT) and the leech pair (see leechConfig). Both take effect only on
// Again, and neither is visible in a priced label: Again's label is the
// relearning step, ten minutes, whatever the lapse keeps or the leech rule
// decides. So previewIntervals leaves opts out along with the roll, and the
// four numbers under the buttons stay true for any settings.
function grade(state, g, now, roll, opts) {
  var s = normalizeState(state)
  if (!isGrade(g)) return s

  var next = {
    phase: s.phase,
    due: s.due,
    interval: s.interval,
    ease: s.ease,
    reps: s.reps + 1,
    lapses: s.lapses,
    step: s.step,
    updated: now,
    // Only the answer that ends a card's life as "new" dates it. A card
    // already in review keeps whatever it had, so re-answering an old card
    // never makes it look like one introduced today.
    firstDay: s.phase === "new" ? dayKey(now) : s.firstDay,
    // Both carried rather than reset. Answering a restored leech must not
    // quietly clear the mark that says it has been one.
    leech: s.leech,
    suspended: s.suspended
  }

  // ------------------------------------------------- new and learning cards
  // Nothing here touches ease: a card you have not learned yet has no history
  // to judge it by, so it graduates on the fixed intervals instead.
  if (s.phase === "new" || s.phase === "learning") {
    var at = s.phase === "new" ? 0 : s.step

    if (g === "again") {
      next.phase = "learning"
      next.step = 0
      next.interval = 0
      next.due = now + LEARNING_STEPS[0]
    } else if (g === "hard") {
      // Repeat the step rather than advance: hard means it was recalled, but
      // not well enough to earn a longer gap.
      next.phase = "learning"
      next.step = at
      next.interval = 0
      next.due = now + LEARNING_STEPS[at]
    } else if (g === "good") {
      var step = at + 1
      if (step >= LEARNING_STEPS.length) {
        next.phase = "review"
        next.step = 0
        // Graduating is a day, which has nowhere to spread to; fuzzed anyway
        // so that a longer first interval would be spread if one were set.
        next.interval = fuzzInterval(GRADUATING_INTERVAL, roll)
        next.due = now + next.interval
      } else {
        next.phase = "learning"
        next.step = step
        next.interval = 0
        next.due = now + LEARNING_STEPS[step]
      }
    } else {
      // Easy skips the remaining steps entirely.
      next.phase = "review"
      next.step = 0
      next.interval = fuzzInterval(EASY_INTERVAL, roll)
      next.due = now + next.interval
    }
    return next
  }

  // ------------------------------------------------------- relearning cards
  // The interval was already cut when the card lapsed, so leaving relearning
  // restores that reduced interval rather than starting over at a day. It is
  // restored as it was, unspread: it is an interval this card already had, not
  // a newly computed one, and Anki leaves this case alone too.
  if (s.phase === "relearning") {
    if (g === "again") {
      next.step = 0
      next.due = now + RELEARNING_STEPS[0]
      return next
    }
    if (g === "hard") {
      next.due = now + RELEARNING_STEPS[s.step]
      return next
    }

    var rstep = s.step + 1
    if (g === "easy" || rstep >= RELEARNING_STEPS.length) {
      next.phase = "review"
      next.step = 0
      next.interval = clampInterval(s.interval)
      next.due = now + next.interval
    } else {
      next.step = rstep
      next.due = now + RELEARNING_STEPS[rstep]
    }
    return next
  }

  // ------------------------------------------------------------ review cards
  if (g === "again") {
    // A lapse costs ease and some of the interval, and sends the card back
    // through a short relearning step before it counts as known again. How much
    // of the interval it costs is `lapsePercent`; see LAPSE_PERCENT.
    next.lapses = s.lapses + 1
    next.ease = clampEase(s.ease - 200)
    next.interval = clampInterval(s.interval * lapseFactor(opts))
    next.phase = "relearning"
    next.step = 0
    next.due = now + RELEARNING_STEPS[0]

    // Only a review card can lapse, so this is the only place a leech is made.
    // The card is still scheduled normally underneath: suspending hides it
    // rather than rewriting what it would do, so restoring one puts it back
    // exactly where the scheduler had it rather than at the start.
    var leech = leechConfig(opts)
    if (isLeechLapse(next.lapses, leech.threshold)) {
      next.leech = true
      if (leech.suspend) next.suspended = true
    }
    return next
  }

  // The three passing grades are one chain, each floored a day above the one
  // below it, because that is how Anki computes them and the floors are what
  // keep them in order once spreading is applied.
  //
  // Lateness is the other half of it. If a card was due in ten days, you did
  // not see it for fifty, and you still knew it, then your memory holds it for
  // something like fifty days and not ten — scheduling from the ten throws away
  // the evidence the answer just produced. Good credits half the lateness and
  // Easy all of it. Hard credits none: a struggle is not evidence of
  // comfortable recall, however long the gap was.
  var lateDays = daysLate(s, now)
  var halfLate = Math.floor(lateDays / 2) * DAY   // Anki floors this division
  var fullLate = lateDays * DAY

  // Anki picks the interval before it updates the ease, so all three use the
  // factor the card arrived with — including Easy, whose bonus multiplies the
  // old factor rather than the one the same answer is about to earn.
  var factor = s.ease / 1000

  // The chain shares one roll where Anki draws a fresh one per rung. Only the
  // rung being returned is ever kept; the others exist to be floors, and a
  // floor only binds on very short intervals, where one roll for the chain is
  // if anything the steadier choice. Drawing three would mean handing grade()
  // three rolls to stay as pure as it is.
  var hardIvl = constrainIvl(s.interval * HARD_MULTIPLIER, s.interval, roll)
  if (g === "hard") {
    next.ease = clampEase(s.ease - 150)
    next.interval = hardIvl
  } else {
    var goodIvl = constrainIvl((s.interval + halfLate) * factor, hardIvl, roll)
    if (g === "good") {
      next.interval = goodIvl
    } else {
      next.ease = clampEase(s.ease + 150)
      next.interval = constrainIvl((s.interval + fullLate) * factor * EASY_BONUS, goodIvl, roll)
    }
  }

  next.due = now + next.interval
  return next
}

// What each button would cost, for the labels under them. Anki shows these and
// they are most of what makes a grade choice meaningful rather than a guess.
function previewIntervals(state, now) {
  var out = {}
  for (var i = 0; i < GRADES.length; i++) {
    var g = GRADES[i]
    out[g] = formatInterval(grade(state, g, now).due - now)
  }
  return out
}

function formatInterval(seconds) {
  var s = Math.max(0, Math.round(seconds))
  if (s < MINUTE) return "<1m"
  if (s < HOUR) return Math.round(s / MINUTE) + "m"
  if (s < DAY) return Math.round(s / HOUR) + "h"

  var days = s / DAY
  if (days < 30) return Math.round(days) + "d"
  if (days < 365) return trimZero(days / 30) + "mo"
  return trimZero(days / 365) + "y"
}

function trimZero(value) {
  var text = value.toFixed(1)
  return text.slice(-2) === ".0" ? text.slice(0, -2) : text
}

// The local day this instant belongs to, with the 4am rollover applied.
function dayKey(now) {
  var d = new Date((now - ROLLOVER_HOUR * HOUR) * 1000)
  var month = d.getMonth() + 1
  var day = d.getDate()
  return d.getFullYear() + "-" + (month < 10 ? "0" : "") + month + "-" + (day < 10 ? "0" : "") + day
}

// --------------------------------------------------------------------- deck

// Cards are identified by a hash of their front, not by position, so
// reordering the file or fixing a typo on the back keeps a card's history.
// Editing the front is deliberately a new card: the question changed, and its
// old schedule was earned answering a different one.
function hashId(text) {
  var h = 0x811c9dc5
  for (var i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return ("0000000" + h.toString(16)).slice(-8)
}

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim()
}

// The read cap counts bytes, and a deck of accented or CJK text spends more
// bytes than it has characters, so asking the string for its length would
// under-count exactly the decks most likely to be near the limit.
function utf8Length(s) {
  var n = 0
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++ }  // surrogate pair
    else n += 3
  }
  return n
}

// Did this text come back having filled the read? `dd` stops at one block, so
// a file larger than the cap is delivered truncated and silently — the only
// evidence is the size of what arrived.
//
// The comparison allows a few bytes of slack because the cut can land inside a
// multi-byte character, and the stray bytes are dropped or replaced on the way
// through the decoder, so a truncated read can measure slightly short of the
// cap once re-encoded.
function hitReadLimit(raw) {
  return utf8Length(text(raw)) >= READ_LIMIT - 3
}

var TOO_LARGE = "Deck is too large — over " + Math.round(READ_LIMIT / 1024) + " KiB"

// Accepts either a bare array or `{ "cards": [...] }`, because both are things
// a person plausibly types into a deck file. Entries missing a front or a back
// are dropped rather than shown as blank cards, and the first id wins on a
// duplicate front so one deck cannot hold two schedules under one identity.
function parseDeck(raw) {
  var data
  try {
    data = JSON.parse(raw || "")
  } catch (e) {
    // A deck past the cap fails to parse because its tail was cut off, which
    // has nothing to do with how it was written. Saying "not valid JSON" sends
    // the user looking for a syntax error that is not there.
    if (hitReadLimit(raw)) return { cards: [], error: TOO_LARGE }
    return { cards: [], error: "Deck is not valid JSON" }
  }

  var list = Array.isArray(data) ? data : (data && Array.isArray(data.cards) ? data.cards : null)
  if (!list) return { cards: [], error: "Deck has no cards array" }

  var cards = []
  var seen = {}
  for (var i = 0; i < list.length; i++) {
    var entry = list[i]
    if (!entry || typeof entry !== "object") continue

    var front = text(entry.front)
    var back = text(entry.back)
    if (!front || !back) continue

    var id = text(entry.id) || hashId(front)
    if (seen[id]) continue
    seen[id] = true

    cards.push({
      id: id,
      front: front,
      back: back,
      tags: Array.isArray(entry.tags) ? entry.tags.map(text).filter(Boolean) : []
    })
  }

  return { cards: cards, error: "" }
}

// A tag is written twice — once in the deck, once in shell.json — and those
// two are typed months apart, so matching ignores case and duplicates.
function normalizeTags(wanted) {
  var out = []
  if (wanted === undefined || wanted === null) return out

  var list = Array.isArray(wanted) ? wanted : [wanted]
  for (var i = 0; i < list.length; i++) {
    var t = text(list[i]).toLowerCase()
    if (t && out.indexOf(t) === -1) out.push(t)
  }
  return out
}

// Narrowing a session to part of a deck is what makes a card's tags worth
// carrying. No filter means the whole deck; with one, a card is kept if it
// carries any of the wanted tags, so ["omarchy", "spanish"] is a union rather
// than a card needing both. Tags nest with "::" the way Anki's do, and asking
// for a parent asks for everything under it.
function filterByTags(cards, wanted) {
  var want = normalizeTags(wanted)
  if (!want.length) return cards || []

  var kept = []
  var list = cards || []
  for (var i = 0; i < list.length; i++) {
    var tags = list[i].tags || []
    for (var j = 0; j < tags.length; j++) {
      if (pathMatches(text(tags[j]).toLowerCase(), want, TAG_SEP)) {
        kept.push(list[i])
        break
      }
    }
  }
  return kept
}

// The one-line state summary above the card. Both surfaces render it, so it is
// written once here rather than twice in QML.
function sectionLabel(phase, state, tags, decks) {
  var head
  if (phase !== "reviewing") head = "SESSION"
  else if (state.phase === "new") head = "NEW"
  else if (state.phase === "learning") head = "LEARNING"
  else if (state.phase === "relearning")
    head = "RELEARNING  ·  " + state.lapses + " lapse" + (state.lapses === 1 ? "" : "s")
  else
    head = "REVIEW  ·  " + formatInterval(state.interval) + "  ·  ease " + (state.ease / 1000).toFixed(2)

  var scope = scopeLabel(decks, tags)
  return scope ? head + "  ·  " + scope : head
}

// ------------------------------------------------------------------ library
//
// The library is a directory of deck files. A deck's id is its path under that
// directory without the extension, so folders are parents: `infra/backend.json`
// is the deck `infra/backend`, and `infra.json` beside the folder holds the
// parent's own cards. Ids are opaque everywhere else - nothing but the tree
// functions here looks inside one.

var DECK_SEP = "/"
var TAG_SEP = "::"

// Set aside for a deck source that is not a file. A library file may not claim
// it, or a selection could come to mean something else later.
var RESERVED_DECK = "gleamdrill:"

// What a selection entry may say besides a plain id: `infra/.` is the deck
// `infra` without the decks under it. It exists so that unticking one child of
// a ticked parent can leave everything else the parent held.
function ownOnly(id, sep) {
  return id + sep + "."
}

// Is `id` covered by one selection entry?
function covers(entry, id, sep) {
  return entry === id || entry === ownOnly(id, sep) || id.indexOf(entry + sep) === 0
}

// Is `id` in the selection? No selection means everything is.
function pathMatches(id, selected, sep) {
  if (!selected || !selected.length) return true
  for (var i = 0; i < selected.length; i++)
    if (covers(selected[i], id, sep)) return true
  return false
}

function deckMatches(id, selected) {
  return pathMatches(id, selected, DECK_SEP)
}

function normalizeDecks(value) {
  var out = []
  if (value === undefined || value === null) return out
  var list = Array.isArray(value) ? value : [value]
  for (var i = 0; i < list.length; i++) {
    var id = text(list[i])
    if (id && out.indexOf(id) === -1) out.push(id)
  }
  return out
}

function lastPart(id, sep) {
  var parts = id.split(sep)
  return parts[parts.length - 1] === "." ? parts[parts.length - 2] : parts[parts.length - 1]
}

// What is being studied, short enough for a header: one thing is named, more
// are counted.
function scopeLabel(decks, tags) {
  var d = normalizeDecks(decks)
  var t = normalizeTags(tags)
  var parts = []
  if (d.length === 1) parts.push(lastPart(d[0], DECK_SEP))
  else if (d.length) parts.push(d.length + " decks")
  if (t.length > 3) parts.push(t.length + " tags")
  else if (t.length) parts.push("#" + t.map(function(x) {
    return x.slice(-TAG_SEP.length - 1) === TAG_SEP + "." ? x.slice(0, -TAG_SEP.length - 1) : x
  }).join(" #"))
  return parts.join("  ·  ")
}

// Where the library is, resolved like the deck path.
function resolveDeckDir(configured, home) {
  var path = text(configured).replace(/\/+$/, "")
  if (!path) return home + "/.local/share/omanki"
  if (path.slice(0, 2) === "~/") return home + path.slice(1)
  return path
}

// LIST_SH's output: one `mtime<TAB>size<TAB>path` per line. The stamp is what
// lets a reload skip files that have not changed since they were last parsed.
function parseListing(raw) {
  var out = []
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var f = lines[i].split("\t")
    if (f.length !== 3 || f[2].slice(-5) !== ".json") continue
    var id = f[2].slice(0, -5)
    // A name that is empty, or reserved, or that would read as the own-only
    // form cannot be selected unambiguously, so it is not a deck.
    var parts = id.split(DECK_SEP)
    if (parts.some(function(p) { return !text(p) || p !== p.trim() || p === "." })) continue
    if (id.indexOf(RESERVED_DECK) === 0) continue
    out.push({ id: id, path: f[2], stamp: f[0] + ":" + f[1] })
  }
  out.sort(function(a, b) { return comparePaths(a.id, b.id, DECK_SEP) })
  return out
}

// Component by component, so a deck's children follow it directly rather than
// being separated from it by a sibling whose name sorts before the separator.
function comparePaths(a, b, sep) {
  var x = a.toLowerCase().split(sep)
  var y = b.toLowerCase().split(sep)
  for (var i = 0; i < x.length && i < y.length; i++) {
    if (x[i] < y[i]) return -1
    if (x[i] > y[i]) return 1
  }
  if (x.length !== y.length) return x.length - y.length
  return a < b ? -1 : (a > b ? 1 : 0)
}

// Rows for a tree of paths, parents before children. A parent that is only
// implied by its children is given a row of its own, marked `own: false`.
function buildTree(ids, sep) {
  var known = {}
  var i
  for (i = 0; i < ids.length; i++) {
    var parts = ids[i].split(sep)
    for (var n = 1; n < parts.length; n++) {
      var up = parts.slice(0, n).join(sep)
      if (!Object.prototype.hasOwnProperty.call(known, up)) known[up] = false
    }
    known[ids[i]] = true
  }

  var all = Object.keys(known)
  all.sort(function(a, b) { return comparePaths(a, b, sep) })
  return all.map(function(id) {
    var p = id.split(sep)
    return {
      id: id,
      name: p[p.length - 1],
      depth: p.length - 1,
      parent: p.slice(0, -1).join(sep),
      own: known[id]
    }
  })
}

function buildDeckTree(decks) {
  return buildTree((decks || []).map(function(d) { return d.id }), DECK_SEP)
}

// on | some | off. "some" is a parent with part of it picked.
function nodeState(id, selected, sep) {
  if (!selected || !selected.length) return "off"
  var some = false
  for (var i = 0; i < selected.length; i++) {
    var entry = selected[i]
    if (entry === id || id.indexOf(entry + sep) === 0) return "on"
    if (entry === ownOnly(id, sep) || entry.indexOf(id + sep) === 0) some = true
  }
  return some ? "some" : "off"
}

// Flip one row. Ticking a row takes its whole subtree; unticking a row its
// parent was ticked for keeps the rest of that parent. Ticking the last of a
// parent's children puts the parent back as one entry, so a deck added to that
// folder later is included the way a ticked parent implies.
//
// Entries for decks that are gone are dropped on the way through. Unticking
// the last row leaves nothing selected, which means everything.
function toggleNode(rows, selected, id, sep) {
  var list = (selected || []).filter(function(entry) {
    return rows.some(function(r) { return entry === r.id || entry === ownOnly(r.id, sep) })
  })
  var state = nodeState(id, list, sep)

  function childrenOf(parent) {
    return rows.filter(function(r) { return r.parent === parent && r.id !== parent })
  }
  function rowOf(rid) {
    for (var i = 0; i < rows.length; i++) if (rows[i].id === rid) return rows[i]
    return null
  }

  if (state === "on") {
    if (list.indexOf(id) !== -1) return list.filter(function(e) { return e !== id })

    // Ticked through an ancestor: split that ancestor down to this row.
    var out = []
    for (var i = 0; i < list.length; i++) {
      var entry = list[i]
      if (id.indexOf(entry + sep) !== 0) { out.push(entry); continue }
      var at = entry
      while (at !== id) {
        var row = rowOf(at)
        if (row && row.own) out.push(ownOnly(at, sep))
        var next = at
        childrenOf(at).forEach(function(c) {
          if (c.id === id || id.indexOf(c.id + sep) === 0) next = c.id
          else out.push(c.id)
        })
        if (next === at) break
        at = next
      }
    }
    return out
  }

  // Ticking: this row now stands for everything under it.
  list = list.filter(function(e) {
    return e !== ownOnly(id, sep) && e.indexOf(id + sep) !== 0
  })
  list.push(id)

  // Fold upward while a parent is wholly covered.
  var r = rowOf(id)
  while (r && r.parent) {
    var up = rowOf(r.parent)
    if (!up) break
    var whole = childrenOf(up.id).every(function(c) { return list.indexOf(c.id) !== -1 })
        && (!up.own || list.indexOf(ownOnly(up.id, sep)) !== -1)
    if (!whole) break
    var upId = up.id
    list = list.filter(function(e) {
      return e !== ownOnly(upId, sep) && e.indexOf(upId + sep) !== 0
    })
    list.push(upId)
    r = up
  }
  return list
}

function toggleDeck(rows, selected, id) {
  return toggleNode(rows, normalizeDecks(selected), id, DECK_SEP)
}

function toggleTag(rows, selected, id) {
  return toggleNode(rows, normalizeTags(selected), id, TAG_SEP)
}

// Each card remembers the deck it came from, for limits and for the composer.
function assignDeck(cards, id) {
  return (cards || []).map(function(c) {
    return { id: c.id, front: c.front, back: c.back, tags: c.tags, deck: id }
  })
}

// The cards in scope. Duplicates are dropped after the decks are chosen, not
// before: the same card in two decks is one schedule, but it has to turn up
// whichever of the two is picked.
function mergeDecks(decks, selected) {
  var out = []
  var seen = {}
  var list = decks || []
  for (var i = 0; i < list.length; i++) {
    if (!deckMatches(list[i].id, selected)) continue
    var cards = list[i].cards || []
    for (var j = 0; j < cards.length; j++) {
      if (Object.prototype.hasOwnProperty.call(seen, cards[j].id)) continue
      seen[cards[j].id] = true
      out.push(cards[j])
    }
  }
  return out
}

// The deck tree with what is waiting in each, parents including their
// children. These are what is there, before any daily limit.
function deckRows(decks, progress, now) {
  var rows = buildDeckTree(decks)
  var at = {}
  rows.forEach(function(r) { r.total = 0; r.due = 0; r.fresh = 0; at[r.id] = r })

  ;(decks || []).forEach(function(d) {
    var total = 0, due = 0, fresh = 0
    ;(d.cards || []).forEach(function(c) {
      var s = stateFor(progress || emptyProgress(), c.id)
      total++
      if (s.suspended) return
      if (s.phase === "new") fresh++
      else if (s.due <= now) due++
    })
    var parts = d.id.split(DECK_SEP)
    for (var n = 1; n <= parts.length; n++) {
      var r = at[parts.slice(0, n).join(DECK_SEP)]
      r.total += total; r.due += due; r.fresh += fresh
    }
  })
  return rows
}

// The tags on these cards as a tree, with how many cards each would give. A
// card tagged `sd::caching` and `sd::messaging` is one card under `sd`.
function tagRows(cards) {
  var ids = {}
  var totals = {}
  ;(cards || []).forEach(function(c) {
    var mine = {}
    ;(c.tags || []).forEach(function(tag) {
      var id = text(tag).toLowerCase()
      // An empty component would make a row nothing could name.
      if (!id || id.split(TAG_SEP).some(function(p) { return !p || p === "." })) return
      ids[id] = true
      var parts = id.split(TAG_SEP)
      for (var n = 1; n <= parts.length; n++) mine[parts.slice(0, n).join(TAG_SEP)] = true
    })
    for (var id in mine) totals[id] = (totals[id] || 0) + 1
  })
  var rows = buildTree(Object.keys(ids), TAG_SEP)
  rows.forEach(function(r) { r.total = totals[r.id] || 0 })
  return rows
}

// ------------------------------------------------------------------- limits
//
// `newPerDay` and `reviewsPerDay` cap the whole day. `limits` caps one deck, or
// a parent and everything under it:
//
//   { "infra/backend": { "new": 10, "reviews": 50 } }
//
// Absent is no cap. Unlike the overall `reviewsPerDay`, where 0 means no cap,
// a deck's 0 means none today: there is already a way to say "no cap" here.

function limitValue(v) {
  if (v === undefined || v === null || v === "") return null
  var n = Math.round(Number(v))
  return isFinite(n) && n >= 0 ? n : null
}

function normalizeLimits(value) {
  var out = {}
  if (!value || typeof value !== "object" || Array.isArray(value)) return out
  for (var id in value) {
    if (!Object.prototype.hasOwnProperty.call(value, id)) continue
    var key = text(id)
    var v = value[id]
    if (!key || !v || typeof v !== "object") continue
    var fresh = limitValue(v["new"])
    var reviews = limitValue(v.reviews)
    if (fresh === null && reviews === null) continue
    out[key] = {}
    if (fresh !== null) out[key]["new"] = fresh
    if (reviews !== null) out[key].reviews = reviews
  }
  return out
}

// A copy with one value changed; null takes it away, and a deck left with
// nothing drops out.
function withLimit(limits, id, kind, value) {
  var out = normalizeLimits(limits)
  if (!out[id]) out[id] = {}
  if (value === null) delete out[id][kind]
  else out[id][kind] = value
  return normalizeLimits(out)
}

// One press of + or -. Stepping below zero takes the cap away, and stepping up
// from no cap starts at one step.
function stepLimit(value, direction, step) {
  if (value === null || value === undefined) return direction > 0 ? step : null
  var next = direction > 0 ? (Math.floor(value / step) + 1) * step
                           : (Math.ceil(value / step) - 1) * step
  if (next >= 0) return next
  return value > 0 ? 0 : null
}

// What each limited deck has left today, counted from the library's cards for
// the same reason the overall tallies are.
function deckBudgets(library, progress, now, limits) {
  var caps = normalizeLimits(limits)
  var ids = Object.keys(caps)
  if (!ids.length) return []

  var today = dayKey(now)
  var budgets = ids.map(function(id) {
    var c = caps[id]
    return {
      id: id,
      fresh: c["new"] === undefined ? Infinity : c["new"],
      due: c.reviews === undefined ? Infinity : c.reviews
    }
  })

  var seen = {}
  ;(library || []).forEach(function(card) {
    var s = progress && progress.reviews ? progress.reviews[card.id] : null
    if (!s) return
    var introduced = text(s.firstDay) === today
    var reviewed = !introduced && num(s.updated, 0) > 0 && dayKey(num(s.updated, 0)) === today
    if (!introduced && !reviewed) return

    budgets.forEach(function(b) {
      if (!covers(b.id, text(card.deck), DECK_SEP)) return
      // A card listed in two decks under one parent is one card.
      var key = b.id + "\n" + card.id
      if (seen[key]) return
      seen[key] = true
      if (introduced) b.fresh = Math.max(0, b.fresh - 1)
      else b.due = Math.max(0, b.due - 1)
    })
  })
  return budgets
}

// What today's limits let through. The queue and the counts both come from
// here, so the number in the bar and the cards behind it cannot disagree.
//
// `caps` is { limits, library }, where library is every card there is, picked
// or not: a card answered under a different selection this morning still spent
// its deck's allowance.
//
// A deck's review cap leaves learning and relearning cards alone. They are
// today's unfinished business, and a deck capped at no reviews would otherwise
// start new cards it could never finish.
function admit(cards, progress, now, newPerDay, reviewsPerDay, caps) {
  var rolled = progress || emptyProgress()
  var left = remainingToday(rolled, now, newPerDay, reviewsPerDay)
  var budgets = caps ? deckBudgets(caps.library, rolled, now, caps.limits) : []
  var byDeck = {}

  function budgetsFor(deck) {
    var d = text(deck)
    if (!Object.prototype.hasOwnProperty.call(byDeck, d))
      byDeck[d] = budgets.filter(function(b) { return covers(b.id, d, DECK_SEP) })
    return byDeck[d]
  }
  function spend(list, kind) {
    for (var i = 0; i < list.length; i++) if (list[i][kind] <= 0) return false
    for (var j = 0; j < list.length; j++) list[j][kind]--
    return true
  }

  var due = []
  var fresh = []
  for (var i = 0; i < cards.length; i++) {
    var s = stateFor(rolled, cards[i].id)
    // A suspended card is out of the rotation entirely - not shown, not
    // counted, and not waiting. It is the only state that skips both queues.
    if (s.suspended) continue
    if (s.phase === "new") {
      if (fresh.length < left.fresh && spend(budgetsFor(cards[i].deck), "fresh"))
        fresh.push(cards[i].id)
    } else if (s.due <= now) {
      due.push({ id: cards[i].id, due: s.due, deck: cards[i].deck, phase: s.phase })
    }
  }

  due.sort(function(a, b) { return a.due - b.due })

  // The cap trims the tail, so what survives is the most overdue — the cards
  // closest to being forgotten, which is what a partial day should spend
  // itself on.
  var shown = []
  for (var d = 0; d < due.length && shown.length < left.due; d++) {
    if (due[d].phase !== "review" || spend(budgetsFor(due[d].deck), "due"))
      shown.push(due[d].id)
  }
  return { due: shown, fresh: fresh, dueTotal: due.length }
}

// Which deck a new card goes to: the one on screen, else the first picked,
// else the default file.
function addTarget(current, decks, selected) {
  if (current) return current
  var list = decks || []
  if (selected && selected.length)
    for (var i = 0; i < list.length; i++)
      if (deckMatches(list[i].id, selected)) return list[i].id
  return "cards"
}

// WRITE_SH takes a directory and a bare filename, so a configured deck path
// has to be split before it can be written back.
function dirOf(path) {
  var p = text(path)
  var i = p.lastIndexOf("/")
  return i <= 0 ? "/" : p.slice(0, i)
}

function baseOf(path) {
  var p = text(path)
  var i = p.lastIndexOf("/")
  return i === -1 ? p : p.slice(i + 1)
}

// Append a card to the deck's raw text.
//
// The deck is a file the user writes by hand, so this edits the parsed
// document rather than regenerating it from parseDeck's output: entries keep
// every field they had, including ones this plugin knows nothing about, and
// keep their order. Anything it cannot read, it refuses to touch — overwriting
// a deck it failed to understand would be the one unrecoverable thing it
// could do.
function appendCard(raw, front, back, tags) {
  var f = text(front)
  var b = text(back)
  if (!f) return { error: "A card needs a front", raw: raw }
  if (!b) return { error: "A card needs a back", raw: raw }

  // Checked before parsing rather than as a parse failure, because this is the
  // path that writes. Truncated JSON all but always fails to parse and would
  // be refused below anyway — but "all but always" is the wrong standard for
  // the one operation that could replace a deck with a shortened copy of
  // itself, so the size is what decides it.
  if (hitReadLimit(raw)) return { error: TOO_LARGE + " — leaving it alone", raw: raw }

  var data
  if (!text(raw)) {
    data = { cards: [] }
  } else {
    try {
      data = JSON.parse(raw)
    } catch (e) {
      return { error: "Deck is not valid JSON — leaving it alone", raw: raw }
    }
  }

  var list = Array.isArray(data) ? data : (data && Array.isArray(data.cards) ? data.cards : null)
  if (!list) return { error: "Deck has no cards array — leaving it alone", raw: raw }

  // A card is identified by its front, so two cards sharing one would share a
  // single schedule and the second would never be seen.
  var id = hashId(f)
  for (var i = 0; i < list.length; i++) {
    var e = list[i]
    if (!e || typeof e !== "object") continue
    var existing = text(e.id) || hashId(text(e.front))
    if (existing === id) return { error: "That front is already in the deck", raw: raw }
  }

  var card = { front: f, back: b }
  var t = normalizeTags(tags)
  if (t.length) card.tags = t
  list.push(card)

  return { error: "", raw: JSON.stringify(data, null, 2) + "\n", id: id }
}

function emptyProgress() {
  return { reviews: {} }
}

// Documents written before the day tally became derived carry `day` and
// `introduced` fields; they are simply ignored, which costs at most one day's
// allowance once and never misreads a card.
function parseProgress(raw) {
  var progress = emptyProgress()
  try {
    var data = JSON.parse(raw || "{}")
    if (!data || typeof data !== "object") return progress

    if (data.reviews && typeof data.reviews === "object") {
      for (var id in data.reviews) {
        if (!Object.prototype.hasOwnProperty.call(data.reviews, id)) continue
        progress.reviews[id] = normalizeState(data.reviews[id])
      }
    }
  } catch (e) {
    // A corrupt progress file costs scheduling history, not a working panel.
  }
  return progress
}

// The new-card allowance is per study day, so a stale counter has to be
// cleared before it is read rather than when it was written — the shell may
// have been running since yesterday.
// How many cards were introduced today, counted from the cards themselves.
// A stored tally cannot survive two surfaces merging their documents; this
// can, and it also removes any need to notice that the day rolled over.
function introducedToday(progress, now) {
  var reviews = (progress && progress.reviews) || {}
  var today = dayKey(now)
  var n = 0
  for (var id in reviews) {
    if (!Object.prototype.hasOwnProperty.call(reviews, id)) continue
    if (reviews[id] && text(reviews[id].firstDay) === today) n++
  }
  return n
}

// Cards reviewed today, counted from the cards themselves so it survives a
// merge for the same reason the new-card tally does.
//
// A "review" here means answering a card that already existed before today.
// Cards introduced today are the new-card allowance's business, and counting
// them twice would let a day of new cards silently consume the review budget.
// This counts cards, not keystrokes: walking a card through its learning steps
// is one card, not three, which is the number a daily cap should be about.
function reviewsToday(progress, now) {
  var reviews = (progress && progress.reviews) || {}
  var today = dayKey(now)
  var n = 0

  for (var id in reviews) {
    if (!Object.prototype.hasOwnProperty.call(reviews, id)) continue
    var s = reviews[id]
    if (!s) continue
    if (text(s.firstDay) === today) continue
    var when = num(s.updated, 0)
    if (when > 0 && dayKey(when) === today) n++
  }
  return n
}

// How many more cards of each kind today's limits still allow. A limit of 0
// means no limit: a cap you have not set should not be a cap of nothing.
function remainingToday(progress, now, newPerDay, reviewsPerDay) {
  var newLimit = Math.max(0, Math.round(num(newPerDay, 20)))
  var revLimit = Math.max(0, Math.round(num(reviewsPerDay, 0)))

  return {
    fresh: Math.max(0, newLimit - introducedToday(progress, now)),
    due: revLimit > 0 ? Math.max(0, revLimit - reviewsToday(progress, now)) : Infinity
  }
}

// Reconcile two documents. Both surfaces hold their own copy and write the
// whole thing, so a write that does not merge destroys whatever the other one
// did — a card graded in the overlay simply vanishing when the bar panel next
// saves. Per card the newer `updated` wins, and a card only one side knows
// about is kept. Answering the same card in two surfaces within one second is
// not something a person can do, so ties keep `mine` and stay deterministic.
function mergeProgress(mine, theirs) {
  var out = {}
  var a = (mine && mine.reviews) || {}
  var b = (theirs && theirs.reviews) || {}
  var id

  for (id in a) {
    if (Object.prototype.hasOwnProperty.call(a, id)) out[id] = normalizeState(a[id])
  }
  for (id in b) {
    if (!Object.prototype.hasOwnProperty.call(b, id)) continue
    var t = normalizeState(b[id])
    if (!out[id] || t.updated > out[id].updated) out[id] = t
  }

  return { reviews: out }
}

function stateFor(progress, id) {
  return normalizeState(progress.reviews ? progress.reviews[id] : null)
}

// The queue for right now: everything already due, soonest first, then as many
// unseen cards as the day's allowance still permits. Reviews come before new
// cards because a card you are about to forget is worth more than one you have
// never seen.
function buildQueue(cards, progress, now, newPerDay, reviewsPerDay, caps) {
  var allowed = admit(cards, progress, now, newPerDay, reviewsPerDay, caps)
  return allowed.due.concat(allowed.fresh)
}

// How many answers back you can walk. Deep enough that a misgrade noticed a
// few cards later is still recoverable, bounded so a long session does not
// accumulate snapshots without limit.
var UNDO_DEPTH = 25

// Put a card at the front of the queue, inserting it if the rebuild dropped
// it. Undo uses this: the card you just took back has to be the next thing you
// see, wherever the scheduler would otherwise have placed it.
function promote(queue, id) {
  var list = queue || []
  if (!id) return list.slice()

  var out = [id]
  for (var i = 0; i < list.length; i++)
    if (list[i] !== id) out.push(list[i])
  return out
}

// Headline numbers for the bar and the panel. `waiting` is a card in learning
// that is not due yet — the reason a session can be empty and still unfinished.
function counts(cards, progress, now, newPerDay, reviewsPerDay, caps) {
  var rolled = progress || emptyProgress()
  var allowed = admit(cards, rolled, now, newPerDay, reviewsPerDay, caps)

  var out = {
    total: cards.length,
    due: 0,
    learning: 0,
    fresh: 0,
    waiting: 0,
    nextDue: 0,
    suspended: 0
  }

  for (var i = 0; i < cards.length; i++) {
    var s = stateFor(rolled, cards[i].id)

    // Counted on its own and excluded from everything else, so a deck whose
    // remainder is all suspended reads as done rather than as waiting on a
    // card that is never coming.
    if (s.suspended) { out.suspended++; continue }

    if (s.phase === "new") continue
    if (s.due <= now) {
      if (s.phase === "learning" || s.phase === "relearning") out.learning++
      continue
    }
    if (s.phase === "learning" || s.phase === "relearning") out.waiting++
    if (!out.nextDue || s.due < out.nextDue) out.nextDue = s.due
  }

  out.fresh = allowed.fresh.length
  // Held back by today's cap rather than not due — worth separating, because
  // "nothing left today" and "nothing due" are different things to be told.
  out.held = allowed.dueTotal - allowed.due.length
  out.due = allowed.due.length
  out.pending = out.due + out.fresh
  return out
}

// ------------------------------------------------------------------- stats
//
// What a person actually wants to know about a deck: how far through it they
// are, how much is coming, and whether the scheduling is working. Everything
// here is derived from the cards — there is no review log, so nothing depends
// on history the plugin does not keep.

// A card is "mature" once its interval reaches three weeks, Anki's threshold.
// The distinction matters because accuracy on cards you have known for a month
// says something quite different from accuracy on ones you met yesterday.
var MATURE_INTERVAL = 21 * DAY

function deckStats(cards, progress, now, newPerDay, reviewsPerDay) {
  var list = cards || []
  var out = {
    total: list.length,
    fresh: 0,        // never answered
    learning: 0,     // in learning or relearning
    young: 0,        // in review, interval under three weeks
    mature: 0,       // in review, interval three weeks or more
    reps: 0,
    lapses: 0,
    lapsed: 0,       // cards that have lapsed at least once
    easeSum: 0,
    easeCount: 0,
    leeches: 0,      // flagged as a leech at some point, restored or not
    suspended: 0,    // currently out of the rotation
    answeredToday: 0,
    introducedToday: introducedToday(progress, now),
    reviewsToday: reviewsToday(progress, now),
    forecast: [0, 0, 0, 0, 0, 0, 0]
  }

  var today = dayKey(now)

  for (var i = 0; i < list.length; i++) {
    var s = stateFor(progress, list[i].id)

    if (s.leech) out.leeches++
    if (s.suspended) out.suspended++

    if (s.phase === "new") { out.fresh++; continue }

    // A suspended card keeps its place in the composition: it is still a card
    // in the deck at whatever maturity it reached, and hiding it there would
    // make the bar stop adding up to the deck.
    if (s.phase === "learning" || s.phase === "relearning") out.learning++
    else if (s.interval >= MATURE_INTERVAL) out.mature++
    else out.young++

    out.reps += s.reps
    out.lapses += s.lapses
    if (s.lapses > 0) out.lapsed++
    out.easeSum += s.ease
    out.easeCount++

    if (s.updated > 0 && dayKey(s.updated) === today) out.answeredToday++

    // Seven days ahead, bucketed by day. Anything already due lands in the
    // first bucket, because "today" is what you would be shown now.
    //
    // A suspended card is left out: its due date is still there underneath and
    // still moves, but nothing will show it, and a forecast that counts cards
    // that are not coming is worse than no forecast.
    if (s.suspended) continue
    var days = Math.floor((s.due - now) / DAY)
    if (days < 0) days = 0
    if (days < out.forecast.length) out.forecast[days]++
  }

  out.seen = out.total - out.fresh
  out.ease = out.easeCount ? out.easeSum / out.easeCount / 1000 : 0

  // Rough retention: how often an answered card has *not* had to be relearned.
  // With no review log this is the honest approximation available — it is a
  // lifetime figure per card, not a rolling window, so it moves slowly.
  out.retention = out.reps > 0 ? Math.max(0, 1 - (out.lapses / out.reps)) : 0

  var left = remainingToday(progress, now, newPerDay, reviewsPerDay)
  out.freshLeft = left.fresh
  out.dueLeft = left.due

  return out
}

// Put every suspended card back in the rotation. The leech mark is kept: the
// card has been trouble and the statistics should go on saying so - what is
// cleared is only the part that hides it.
//
// Returns the new document and the number of cards it put back, as a pair
// rather than a count hung off the document - serializeProgress would drop it
// silently today, and a document that sometimes carries a tally is the kind of
// thing that survives until something does read it.
//
// Every card it changes is stamped, so the change survives the
// read-merge-write the other surface may be doing at the same moment. Cards it
// does not change keep the stamp they had, so restoring does not make an
// untouched card look newer than an answer somewhere else.
function unsuspendAll(progress, now) {
  var reviews = (progress && progress.reviews) || {}
  var out = { reviews: {} }
  var restored = 0

  for (var id in reviews) {
    if (!Object.prototype.hasOwnProperty.call(reviews, id)) continue
    var s = normalizeState(reviews[id])
    if (s.suspended) {
      s.suspended = false
      s.updated = now
      restored++
    }
    out.reviews[id] = s
  }

  return { progress: out, restored: restored }
}

function percent(fraction) {
  return Math.round(Math.max(0, Math.min(1, fraction || 0)) * 100) + "%"
}

// ------------------------------------------------------------------ file I/O
//
// Both files live under the user's home, in predictable places, and the shell
// that touches them is a long-lived process shared by the whole desktop. So
// they are treated as hostile in both directions.
//
// Guarding the *file* is not enough. `mkdir -p`, `mktemp` and `mv` all follow
// a directory symlink, so a symlink planted at any component of a predictable
// path — `~/.local`, `~/.local/state`, `~/.local/state/omarchy` — redirects
// the whole operation and can make the shell replace a file somewhere else
// entirely. The last path component being safe is worth nothing if the walk to
// it was already diverted.
//
// So both helpers walk the chain themselves, one component at a time, refusing
// any symlink and requiring a directory the caller owns. They then pin the
// final directory with `exec 9<` and verify what they pinned, and do every
// subsequent operation through `/proc/self/fd/9` — a descriptor holds one
// inode, so a directory swapped in after the walk cannot move the write. This
// is the shell's version of the openat() dance.
//
// Containment is decided in JavaScript (see relativeToHome) and the helpers
// are handed HOME plus a path relative to it, so no shell code has to reason
// about escaping the home directory.

// Directories that already exist keep their modes: `~/.local` and `~/.config`
// are shared with every other application and are not a plugin's to tighten.
// Only directories we create are ours to set, and those are private.
var WALK_SH = [
  'h="$1"; rel="$2"',
  // The walk splits on "/" with an unquoted expansion, which would otherwise
  // also expand a directory named `[a]` or `*` against the working directory.
  'set -f',
  // A leading slash or any `..` would walk back out of home; the caller is
  // supposed to have ruled both out already, so treat them as a bug, not input.
  'case "$rel" in ""|/*) exit 64;; esac',
  'case "/$rel/" in */../*) exit 64;; esac',
  // HOME itself is resolved physically rather than walked: a distribution is
  // entitled to make /home a symlink (Fedora Silverblue does), and that is
  // configuration rather than an attack. Everything *below* home must be real.
  'base=$(cd "$h" 2>/dev/null && pwd -P) || exit 64',
  '[ -n "$base" ] || exit 64',
  'name=${rel##*/}',
  'dir=${rel%/*}',
  '[ "$dir" = "$rel" ] && dir=""',
  '[ -n "$name" ] || exit 64'
].join("\n")

// The pin, shared by both helpers. $d must already hold the target directory.
var PIN_SH = [
  'exec 9<"$d" || exit 69',
  // Catches a component that was already a symlink when it was opened, which
  // works precisely because everything below home was required to be physical.
  '[ "$(readlink /proc/self/fd/9)" = "$d" ] || exit 70',
  '[ -d /proc/self/fd/9 ] || exit 70',
  '[ -O /proc/self/fd/9 ] || exit 70'
].join("\n")

// Reading. A missing file, a missing directory and a tampered path all mean
// the same thing to the caller — there is nothing to load — but they are not
// the same thing to the user, so tampering exits non-zero and the surface says
// so rather than silently claiming an empty deck.
//
// The file itself is still opened no-follow and non-blocking so a planted FIFO
// cannot stall the shell, and capped so an inflated file cannot be pulled into
// memory.
//
// $1 = HOME, $2 = path relative to HOME.
var READ_SH = [
  WALK_SH,
  'd="$base"',
  'IFS="/"',
  'for c in $dir; do',
  '  [ -n "$c" ] || continue',
  '  d="$d/$c"',
  '  [ -L "$d" ] && exit 65',
  '  [ -e "$d" ] || exit 0',
  '  [ -d "$d" ] || exit 65',
  '  [ -O "$d" ] || exit 65',
  'done',
  'unset IFS',
  PIN_SH,
  'f="/proc/self/fd/9/$name"',
  '[ -L "$f" ] && exit 65',
  '[ -f "$f" ] || exit 0',
  'exec dd if="$f" iflag=nofollow,nonblock bs=' + READ_LIMIT + ' count=1 2>/dev/null'
].join("\n")

// Listing the library. The same walk and the same pin as a read, but of the
// whole path, because here the last component is the directory.
//
// `find` does not follow symlinks and only regular files are named, so a deck
// cannot be a link to something else; the pin is what keeps the directory
// itself from being swapped. Dotfiles are skipped, which is also what hides a
// write in progress, and so is any name with a control character, since the
// listing is tab and newline separated. Depth and count are bounded for the
// same reason a read is.
//
// $1 = HOME, $2 = directory relative to HOME.
var LIST_LIMIT = 500
var LIST_SH = [
  WALK_SH,
  'dir="$rel"',
  'd="$base"',
  'IFS="/"',
  'for c in $dir; do',
  '  [ -n "$c" ] || continue',
  '  d="$d/$c"',
  '  [ -L "$d" ] && exit 65',
  '  [ -e "$d" ] || exit 0',
  '  [ -d "$d" ] || exit 65',
  '  [ -O "$d" ] || exit 65',
  'done',
  'unset IFS',
  PIN_SH,
  'find -P /proc/self/fd/9/ -mindepth 1 -maxdepth 8'
    + " \\( -name '.*' -o -name '*[[:cntrl:]]*' \\) -prune"
    + " -o -type f -name '*.json' -printf '%T@\\t%s\\t%P\\n' 2>/dev/null"
    + ' | head -n ' + LIST_LIMIT
].join("\n")

// Writing. The document arrives on stdin, so nothing about it is interpolated
// into the shell and no amount of quoting in a card can escape. It is built in
// a fresh 0600 file that mktemp creates exclusively *inside the pinned
// directory*, then renamed onto the destination through the same descriptor —
// rename replaces a symlink instead of following it, so a reader sees either
// the whole old document or the whole new one.
//
// Every failure has its own status so the tests can tell them apart.
//
// $1 = HOME, $2 = path relative to HOME.
var WRITE_SH = [
  WALK_SH,
  'd="$base"',
  'IFS="/"',
  'for c in $dir; do',
  '  [ -n "$c" ] || continue',
  '  d="$d/$c"',
  '  [ -L "$d" ] && exit 65',
  '  if [ -e "$d" ]; then',
  '    [ -d "$d" ] || exit 66',
  '    [ -O "$d" ] || exit 67',
  '  else',
  // Not `mkdir -p`: the walk creates one level at a time so that every level
  // is checked before the next is created.
  '    mkdir -m 700 "$d" || exit 68',
  '  fi',
  'done',
  'unset IFS',
  PIN_SH,
  't=$(mktemp "/proc/self/fd/9/.omanki.XXXXXX") || exit 71',
  'chmod 600 "$t" || { rm -f "$t"; exit 72; }',
  'cat > "$t" || { rm -f "$t"; exit 73; }',
  'mv -f "$t" "/proc/self/fd/9/$name" || { rm -f "$t"; exit 74; }'
].join("\n")

// Is `path` inside `home`, and where? Returns the path relative to home, or ""
// when it is not contained — which the caller must treat as a refusal rather
// than as a path to attempt. Doing this here rather than in shell keeps it
// testable and keeps the helpers free of escape logic.
function relativeToHome(path, home) {
  var p = text(path)
  var h = text(home).replace(/\/+$/, "")
  if (!p || !h || p.charAt(0) !== "/") return ""
  if (p.indexOf(h + "/") !== 0) return ""

  var rel = p.slice(h.length + 1)
  if (!rel) return ""
  // `.` and `..` are refused outright rather than normalised: a path that
  // needs normalising to look safe is not one to be clever about.
  var parts = rel.split("/")
  for (var i = 0; i < parts.length; i++)
    if (parts[i] === "" || parts[i] === "." || parts[i] === "..") return ""
  return rel
}

function serializeProgress(progress) {
  var p = progress || emptyProgress()
  return JSON.stringify({ reviews: p.reviews || {} }) + "\n"
}

// Both surfaces resolve their settings the same way, so the resolution lives
// here rather than twice in QML. `~` is the only thing worth expanding: a deck
// path is hand-typed into shell.json, and a leading ~ is what a person writes.
// Anything else is passed through exactly as given.
function resolveDeck(configured, home) {
  var path = text(configured)
  if (!path) return home + "/.local/share/omanki/cards.json"
  if (path === "~") return home
  if (path.slice(0, 2) === "~/") return home + path.slice(1)
  return path
}

// A typo in shell.json should leave the plugin usable, not stop it introducing
// cards, so anything unparseable falls back to the default rather than to zero.
function sanePerDay(value, fallback) {
  var n = parseInt(value, 10)
  var back = (fallback === undefined) ? 20 : fallback
  return (isFinite(n) && n >= 0) ? n : back
}

// Our own entry in shell.json, wherever it lives. A plugin placed in the bar
// is configured on its bar.layout entry; one that is only enabled is
// configured on its top-level plugins[] entry. This mirrors the shell's own
// findEntryLocation so a setting is read from the same place either way.
function findEntry(config, id) {
  if (!config || !id) return {}

  var layout = config.bar && config.bar.layout
  if (layout) {
    var sections = ["left", "centerBegin", "center", "centerEnd", "right", "tray"]
    for (var s = 0; s < sections.length; s++) {
      var arr = layout[sections[s]]
      if (!Array.isArray(arr)) continue
      for (var i = 0; i < arr.length; i++)
        if (arr[i] && arr[i].id === id) return arr[i]
    }
  }

  if (Array.isArray(config.plugins)) {
    for (var p = 0; p < config.plugins.length; p++)
      if (config.plugins[p] && config.plugins[p].id === id) return config.plugins[p]
  }

  return {}
}
