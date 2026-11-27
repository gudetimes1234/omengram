.pragma library

// Drills: comparing what was typed with the answer. Pure, plain ES5, so the
// QML and node's tests run the same code. Nothing here grades: a comparison
// is something to look at before you grade yourself.

// A line as it is compared: tabs as spaces, runs of spaces as one, trimmed,
// and a trailing ";" or "," ignored. GleamDrill's Line Drill rule, so a line
// that would pass there passes here.
function normalize(line) {
  var collapsed = String(line === undefined || line === null ? "" : line)
      .replace(/\t/g, " ").split(" ").filter(function(p) { return p !== "" }).join(" ")
  var last = collapsed.charAt(collapsed.length - 1)
  if (last === ";" || last === ",") return collapsed.slice(0, -1).replace(/\s+$/, "")
  return collapsed
}

// Leading spaces, with a tab as four. In Python the indentation is the code,
// so a line at the wrong depth is a different line.
function indentOf(line) {
  var n = 0
  for (var i = 0; i < line.length; i++) {
    var c = line.charAt(i)
    if (c === " ") n++
    else if (c === "\t") n += 4
    else break
  }
  return n
}

function codeLines(text) {
  return String(text || "").replace(/\r\n?/g, "\n").split("\n")
      .filter(function(l) { return l.trim() !== "" })
}

// What a line is compared by. `indent` false compares text alone, for a typed
// answer that is prose rather than code.
function keyOf(line, indent) {
  return (indent ? indentOf(line) + "|" : "") + normalize(line)
}

// A line diff of `typed` against `answer`, blank lines ignored, as a list of
// { op, text }: "same" (in both), "missing" (in the answer, not typed), and
// "extra" (typed, not in the answer). Longest common subsequence, which is
// plenty for a solution of a few dozen lines.
//
// Returns { lines, same, matched, total }: `same` when nothing is missing or
// extra, `matched` of `total` answer lines typed.
function diff(answer, typed, opts) {
  var indent = !opts || opts.indent !== false
  var a = codeLines(answer)
  var b = codeLines(typed)
  var ka = a.map(function(l) { return keyOf(l, indent) })
  var kb = b.map(function(l) { return keyOf(l, indent) })
  var n = a.length, m = b.length

  // lcs[i][j]: the longest common run of a[i..] and b[j..].
  var lcs = []
  for (var i = 0; i <= n; i++) {
    lcs.push([])
    for (var j = 0; j <= m; j++) lcs[i].push(0)
  }
  for (i = n - 1; i >= 0; i--)
    for (j = m - 1; j >= 0; j--)
      lcs[i][j] = ka[i] === kb[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])

  var out = []
  i = 0
  j = 0
  while (i < n && j < m) {
    if (ka[i] === kb[j]) { out.push({ op: "same", text: a[i] }); i++; j++ }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ op: "missing", text: a[i] }); i++ }
    else { out.push({ op: "extra", text: b[j] }); j++ }
  }
  for (; i < n; i++) out.push({ op: "missing", text: a[i] })
  for (; j < m; j++) out.push({ op: "extra", text: b[j] })

  var matched = lcs[0][0]
  return { lines: out, same: matched === n && matched === m, matched: matched, total: n }
}

// One line saying how the typing compared, for above the diff.
function summary(result) {
  if (!result) return ""
  if (!result.total) return ""
  if (result.same) return "Matches the answer"
  var extra = result.lines.filter(function(l) { return l.op === "extra" }).length
  var parts = [result.matched + " of " + result.total + " lines match"]
  if (extra) parts.push(extra + " extra")
  return parts.join("  ·  ")
}

// Indent the selected lines of `text` by `width` spaces, or take up to that
// many away when `out`. `start` and `end` are the selection; returns the new
// text and selection, so an editor can apply it and keep what was selected.
function shiftLines(text, start, end, width, out) {
  var s = String(text)
  var from = s.lastIndexOf("\n", Math.max(0, start - 1)) + 1
  if (start === 0) from = 0
  var stop = s.indexOf("\n", Math.max(start, end - (end > start ? 1 : 0)))
  if (stop === -1) stop = s.length
  var lines = s.slice(from, stop).split("\n")
  var pad = new Array(width + 1).join(" ")
  var firstDelta = 0, total = 0
  lines = lines.map(function(l, n) {
    var d
    if (out) {
      var have = 0
      while (have < width && l.charAt(have) === " ") have++
      d = -have
      l = l.slice(have)
    } else {
      d = width
      l = pad + l
    }
    if (n === 0) firstDelta = d
    total += d
    return l
  })
  return {
    text: s.slice(0, from) + lines.join("\n") + s.slice(stop),
    start: Math.max(from, start + firstDelta),
    end: Math.max(from, end + total)
  }
}

// The indentation a new line should start with, after the line the cursor
// is on: the same, and one level more after a line ending in ":" (Python's
// blocks), "{", "(" or "[".
function autoIndent(text, cursor, width) {
  var s = String(text)
  var from = s.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1
  if (cursor === 0) from = 0
  var line = s.slice(from, cursor)
  var lead = line.match(/^ */)[0].length
  var trimmed = line.replace(/\s+$/, "")
  var opens = /[:{(\[]$/.test(trimmed)
  return new Array(lead + (opens ? width : 0) + 1).join(" ")
}

// ---------------------------------------------------------------------------
// Line Drill: a solution typed one line at a time into blanks, each line
// checked as it is submitted, with the hints following whichever pattern the
// lines so far are writing. A port of GleamDrill's line_drill.gleam.
//
// Every pattern of the card starts as a candidate. A submitted line is
// compared with the next blank of each candidate still alive; those it does
// not match drop out. The blanks on screen are the skeleton of the first
// candidate alive in the card's own order, so the canonical pattern leads
// until the typing says otherwise.
//
// The state is a plain object and never changed in place: every function
// returns a new one, so QML sees a new reference and rebinds.
//
//   patterns  the card's patterns (Anki.parsePattern), canonical first
//   alive     slugs still consistent with every line typed; never empty
//   typed     locked lines, oldest first, as typed (or as a reveal filled in)
//   revealed  { blank index: true } for lines revealed rather than typed
//   misses    { blank index: wrong submissions }
//   shown     { blank index: { hint, why } } opened before the line locked;
//             the explanation after a line locks is free and not counted
//   last      the blank most recently locked, or -1
//   picking   a slug proposed by lineCyclePick, waiting for a confirm, or ""

var LOCKED = "locked"      // matched, and every candidate alive agreed
var NARROWED = "narrowed"  // matched, and some candidates dropped out
var MISS = "miss"          // matched no candidate's next line

function copyMap(m) {
  var out = {}
  for (var k in m) out[k] = m[k]
  return out
}

function lineState(s, changes) {
  var out = {
    patterns: s.patterns, alive: s.alive, typed: s.typed, revealed: s.revealed,
    misses: s.misses, shown: s.shown, last: s.last, picking: s.picking
  }
  for (var k in changes) out[k] = changes[k]
  return out
}

function lineStart(patterns) {
  patterns = patterns || []
  return {
    patterns: patterns,
    alive: patterns.map(function(p) { return p.slug }),
    typed: [], revealed: {}, misses: {}, shown: {}, last: -1, picking: ""
  }
}

function findPattern(s, slug) {
  for (var i = 0; i < s.patterns.length; i++)
    if (s.patterns[i].slug === slug) return s.patterns[i]
  return null
}

// The pattern whose skeleton is on screen: the first one still alive.
function lineDisplayed(s) {
  for (var i = 0; i < s.patterns.length; i++)
    if (s.alive.indexOf(s.patterns[i].slug) >= 0) return s.patterns[i]
  return null
}

// The pattern the typing has settled on: one candidate left, of several.
function lineLockedIn(s) {
  if (s.alive.length !== 1 || s.patterns.length < 2) return null
  return findPattern(s, s.alive[0])
}

function alivePatterns(s) {
  return s.patterns.filter(function(p) { return s.alive.indexOf(p.slug) >= 0 })
}

// The step a blank sits under: that of its first note.
function blankStep(pattern, line) {
  var ids = line.notes || []
  for (var i = 0; i < ids.length; i++)
    for (var j = 0; j < pattern.notes.length; j++)
      if (pattern.notes[j].id === ids[i]) return pattern.notes[j].step
  return 0
}

function blanks(pattern) {
  return pattern.lines.filter(function(l) { return l.text !== undefined })
}

function blankAt(pattern, index) {
  var b = blanks(pattern)
  return index < b.length ? b[index] : null
}

function notesFor(pattern, ids) {
  return (ids || []).map(function(id) {
    for (var j = 0; j < pattern.notes.length; j++)
      if (pattern.notes[j].id === id) return pattern.notes[j]
    return null
  }).filter(Boolean)
}

// The index of the blank being typed: how many are locked.
function linePosition(s) {
  return s.typed.length
}

function lockLine(s, text, matching, index) {
  return lineState(s, {
    alive: matching.map(function(p) { return p.slug }),
    typed: s.typed.concat([text]),
    last: index,
    picking: ""
  })
}

// Submit the active blank's text. Returns { state, outcome }.
function lineSubmit(s, text) {
  var wanted = normalize(text)
  var index = linePosition(s)
  var matching = alivePatterns(s).filter(function(p) {
    var b = blankAt(p, index)
    return b !== null && normalize(b.text) === wanted
  })
  if (wanted === "") return { state: s, outcome: MISS }
  if (!matching.length) {
    var misses = copyMap(s.misses)
    misses[index] = (misses[index] || 0) + 1
    return { state: lineState(s, { misses: misses }), outcome: MISS }
  }
  return {
    state: lockLine(s, text, matching, index),
    outcome: matching.length === s.alive.length ? LOCKED : NARROWED
  }
}

// Fill the active blank with the displayed pattern's line, as a reveal.
// Candidates that would not have written that line drop out.
function lineReveal(s) {
  var index = linePosition(s)
  var shown = lineDisplayed(s)
  var b = shown ? blankAt(shown, index) : null
  if (!b) return s
  var matching = alivePatterns(s).filter(function(p) {
    var o = blankAt(p, index)
    return o !== null && normalize(o.text) === normalize(b.text)
  })
  var revealed = copyMap(s.revealed)
  revealed[index] = true
  return lineState(lockLine(s, b.text, matching, index), { revealed: revealed })
}

// How many of the typed lines, from the first, `pattern` would also have.
function fitting(pattern, typed) {
  var b = blanks(pattern)
  var n = 0
  while (n < typed.length && n < b.length && normalize(typed[n]) === normalize(b[n].text)) n++
  return n
}

function filterKeys(m, keep) {
  var out = {}
  for (var k in m) if (keep(Number(k))) out[k] = m[k]
  return out
}

// Commit to one pattern by hand. Typed lines that do not fit it are thrown
// away, from the first that does not on; what fits is kept.
function lineChoose(s, slug) {
  var pattern = findPattern(s, slug)
  if (!pattern) return s
  var kept = fitting(pattern, s.typed)
  return lineState(s, {
    alive: [slug],
    typed: s.typed.slice(0, kept),
    revealed: filterKeys(s.revealed, function(i) { return i < kept }),
    misses: filterKeys(s.misses, function(i) { return i <= kept }),
    shown: filterKeys(s.shown, function(i) { return i <= kept }),
    last: s.last >= 0 && s.last < kept ? s.last : -1,
    picking: ""
  })
}

// How many typed lines choosing `slug` would throw away.
function lineDroppedBy(s, slug) {
  var pattern = findPattern(s, slug)
  return pattern ? linePosition(s) - fitting(pattern, s.typed) : 0
}

// Propose the next pattern after the one proposed (or shown), in the card's
// order, wrapping. Nothing changes until lineConfirmPick.
function lineCyclePick(s) {
  var slugs = s.patterns.map(function(p) { return p.slug })
  if (!slugs.length) return s
  var shown = lineDisplayed(s)
  var from = s.picking || (shown ? shown.slug : "")
  var at = slugs.indexOf(from)
  var next = at >= 0 && at + 1 < slugs.length ? slugs[at + 1] : slugs[0]
  return lineState(s, { picking: next })
}

function lineConfirmPick(s) {
  return s.picking ? lineChoose(s, s.picking) : s
}

function lineCancelPick(s) {
  return lineState(s, { picking: "" })
}

// A blank's width, rounded up to four characters, so the shape of the line
// shows without its exact length.
function widthBucket(text) {
  return Math.ceil(String(text).length / 4) * 4
}

// The code column for the displayed pattern, one slot per line:
//   { kind: "given", text }
//   { kind: "locked", text, indent, revealed }   text is the pattern's own
//   { kind: "active", indent, width }
//   { kind: "blank", indent, width }
function lineSkeleton(s) {
  var shown = lineDisplayed(s)
  if (!shown) return []
  var done = linePosition(s)
  var index = 0
  return shown.lines.map(function(l) {
    if (l.text === undefined) return { kind: "given", text: l.given }
    var i = index++
    if (i < done) return { kind: "locked", text: l.text, indent: l.indent, revealed: !!s.revealed[i] }
    return { kind: i === done ? "active" : "blank", indent: l.indent, width: widthBucket(l.text) }
  })
}

// The active blank's notes, one entry per distinct way forward:
// { pattern, notes }. More than one is "N ways from here"; candidates whose
// next line is the same line are one way, under the first of them.
function lineCurrentNotes(s) {
  var index = linePosition(s)
  var ways = [], seen = []
  alivePatterns(s).forEach(function(p) {
    var b = blankAt(p, index)
    if (!b) return
    var key = normalize(b.text)
    if (seen.indexOf(key) >= 0) return
    seen.push(key)
    ways.push({ pattern: p, notes: notesFor(p, b.notes) })
  })
  return ways
}

// The line just locked and its notes, { index, notes }, or null: what is
// explained once a line is right. Free, unlike the hint for the next line.
function lineExplanation(s) {
  var shown = lineDisplayed(s)
  if (s.last < 0 || !shown) return null
  var b = blankAt(shown, s.last)
  return b ? { index: s.last, notes: notesFor(shown, b.notes) } : null
}

// The step the active blank sits under, { index, count, title }; the last
// blank's step once every blank is locked.
function lineCurrentStep(s) {
  var shown = lineDisplayed(s)
  if (!shown) return null
  var b = blanks(shown)
  if (!b.length) return null
  var at = Math.min(linePosition(s), b.length - 1)
  var step = blankStep(shown, b[at])
  if (step >= shown.steps.length) return null
  return { index: step, count: shown.steps.length, title: shown.steps[step] }
}

// The code so far: given and locked lines, in order, at their indentation.
// Complete, it is the displayed pattern's whole solution.
function lineAssembled(s) {
  var shown = lineDisplayed(s)
  if (!shown) return ""
  var done = linePosition(s)
  var index = 0, out = []
  shown.lines.forEach(function(l) {
    if (l.text === undefined) { out.push(l.given); return }
    if (index++ < done) out.push(new Array(l.indent + 1).join(" ") + l.text)
  })
  return out.join("\n")
}

// { done, total } for the displayed pattern.
function lineProgress(s) {
  var shown = lineDisplayed(s)
  return shown ? { done: linePosition(s), total: blanks(shown).length } : { done: 0, total: 0 }
}

function lineComplete(s) {
  var p = lineProgress(s)
  return p.total > 0 && p.done >= p.total
}

function lineMissesHere(s) {
  return s.misses[linePosition(s)] || 0
}

// Open the active blank's hint (`hint` true) or why. Counts as help.
function lineShowNote(s, hint) {
  var index = linePosition(s)
  var had = s.shown[index] || { hint: false, why: false }
  var shown = copyMap(s.shown)
  shown[index] = { hint: hint ? true : had.hint, why: hint ? had.why : true }
  return lineState(s, { shown: shown })
}

function lineShownHere(s) {
  return s.shown[linePosition(s)] || { hint: false, why: false }
}

// A hint or a why was opened for some line before it was typed.
function lineHelpUsed(s) {
  return Object.keys(s.shown).length > 0
}

// Some line was revealed rather than typed.
function lineAnyRevealed(s) {
  return Object.keys(s.revealed).length > 0
}

// The pattern free-typed code is most like: the largest share of its blank
// lines present in the text, ties to the earlier (canonical) one; "" when
// nothing typed matches any line.
function lineDetect(patterns, editorText) {
  var typed = {}
  String(editorText || "").split("\n").forEach(function(l) {
    var n = normalize(l)
    if (n) typed[n] = true
  })
  var best = null
  ;(patterns || []).forEach(function(p) {
    var b = blanks(p)
    var hits = b.filter(function(l) { return typed[normalize(l.text)] }).length
    if (!hits) return
    if (!best || hits * best.total > best.hits * b.length) best = { slug: p.slug, hits: hits, total: b.length }
  })
  return best ? best.slug : ""
}
