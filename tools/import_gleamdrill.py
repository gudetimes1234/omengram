#!/usr/bin/env python3
"""Turn a GleamDrill checkout's drills into omengram decks.

    python3 tools/import_gleamdrill.py ~/github/gleamdrill
    python3 tools/import_gleamdrill.py ~/github/gleamdrill --out DIR --dry-run

Each NeetCode problem becomes one code card: the prompt on the front, the
notes on the back, the reference solution as the answer, the other solutions
as alternates, the test harness, and the Line Drill patterns. One deck per
problem group, under Drills/python/ in the library.

GleamDrill stays the source: this reads its files and writes omengram's, and
can be run again to pick up its changes. A deck it writes carries
"source": "gleamdrill-import", and a deck without that marker is never
overwritten, so a hand-made deck of the same name is safe.

Only Python for now; the language is a parameter so others can follow.
"""

import argparse
import json
import os
import re
import sys

SOURCE = "gleamdrill-import"
# Below the plugin's 256 KiB read cap, with room for growth.
DECK_BUDGET = 200 * 1024
LANGS = {"python": {"ext": "py", "marker": "#"}}


# ---------------------------------------------------------------- catalogue

GLEAM_ESCAPES = {'"': '"', "\\": "\\", "n": "\n", "t": "\t", "r": "\r", "f": "\f"}


def gleam_string(src, i):
    """Read the Gleam string literal starting at src[i] == '"'. Returns (text, end)."""
    assert src[i] == '"'
    out, i = [], i + 1
    while True:
        c = src[i]
        if c == '"':
            return "".join(out), i + 1
        if c == "\\":
            n = src[i + 1]
            if n == "u":
                close = src.index("}", i)
                out.append(chr(int(src[i + 3:close], 16)))
                i = close + 1
                continue
            out.append(GLEAM_ESCAPES.get(n, n))
            i += 2
            continue
        out.append(c)
        i += 1


def parse_catalog(path):
    """The NeetCode listing: [(group, [ {title, prompt, stem, difficulty} ])]."""
    with open(path, encoding="utf-8") as f:
        src = f.read()
    body = src[src.index("pub fn groups()"):]
    groups = []
    token = re.compile(r'Group\(\s*"|Drill\(\s*"')
    pos = 0
    while True:
        m = token.search(body, pos)
        if not m:
            break
        start = m.end() - 1
        if m.group().startswith("Group"):
            name, pos = gleam_string(body, start)
            groups.append((name, []))
            continue
        fields = []
        pos = start
        for _ in range(3):
            while body[pos] != '"':
                pos += 1
            value, pos = gleam_string(body, pos)
            fields.append(value)
        diff = re.match(r"\s*,\s*(Easy|Medium|Hard)", body[pos:])
        if not diff or not groups:
            raise SystemExit(f"catalog.gleam: cannot read the drill after {fields[0]!r}")
        title, prompt, stem = fields
        groups[-1][1].append({"title": title, "prompt": prompt, "stem": stem,
                              "difficulty": diff.group(1).lower()})
    if not groups:
        raise SystemExit("catalog.gleam: no groups found")
    return groups


# -------------------------------------------------------------------- files

def read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return None


def parse_note(raw):
    """A notes file: @directives, then the prose."""
    meta, prose = {}, []
    for line in (raw or "").splitlines():
        m = re.match(r"@(\S+)\s*(.*)$", line)
        if m and not prose:
            meta[m.group(1)] = m.group(2).strip()
        else:
            prose.append(line)
    return meta, "\n".join(prose).strip()


def slug(title):
    s = re.sub(r"[^a-z0-9]", "-", title.lower())
    return re.sub(r"-+", "-", s).strip("-")


def approach_nudge(raw):
    if not raw:
        return ""
    m = re.search(r"^== nudge\n(.*?)(?=^== |\Z)", raw, re.S | re.M)
    return m.group(1).strip() if m else ""


def parse_patterns(raw, vocab):
    """drills/patterns/<stem>.txt: every pattern a problem is solved with."""
    patterns, cur, note = {}, None, None
    for line in (raw or "").splitlines():
        if line.startswith("== pattern "):
            s = line[len("== pattern "):].strip()
            cur = {"slug": s, "name": vocab.get(s, s), "complexity": "", "nudge": "",
                   "steps": [], "notes": []}
            patterns[s] = cur
            note = None
        elif cur is None:
            continue
        elif line.startswith("complexity:"):
            cur["complexity"] = line.split(":", 1)[1].strip()
        elif line.startswith("nudge:"):
            cur["nudge"] = line.split(":", 1)[1].strip()
        elif line.startswith("-- step "):
            cur["steps"].append(line[len("-- step "):].strip())
        elif re.match(r"^\s+hint:", line) and note:
            note["hint"] = line.split(":", 1)[1].strip()
        elif re.match(r"^\s+why:", line) and note:
            note["why"] = line.split(":", 1)[1].strip()
        else:
            m = re.match(r"^(\d+) (.*)$", line)
            if m:
                note = {"id": int(m.group(1)), "step": max(0, len(cur["steps"]) - 1),
                        "pseudo": m.group(2).rstrip(), "hint": "", "why": ""}
                cur["notes"].append(note)
    return patterns


TAG = re.compile(r"^(.*?)\s+# @([\d,\s]+)$")


def code_lines(source, marker):
    """A tagged solution as given and typed lines, as GleamDrill builds them:
    full-line comments dropped, runs of blank lines squeezed to one."""
    out = []
    for raw in source.splitlines():
        line = raw.rstrip()
        if line.lstrip().startswith(marker):
            continue
        m = TAG.match(line)
        ids = [int(x) for x in m.group(2).replace(" ", "").split(",") if x] if m else []
        if m and ids and m.group(1).strip():
            code = m.group(1).rstrip()
            text = code.lstrip()
            out.append({"text": text, "indent": len(code) - len(text), "notes": ids})
        else:
            out.append({"given": line})
    squeezed = []
    for l in out:
        if l.get("given") == "" and (not squeezed or squeezed[-1].get("given") == ""):
            continue
        squeezed.append(l)
    while squeezed and squeezed[-1].get("given") == "":
        squeezed.pop()
    return squeezed


def strip_tags(source):
    return "\n".join((TAG.match(l.rstrip()).group(1).rstrip() if TAG.match(l.rstrip()) else l.rstrip())
                     for l in source.splitlines()).strip("\n")


# -------------------------------------------------------------------- cards

def card_for(root, lang, drill, vocab):
    L = LANGS[lang]
    stem = drill["stem"]
    sols = os.path.join(root, "drills", lang, "solutions")
    primary = read(os.path.join(sols, f"{stem}.{L['ext']}"))
    if primary is None:
        return None
    meta, prose = parse_note(read(os.path.join(root, "drills", "notes", f"{stem}.txt")))

    variants = []
    for name in sorted(os.listdir(sols)):
        if name.startswith(stem + "__") and name.endswith("." + L["ext"]):
            v = name[len(stem) + 2:-len(L["ext"]) - 1]
            vmeta, vprose = parse_note(read(os.path.join(root, "drills", "notes", f"{stem}__{v}.txt")))
            variants.append((int(vmeta.get("order", "99") or 99), v, vmeta, vprose,
                             read(os.path.join(sols, name))))
    variants.sort()

    patterns_raw = read(os.path.join(root, "drills", "patterns", f"{stem}.txt"))
    pattern_docs = parse_patterns(patterns_raw, vocab)
    patterns = []
    # The primary solution and each variant can claim a pattern; the claim is
    # what pairs that file's tagged lines with the pattern's pseudocode.
    for m, src in [(meta, primary)] + [(vm, vs) for _, _, vm, _, vs in variants]:
        s = m.get("pattern")
        if s and s in pattern_docs and not any(p["slug"] == s for p in patterns):
            lines = code_lines(src, L["marker"])
            if any("text" in l for l in lines):
                patterns.append(dict(pattern_docs[s], lines=lines))

    harness = read(os.path.join(root, "drills", lang, "harnesses", f"{stem}.{L['ext']}"))
    nudge = approach_nudge(read(os.path.join(root, "drills", "approaches", slug(drill["title"]) + ".txt")))

    card = {
        "id": f"gd:{lang}:{stem}",
        "kind": "code",
        "lang": lang,
        "front": drill["title"] + "\n\n" + drill["prompt"],
        "back": prose,
        "answer": strip_tags(primary),
        "complexity": meta.get("big-o", ""),
        "tags": ["neetcode", drill["difficulty"]],
    }
    if meta.get("kind"):
        card["label"] = meta["kind"]
    alternates = [{"label": vm.get("kind", v.replace("_", " ")), "answer": strip_tags(vs),
                   "complexity": vm.get("big-o", ""), "note": vp}
                  for _, v, vm, vp, vs in variants]
    if alternates:
        card["alternates"] = alternates
    if harness:
        card["harness"] = harness.rstrip() + "\n"
    if nudge:
        card["nudge"] = nudge
    if patterns:
        card["patterns"] = patterns
    return card


def size(doc):
    return len(json.dumps(doc, ensure_ascii=False, indent=1).encode("utf-8"))


def decks_for(root, lang):
    vocab = {}
    for line in (read(os.path.join(root, "drills", "patterns", "VOCAB")) or "").splitlines():
        if "\t" in line:
            k, v = line.split("\t", 1)
            vocab[k.strip()] = v.strip()

    decks = []
    for group, drills in parse_catalog(os.path.join(root, "src", "gleamdrill", "content", "problems",
                                                    "catalog.gleam")):
        cards = [c for c in (card_for(root, lang, d, vocab) for d in drills) if c]
        for c in cards:
            c["tags"].append(slug(group))
        if not cards:
            continue
        # Split a group that would not fit under the cap, in catalogue order.
        parts, cur = [], []
        for c in cards:
            if cur and size({"source": SOURCE, "cards": cur + [c]}) > DECK_BUDGET:
                parts.append(cur)
                cur = []
            cur.append(c)
        parts.append(cur)
        for n, part in enumerate(parts, 1):
            name = slug(group) + ("" if len(parts) == 1 else f"-{n}")
            decks.append((name, {"source": SOURCE, "group": group, "cards": part}))
    return decks


def ours(path):
    raw = read(path)
    if raw is None:
        return True
    try:
        return json.loads(raw).get("source") == SOURCE
    except (ValueError, AttributeError):
        return False


def write(path, doc):
    tmp = os.path.join(os.path.dirname(path), "." + os.path.basename(path) + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
        f.write("\n")
    os.replace(tmp, path)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("gleamdrill", help="a GleamDrill checkout")
    ap.add_argument("--lang", default="python", choices=sorted(LANGS))
    ap.add_argument("--out", help="where the decks go (default: ~/.local/share/omengram/Drills/<lang>)")
    ap.add_argument("--dry-run", action="store_true", help="say what would be written, write nothing")
    a = ap.parse_args(argv)

    out = a.out or os.path.join(os.path.expanduser("~"), ".local", "share", "omengram", "Drills", a.lang)
    decks = decks_for(os.path.expanduser(a.gleamdrill), a.lang)

    refused = [n for n, _ in decks if not ours(os.path.join(out, n + ".json"))]
    if refused:
        print("not overwriting decks this did not write: " + ", ".join(refused), file=sys.stderr)
        return 1

    total = sum(len(d["cards"]) for _, d in decks)
    lines = sum(1 for _, d in decks for c in d["cards"] if c.get("patterns"))
    if not a.dry_run:
        os.makedirs(out, mode=0o700, exist_ok=True)
    for name, doc in decks:
        print(f"  {name}.json  {len(doc['cards'])} cards  {size(doc) // 1024} KiB")
        if not a.dry_run:
            write(os.path.join(out, name + ".json"), doc)
    print(f"{'would write' if a.dry_run else 'wrote'} {total} cards in {len(decks)} decks to {out}"
          f" ({lines} with Line Drill)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
