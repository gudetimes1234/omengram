# Drills in the bar

Practise code the way GleamDrill does, from the Omarchy bar and overlay, with
no server: type the answer before you see it, compare what you typed with the
solution, run it against test cases on the laptop, and learn a new solution
one line at a time. Native cards move from SM-2 to FSRS-6, and every answer
goes into a review log, so the statistics are real.

GleamDrill (a separate project) is where the pieces come from: its FSRS-6 is
ported and tested against the same py-fsrs vectors, its line matcher is
ported, and its content is imported into omengram's own deck format. omengram
never needs GleamDrill installed or running.

## What changes for the user

- **Drill cards.** A deck card can be a `type` card (type a text answer) or a
  `code` card (type code in a language). Plain cards are unchanged.
- **Typing.** In the overlay, a drill card opens an editor. Ctrl+Enter checks:
  the solution appears beside a line diff of what you typed. You still grade
  yourself; the diff and the tests are feedback, never a grade.
- **Running.** A code card with a harness has Ctrl+R: your code runs against
  its test cases in a sandbox, and each case shows pass or fail.
- **Line Drill.** A card with patterns is learnt line by line: each line is a
  blank to type, with a hint and a why for it, step by step. New and
  relearning cards open in Line Drill; review cards are typed whole.
- **The bar panel** is too small for an editor. It shows drill cards as
  recall: the prompt, then the solution and its notes.
- **FSRS-6.** Native cards are scheduled by FSRS-6 (retention 0.9). Existing
  progress carries over: no card restarts.
- **Review log.** Each answer is a line in a monthly log. Retention in the
  statistics is the share of reviews in the last 30 days not graded Again.
- **GleamDrill content.** `tools/import_gleamdrill.py` turns a GleamDrill
  checkout into decks under `Drills/`.
- Anki cards are unchanged: Anki schedules them, and they show as text.

## Rules

- Grading is always yours. Nothing grades a card automatically.
- Code runs only inside bubblewrap: no network, no home directory, a read-only
  `/usr`, a private `/tmp`, an 8 second wall clock and limits on memory, CPU,
  file size and open files. Without bubblewrap, running is refused; there is
  no unsandboxed fallback.
- Typing never reaches the overlay's own keys: digits, `a` and the rest are
  text while the editor has focus. Esc gives the keys back.
- The log is only ever appended to. Undo appends an undo record.
- The log is separate from the progress file and never goes through its
  read-merge-write.
- An imported deck carries `"source": "gleamdrill-import"`. The importer never
  overwrites a deck without it.

## Card format

All new fields are optional; a deck without them works as before.

```json
{
  "id": "gd:python:two_sum",
  "kind": "code",
  "lang": "python",
  "front": "Two Sum\n\nReturn the indices of the two numbers that add up to target.",
  "back": "Signal, invariant, trade, trap: the notes.",
  "answer": "def twoSum(nums, target):\n    ...",
  "alternates": [{ "label": "Brute force", "answer": "..." }],
  "harness": "__case__(\"twoSum([2, 7], 9)\", [0, 1], twoSum([2, 7], 9))",
  "complexity": "O(n) time · O(n) space",
  "nudge": "What do you need to remember about the numbers already seen?",
  "patterns": [{
    "slug": "hash-map", "name": "Hash map", "complexity": "...", "nudge": "...",
    "steps": ["Remember what you have seen"],
    "notes": [{ "id": 1, "step": 0, "pseudo": "seen = empty map", "hint": "...", "why": "..." }],
    "lines": [{ "given": "def twoSum(nums, target):" },
              { "text": "seen = {}", "indent": 4, "notes": [1] }]
  }],
  "tags": ["arrays-hashing"]
}
```

- `kind`: `basic` (default), `type` (compared with `back`), `code` (compared
  with `answer`). An unknown kind is treated as `basic`.
- Line Drill is offered whenever a card has `patterns`. A language-neutral
  card uses `"lang": "pseudo"` and types the pseudocode itself.

## Storage

- Progress stays in `~/.local/state/omarchy/omengram.json`; a card's state
  gains `stability`, `difficulty` and `lastReview`.
- The log is `~/.local/state/omarchy/omengram/reviews-YYYY-MM.jsonl`, one JSON
  object per line.

## Milestones

1. PRD and epic
2. FSRS-6 for native cards, with the py-fsrs vectors and migration from SM-2
3. Review log and statistics from it
4. Drill card format, the GleamDrill importer and monospace code
5. Typed answers and the diff (overlay)
6. Running tests locally in a sandbox (overlay)
7. Line Drill (overlay)
8. Docs and landing on this machine
