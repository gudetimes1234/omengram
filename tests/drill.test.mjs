// Drill tests: comparing typed answers, and the editor's helpers.
//
//   node tests/drill.test.mjs

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
export function loadDrill() {
  const src = readFileSync(join(here, "..", "Drill.js"), "utf8").replace(/^\.pragma library$/m, "")
  const names = [...src.matchAll(/^(?:function|var) ([A-Za-z_]\w*)/gm)].map((m) => m[1])
  const D = {}
  new Function("exports", `${src}\nfor (const k of ${JSON.stringify(names)}) exports[k] = eval(k)`)(D)
  return D
}
const D = loadDrill()

let pass = 0, fail = 0
const t = (name, cond) => {
  if (cond) { pass++; console.log("  ok   " + name) }
  else { fail++; console.log("  FAIL " + name) }
}
const group = (name) => console.log("\n" + name)
const ops = (r) => r.lines.map((l) => l.op[0]).join("")

group("a line as it is compared")
{
  t("runs of spaces and tabs are one space", D.normalize("a  =\t\tb") === "a = b")
  t("trimmed", D.normalize("   x = 1   ") === "x = 1")
  t("a trailing ; or , is ignored", D.normalize("x = 1;") === "x = 1" && D.normalize("f(a, b) ,") === "f(a, b)")
  t("but not one inside", D.normalize("a;b") === "a;b")
  t("nothing is nothing", D.normalize(undefined) === "" && D.normalize(null) === "")
  t("indentation counts tabs as four", D.indentOf("\t  x") === 6)
}

group("the diff")
{
  const answer = "def f(xs):\n    total = 0\n    for x in xs:\n        total += x\n    return total"
  const same = D.diff(answer, answer + "\n\n")
  t("an exact answer matches, trailing blank lines aside", same.same && same.matched === 5 && same.total === 5)
  t("spacing inside a line does not matter", D.diff("x = 1", "x  =  1").same)
  t("but spaces that change the tokens do", !D.diff("x = 1", "x=1").same)
  t("blank lines are ignored", D.diff("a\n\nb", "a\nb").same)
  t("in code, indentation is part of the line", !D.diff("if x:\n    y", "if x:\ny").same)
  t("in a typed answer it is not", D.diff("Paris", "  Paris", { indent: false }).same)

  const r = D.diff(answer, "def f(xs):\n    total = 0\n    for x in xs: total += x\n    return total")
  t("a line written differently is missing and extra", ops(r) === "ssmmes")
  t("counted against the answer", r.matched === 3 && r.total === 5 && !r.same)
  t("the summary says so", D.summary(r) === "3 of 5 lines match  ·  1 extra")
  t("and when it all matches", D.summary(same) === "Matches the answer")
  t("nothing typed is every line missing", ops(D.diff(answer, "")) === "mmmmm")
  t("the lines carry their own text", D.diff("a", "b").lines.map((l) => l.text).join() === "a,b")
  t("an empty answer has no summary", D.summary(D.diff("", "x")) === "" && D.summary(null) === "")
}

group("indenting in the editor")
{
  const r = D.shiftLines("a\nb\nc", 2, 3, 4, false)
  t("tab indents the line the selection is on", r.text === "a\n    b\nc" && r.start === 6 && r.end === 7)
  const many = D.shiftLines("a\nb\nc", 0, 5, 4, false)
  t("and every selected line", many.text === "    a\n    b\n    c")
  const out = D.shiftLines("    a\n  b\nc", 0, 9, 4, true)
  t("shift+tab takes up to one level away", out.text === "a\nb\nc")
  t("selection follows the text", out.start === 0 && out.end === 3)
  t("a selection ending at the start of a line leaves that line alone",
    D.shiftLines("a\nb", 0, 2, 4, false).text === "    a\nb")

  t("a new line keeps the indent", D.autoIndent("    x = 1", 9, 4) === "    ")
  t("one more after a colon", D.autoIndent("    for x in xs:", 16, 4) === "        ")
  t("and after an opening bracket", D.autoIndent("f(", 2, 4) === "    " && D.autoIndent("x = {", 5, 4) === "    ")
  t("only the line the cursor is on", D.autoIndent("if a:\nb", 7, 4) === "")
}


// Made-up patterns. `spill` has two ways to the same answer, and their first
// lines differ; `forked` has two whose first lines are the same line.
const note = (id, step = 0) => ({ id, step, pseudo: "p" + id, hint: "h" + id, why: "w" + id })
const spill = [
  { slug: "two-pointers", name: "Two pointers", steps: ["Set up", "Walk inwards"],
    notes: [note(1), note(2, 1), note(3, 1)],
    lines: [{ given: "def spill(cups):" },
            { text: "lo, hi = 0, len(cups) - 1", indent: 4, notes: [1] },
            { text: "while lo < hi:", indent: 4, notes: [2] },
            { text: "lo, hi = lo + 1, hi - 1", indent: 8, notes: [3] },
            { given: "" },
            { text: "return lo", indent: 4, notes: [3] }] },
  { slug: "prefix", name: "Prefix sums", steps: ["Sum"],
    notes: [note(1), note(2)],
    lines: [{ given: "def spill(cups):" },
            { text: "sums = []", indent: 4, notes: [1] },
            { text: "return len(sums)", indent: 4, notes: [2] }] },
]
const forked = [
  { slug: "a", name: "A", steps: ["Only"], notes: [note(1), note(2)],
    lines: [{ given: "def f(xs):" }, { text: "n = len(xs)", indent: 4, notes: [1] }, { text: "return n", indent: 4, notes: [2] }] },
  { slug: "b", name: "B", steps: ["Only"], notes: [note(1), note(2)],
    lines: [{ given: "def f(xs):" }, { text: "n = len(xs)", indent: 4, notes: [1] }, { text: "return n * 2", indent: 4, notes: [2] }] },
]
const texts = (p) => p.lines.filter((l) => l.text !== undefined).map((l) => l.text)
const typeAll = (s, lines) => lines.reduce((st, l) => D.lineSubmit(st, l).state, s)

group("line drill: typing a pattern")
{
  let s = D.lineStart([spill[0]])
  t("nothing typed yet", D.lineProgress(s).done === 0 && D.lineProgress(s).total === 4)
  let ok = true
  for (const line of texts(spill[0])) {
    const r = D.lineSubmit(s, "  " + line + "  ")
    ok = ok && r.outcome === D.LOCKED
    s = r.state
  }
  t("each line locks, however it is spaced", ok && D.lineComplete(s))
  t("no reveals, no help", !D.lineAnyRevealed(s) && !D.lineHelpUsed(s))
  t("the assembled code is the solution, given lines and all",
    D.lineAssembled(s) === "def spill(cups):\n    lo, hi = 0, len(cups) - 1\n    while lo < hi:\n        lo, hi = lo + 1, hi - 1\n\n    return lo")
  t("the state handed in is never changed", D.lineStart([spill[0]]).typed.length === 0)
}

group("line drill: misses")
{
  let r = D.lineSubmit(D.lineStart(spill), "lo = 0")
  t("a wrong line is a miss and locks nothing", r.outcome === D.MISS && D.linePosition(r.state) === 0 && D.lineMissesHere(r.state) === 1)
  r = D.lineSubmit(r.state, "nope")
  t("misses add up on the blank", D.lineMissesHere(r.state) === 2)
  const blank = D.lineSubmit(D.lineStart(spill), "   ")
  t("an empty line is not counted", blank.outcome === D.MISS && D.lineMissesHere(blank.state) === 0)
}

group("line drill: following the typing between patterns")
{
  let s = D.lineStart(spill)
  t("the canonical pattern leads", D.lineDisplayed(s).slug === "two-pointers" && D.lineLockedIn(s) === null)
  const r = D.lineSubmit(s, "sums = []")
  t("the other pattern's first line narrows to it", r.outcome === D.NARROWED && D.lineDisplayed(r.state).slug === "prefix")
  t("and locks it in", D.lineLockedIn(r.state).slug === "prefix")

  s = D.lineStart(forked)
  t("one way while the next lines agree", D.lineCurrentNotes(s).length === 1)
  const same = D.lineSubmit(s, "n = len(xs)")
  t("a line both have keeps both", same.outcome === D.LOCKED && same.state.alive.length === 2 && D.lineLockedIn(same.state) === null)
  t("then two ways from here", D.lineCurrentNotes(same.state).length === 2)
  const end = D.lineSubmit(same.state, "return n * 2")
  t("the line only one has narrows to it", end.outcome === D.NARROWED && end.state.alive.join() === "b" && D.lineComplete(end.state))
  t("a single pattern is never 'locked in'", D.lineLockedIn(D.lineStart([spill[0]])) === null)
}

group("line drill: reveals, hints and the explanation")
{
  let s = D.lineReveal(D.lineStart(spill))
  t("revealing fills the blank, as a reveal", D.linePosition(s) === 1 && D.lineAnyRevealed(s))
  const locked = D.lineSkeleton(s).filter((x) => x.kind !== "given")
  t("shown as revealed", locked[0].kind === "locked" && locked[0].revealed === true)
  t("candidates that would not have written it drop out", s.alive.join() === "two-pointers")

  s = D.lineSubmit(D.lineStart(spill), "lo, hi = 0, len(cups) - 1").state
  const ex = D.lineExplanation(s)
  t("the line just locked is explained, for free", ex && ex.index === 0 && ex.notes[0].id === 1 && !D.lineHelpUsed(s))
  s = D.lineShowNote(s, true)
  t("opening the hint counts as help", D.lineShownHere(s).hint && !D.lineShownHere(s).why && D.lineHelpUsed(s))
  s = D.lineShowNote(s, false)
  t("and the why, keeping the hint open", D.lineShownHere(s).hint && D.lineShownHere(s).why)
  t("help is not a reveal", !D.lineAnyRevealed(s))
}

group("line drill: choosing a pattern")
{
  const typed = D.lineSubmit(D.lineStart(spill), "lo, hi = 0, len(cups) - 1").state
  t("switching would drop what does not fit", D.lineDroppedBy(typed, "prefix") === 1 && D.lineDroppedBy(typed, "two-pointers") === 0)
  let s = D.lineCyclePick(D.lineStart(spill))
  t("p proposes the next pattern", s.picking === "prefix")
  s = D.lineCyclePick(s)
  t("and wraps around", s.picking === "two-pointers")
  t("cancelling changes nothing", D.lineCancelPick(s).picking === "" && D.lineCancelPick(s).alive.length === 2)
  const chosen = D.lineConfirmPick(D.lineCyclePick(typed))
  t("confirming commits to it, dropping what did not fit", chosen.alive.join() === "prefix" && D.linePosition(chosen) === 0)
  t("what fits is kept", D.linePosition(D.lineChoose(typed, "two-pointers")) === 1)
  t("an unknown pattern changes nothing", D.lineChoose(typed, "nope") === typed)
}

group("line drill: the code column")
{
  const s = D.lineSubmit(D.lineStart(spill), "lo, hi = 0, len(cups) - 1").state
  const sk = D.lineSkeleton(s)
  t("given, locked, active, then blanks", sk.map((x) => x.kind).join() === "given,locked,active,blank,given,blank")
  t("blanks are as wide as their line, rounded up to four", sk[2].width === 16 && sk[3].width === 24 && sk.every((x) => x.width === undefined || x.width % 4 === 0))
  t("a locked line shows the pattern's own text", sk[1].text === "lo, hi = 0, len(cups) - 1" && sk[1].indent === 4)
  let step = D.lineCurrentStep(D.lineStart(spill))
  t("the step follows the active blank", step.index === 0 && step.count === 2 && step.title === "Set up")
  step = D.lineCurrentStep(s)
  t("into the next step", step.index === 1 && step.title === "Walk inwards")
  const done = typeAll(D.lineStart([spill[0]]), texts(spill[0]))
  t("the last step once complete", D.lineCurrentStep(done).index === 1)
}

group("line drill: which pattern free typing is writing")
{
  t("the one with most of its lines typed", D.lineDetect(spill, "def spill(cups):\n    sums = []\n") === "prefix")
  t("nothing matching is nothing", D.lineDetect(spill, "def spill(cups):\n") === "")
  t("the other way", D.lineDetect(spill, "while lo < hi:\n  return lo") === "two-pointers")
}

group("line drill: properties")
{
  // A small seeded generator, so a failure is the same failure next time.
  let seed = 20261127
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
  const sets = [spill, forked, [spill[0]]]

  let assembled = true
  for (let i = 0; i < 200; i++) {
    const patterns = sets[rand(sets.length)]
    const p = patterns[rand(patterns.length)]
    const pad = " ".repeat(rand(4))
    const s = typeAll(D.lineChoose(D.lineStart(patterns), p.slug), texts(p).map((l) => pad + l + pad))
    const want = p.lines.map((l) => l.text === undefined ? l.given : " ".repeat(l.indent) + l.text).join("\n")
    assembled = assembled && D.lineComplete(s) && D.lineAssembled(s) === want
  }
  t("typing a pattern's every line gives that pattern's code", assembled)

  let only = true, shrink = true
  for (let i = 0; i < 300; i++) {
    const patterns = sets[rand(sets.length)]
    const pool = ["junk line", ""].concat(...patterns.map(texts))
    let s = D.lineStart(patterns)
    for (let k = 0; k < 12; k++) {
      const text = pool[rand(pool.length)]
      const before = s
      const r = D.lineSubmit(s, text)
      s = r.state
      shrink = shrink && s.alive.length > 0 && s.alive.every((slug) => before.alive.includes(slug))
      if (r.outcome === D.MISS) only = only && s.typed.length === before.typed.length
      else {
        const at = before.typed.length
        only = only && patterns.some((p) => before.alive.includes(p.slug)
          && texts(p)[at] !== undefined && D.normalize(texts(p)[at]) === D.normalize(text))
      }
    }
  }
  t("a line locks only where some candidate expected it", only)
  t("candidates only shrink, and never to none", shrink)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
