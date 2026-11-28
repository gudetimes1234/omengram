#!/usr/bin/env python3
"""Copy an Anki collection into omengram's deck library, once.

    tools/import_anki.py                       # into ~/.local/share/omengram
    tools/import_anki.py --dry-run
    tools/import_anki.py --force               # replace files already there
    tools/import_anki.py --apkg shared.apkg    # a deck someone sent you

Each Anki deck becomes a file and `::` becomes a folder, so the tree in Anki is
the tree in the picker. Cards are rendered through their own templates, which is
what makes custom note types and clozes come out right, and flattened to plain
text, which is all omengram draws. Tags come along, apart from Anki's own `leech`
and `marked`.

Scheduling does not: every card starts as new, on omengram's schedule, and nothing
is ever written back. The collection is copied to a private temporary directory
and only that copy is opened. Anki has to be closed, because a copy taken while
it is writing might not be a whole one.

Every card carries an id made from its note, so importing again, or moving a
deck's file, keeps the progress made on it here.

An .apkg (a deck exported from Anki or downloaded from AnkiWeb) is read the
same way: Anki's own importer loads it into a new, empty collection in the
temporary directory, and the cards come out of that. Anki can stay open for
this, since its collection is not read at all.

Needs Anki's Python library; the official Linux build's own is used if it is at
/usr/local/share/anki (or $OMENGRAM_ANKI_DIR).
"""

import argparse
import html
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from html.parser import HTMLParser

ANKI_DIR = os.environ.get("OMENGRAM_ANKI_DIR", "/usr/local/share/anki")
ANKI_BASE = os.path.expanduser("~/.local/share/Anki2")

# omengram reads at most 256 KiB of a file, so a deck is split before it gets
# there. The other parts become children of the first, which keeps the deck one
# thing to pick.
PART_LIMIT = 250_000
DROP_TAGS = {"leech", "marked"}


# ------------------------------------------------------------------- text
#
# Anki renders cards as HTML for a web view. omengram draws plain text, so the
# rendered question and answer are flattened: styles and scripts dropped, block
# elements turned into line breaks, list items into bullets, media into a
# marker so a card that relies on an image does not look silently empty.

_DROP = re.compile(r"(?is)<(style|script|head|textarea|button|select|template)\b.*?</\1\s*>")
# Elements a template keeps hidden until its own script reveals them (a
# "you typed" pane, say). Not nesting-aware, which is fine for the shallow
# markup templates use.
_HIDDEN = re.compile(r"(?is)<(\w+)\b[^>]*\shidden\b[^>]*>.*?</\1\s*>")
_VOID_DROP = re.compile(r"(?i)<input\b[^>]*>")
_COMMENT = re.compile(r"(?s)<!--.*?-->")
_PRE = re.compile(r"(?is)<pre\b[^>]*>(.*?)</pre\s*>")
_BREAK = re.compile(r"(?i)<br\s*/?>|<hr\b[^>]*>")
_BLOCKS = "p|div|h[1-6]|tr|blockquote|ul|ol|table|section|article|header|footer|dl|dt|dd|figure|figcaption"
_BLOCK_END = re.compile(r"(?i)</(%s)\s*>" % _BLOCKS)
_BLOCK_START = re.compile(r"(?i)<(%s)\b[^>]*>" % _BLOCKS)
_LI = re.compile(r"(?i)<li\b[^>]*>")
_CELL = re.compile(r"(?i)</t[dh]\s*>")
_IMG = re.compile(r"(?i)<img\b[^>]*>")
_TAG = re.compile(r"<[^>]+>")
# Rendering turns [sound:x] into a play marker of Anki's own.
_SOUND = re.compile(r"\[(?:sound|anki:play):[^\]]*\]")
_ANSWER_SPLIT = re.compile(r"(?i)<hr[^>]*\bid\s*=\s*[\"']?answer[\"']?[^>]*>")

# Placeholders that survive tag stripping and whitespace collapsing.
_NL = "\x00"     # a line break from markup
_BLK = "\x01"    # a block edge; adjacent ones merge into one line break
_PRE_MARK = "\x02%d\x02"


class _TypingBox(HTMLParser):
    """Where the block around a typing box starts and ends.

    Some note types put a scratch box on the question, with its own caption and
    key hints beside it. The box means nothing here and neither does what
    labels it, so the block holding it goes with it.
    """

    BLOCKS = {"div", "section", "form", "fieldset"}

    def __init__(self, markup):
        super().__init__(convert_charrefs=False)
        self.lines = [0]
        for line in markup.splitlines(keepends=True):
            self.lines.append(self.lines[-1] + len(line))
        self.open, self.wanted, self.spans = [], set(), []
        self.feed(markup)

    def at(self):
        line, col = self.getpos()
        return self.lines[line - 1] + col

    def handle_starttag(self, tag, attrs):
        if tag in self.BLOCKS:
            self.open.append((tag, self.at()))
        elif tag == "textarea" and self.open:
            self.wanted.add(self.open[-1])

    def handle_endtag(self, tag):
        if tag not in self.BLOCKS:
            return
        for i in range(len(self.open) - 1, -1, -1):
            if self.open[i][0] == tag:
                if self.open[i] in self.wanted:
                    self.spans.append((self.open[i][1], self.at() + len("</%s>" % tag)))
                del self.open[i:]
                return


def drop_typing_boxes(markup):
    if "<textarea" not in markup.lower():
        return markup
    out = markup
    for start, end in sorted(_TypingBox(markup).spans, reverse=True):
        out = out[:start] + out[end:]
    # A template that keeps the question in the same block keeps all of it.
    return out if to_text(out) else markup


def to_text(markup):
    s = markup or ""
    s = _COMMENT.sub("", s)
    s = _DROP.sub("", s)
    s = _HIDDEN.sub("", s)
    s = _VOID_DROP.sub("", s)

    # <pre> keeps its whitespace exactly; set it aside before the rest of the
    # markup has its whitespace collapsed the way a browser would.
    pres = []

    def keep_pre(m):
        pres.append(html.unescape(_TAG.sub("", m.group(1))).replace("\xa0", " ").strip("\n"))
        return _BLK + (_PRE_MARK % (len(pres) - 1)) + _BLK

    s = _PRE.sub(keep_pre, s)

    s = _IMG.sub("[image]", s)
    s = _SOUND.sub("[audio]", s)
    s = _BREAK.sub(_NL, s)
    s = _LI.sub(_BLK + "• ", s)
    s = _CELL.sub("  ", s)
    s = _BLOCK_START.sub(_BLK, s)
    s = _BLOCK_END.sub(_BLK, s)
    s = _TAG.sub("", s)

    # Source whitespace, newlines included, is just a space in HTML.
    s = re.sub(r"\s+", " ", s)
    s = html.unescape(s).replace("\xa0", " ")

    # Block edges: any run of them (with spaces between) is one line break.
    s = re.sub(" *%s[ %s]*" % (_BLK, _BLK), _BLK, s)
    s = s.replace(_BLK, "\n")
    s = re.sub(" *%s *" % _NL, "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    s = re.sub("\x02(\\d+)\x02", lambda m: pres[int(m.group(1))], s)
    return "\n".join(line.rstrip() for line in s.split("\n")).strip()


def answer_text(card):
    """The back of the card without the front repeated above it.

    Most templates open the answer with {{FrontSide}} and an <hr id=answer>;
    everything after that marker is the part worth showing under the question.
    """
    rendered = card.answer()
    parts = _ANSWER_SPLIT.split(rendered, maxsplit=1)
    back = to_text(parts[1] if len(parts) == 2 else rendered)
    if len(parts) != 2:
        # No marker: drop a leading copy of the question if the template
        # repeated it, so the reveal adds something.
        front = to_text(card.question())
        if front and back.startswith(front):
            back = back[len(front):].strip() or back
    return back

# -------------------------------------------------------------------- decks

def safe_part(name):
    """One deck name component as a file name the library will list."""
    name = re.sub(r"[\x00-\x1f\x7f]", " ", name).replace("/", "-").strip()
    # A leading dot hides a file, and `gleamdrill:` is reserved for decks that
    # are not files.
    name = name.lstrip(".").strip()
    if name.lower().startswith("gleamdrill:"):
        name = name.replace(":", " -", 1)
    return name or "untitled"


def deck_path(name):
    return "/".join(safe_part(p) for p in name.split("::"))


class Report:
    def __init__(self):
        self.images = self.audio = self.empty = self.suspended = 0


def collect(col, report):
    """{library path: [card, ...]} for everything that can be studied."""
    names = {d.id: d.name for d in col.decks.all_names_and_ids()}
    decks = {}
    for cid in col.db.list("select id from cards order by did, due, ord, id"):
        card = col.get_card(cid)
        if card.queue == -1:
            report.suspended += 1
            continue
        # A card lent to a filtered deck belongs to the deck it came from.
        name = names.get(card.odid or card.did)
        note = card.note()
        front, back = to_text(drop_typing_boxes(card.question())), answer_text(card)
        if not name or not front or not back:
            report.empty += 1
            continue
        both = front + back
        report.images += "[image]" in both
        report.audio += "[audio]" in both
        entry = {"id": "anki:%s:%d" % (note.guid, card.ord), "front": front, "back": back}
        tags = [t for t in note.tags if t.lower() not in DROP_TAGS]
        if tags:
            entry["tags"] = tags
        decks.setdefault(deck_path(name), []).append(entry)
    return decks


def split(cards):
    parts, cur, size = [], [], 0
    for card in cards:
        n = len(json.dumps(card, ensure_ascii=False, indent=2).encode()) + 200
        if cur and size + n > PART_LIMIT:
            parts.append(cur)
            cur, size = [], 0
        cur.append(card)
        size += n
    parts.append(cur)
    return parts


def files_for(decks):
    """{relative file: cards}. Names that differ only in case, or that became
    the same once made safe, would overwrite each other, so they are numbered."""
    out, taken = {}, set()

    def claim(path):
        n, p = 2, path
        while p.lower() in taken:
            p, n = "%s (%d)" % (path, n), n + 1
        taken.add(p.lower())
        return p

    for path in sorted(decks):
        base = claim(path)
        for i, cards in enumerate(split(decks[path])):
            out[(base if i == 0 else claim("%s/part %d" % (base, i + 1))) + ".json"] = cards
    return out


def write(root, files):
    for rel, cards in files.items():
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".omengram.", dir=os.path.dirname(path))
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"cards": cards}, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, path)


def anki_running():
    r = subprocess.run(["pgrep", "-u", str(os.getuid()), "-x", "anki"], capture_output=True)
    return r.returncode == 0


def open_copy(source, workdir):
    for ext in ("", "-wal"):
        if os.path.exists(source + ext):
            shutil.copyfile(source + ext, os.path.join(workdir, "collection.anki2" + ext))
    copy = os.path.join(workdir, "collection.anki2")
    # Fold the write-ahead log in, so Anki's library opens one plain file.
    db = sqlite3.connect(copy)
    db.execute("pragma wal_checkpoint(truncate)")
    db.close()

    return anki_lib().Collection(copy)


def open_package(package, workdir):
    """A new collection in `workdir` holding just what `package` brings, with
    none of its scheduling: the cards start new here either way."""
    a = anki_lib()
    col = a.Collection(os.path.join(workdir, "collection.anki2"))
    try:
        col.import_anki_package(a.ImportAnkiPackageRequest(
            package_path=package,
            options=a.ImportAnkiPackageOptions(with_scheduling=False, with_deck_configs=False,
                                               merge_notetypes=True)))
    except Exception as e:
        col.close()
        sys.exit("Anki could not read %s: %s" % (package, e))
    return col


def anki_lib():
    pkgs = os.path.join(ANKI_DIR, "app_packages")
    if os.path.isdir(pkgs) and pkgs not in sys.path:
        sys.path.insert(0, pkgs)
    try:
        import anki.collection
    except ImportError as e:
        sys.exit("Can't load Anki's Python library (%s). Run this with Anki's own Python:\n"
                 "  %s/python/bin/python3 %s" % (e, ANKI_DIR, sys.argv[0]))
    return anki.collection


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--profile", default="User 1", help="Anki profile (default: %(default)s)")
    ap.add_argument("--collection", help="path to a collection.anki2, instead of a profile")
    ap.add_argument("--apkg", help="an Anki package (.apkg) to import, instead of a collection")
    ap.add_argument("-o", "--output", default="~/.local/share/omengram", help="library (default: %(default)s)")
    ap.add_argument("--force", action="store_true", help="replace deck files that already exist")
    ap.add_argument("--dry-run", action="store_true", help="say what would be written, and write nothing")
    args = ap.parse_args()

    if args.apkg and args.collection:
        sys.exit("Give --apkg or --collection, not both.")
    if args.apkg:
        source = os.path.abspath(os.path.expanduser(args.apkg))
        if not os.path.isfile(source):
            sys.exit("No package at " + source)
    else:
        source = os.path.expanduser(args.collection or os.path.join(ANKI_BASE, args.profile, "collection.anki2"))
        if not os.path.isfile(source):
            sys.exit("No Anki collection at " + source)
        if not args.collection and anki_running():
            sys.exit("Anki is open. Close it first, so the copy is a whole one.")

    report = Report()
    with tempfile.TemporaryDirectory(prefix="omengram-import-") as tmp:
        col = open_package(source, tmp) if args.apkg else open_copy(source, tmp)
        try:
            files = files_for(collect(col, report))
        finally:
            col.close()

    if not files:
        sys.exit("Nothing to import.")

    root = os.path.expanduser(args.output)
    there = [f for f in files if os.path.exists(os.path.join(root, f))]
    if there and not args.force and not args.dry_run:
        sys.exit("Already there:\n  %s\nPass --force to replace. Nothing was written."
                 % "\n  ".join(there))
    if not args.dry_run:
        write(root, files)

    for rel in sorted(files):
        print("%5d  %s" % (len(files[rel]), rel))
    print("%5d  cards %s %s" % (sum(map(len, files.values())),
                                "would go to" if args.dry_run else "in", root))
    for n, what in [
        (report.images, "cards show [image] where a picture was"),
        (report.audio, "cards show [audio] where a sound was"),
        (report.empty, "cards skipped: nothing left on one side"),
        (report.suspended, "cards skipped: suspended in Anki"),
    ]:
        if n:
            print("%5d  %s" % (n, what))


if __name__ == "__main__":
    main()
