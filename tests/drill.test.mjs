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

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
