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
