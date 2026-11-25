"""Tests for tools/import_anki.py against a real, throwaway Anki collection.

    /usr/local/share/anki/python/bin/python3 tests/test_import.py
    # or, with `pip install anki`:
    python3 tests/test_import.py

Nothing here touches your own collection or library. Not run in CI, which has
no Anki.
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "tools", "import_anki.py")
ANKI_PKGS = os.path.join(os.environ.get("OMENGRAM_ANKI_DIR", "/usr/local/share/anki"), "app_packages")
if os.path.isdir(ANKI_PKGS):
    sys.path.insert(0, ANKI_PKGS)
sys.path.insert(0, os.path.dirname(SCRIPT))

from anki.collection import Collection  # noqa: E402

import import_anki as imp  # noqa: E402


class ImportTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="omengram-test-")
        self.out = os.path.join(self.dir, "lib")
        self.path = os.path.join(self.dir, "collection.anki2")
        col = self.col = Collection(self.path)
        self.add("Basic", "infra", Front="own", Back="x")
        self.add("Basic", "infra::a/b", tags=["sd::caching", "leech", "Marked"], Front="<b>q</b>", Back="l1<br>l2")
        self.add("Basic (and reversed card)", "rev", Front="one", Back="two")
        self.add("Cloze", "cloze", Text="the {{c1::cat}} sat on the {{c2::mat}}")
        self.add("Basic", "pics", Front='<img src="a.png">', Back="[sound:a.mp3] s")
        held = self.add("Basic", "pics", Front="held", Back="x")
        col.sched.suspend_cards([c.id for c in held.cards()])

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def add(self, kind, deck, tags=(), **fields):
        note = self.col.new_note(self.col.models.by_name(kind))
        for k, v in fields.items():
            note[k] = v
        note.tags = list(tags)
        self.col.add_note(note, self.col.decks.id(deck, create=True))
        return note

    def run_import(self, *args, ok=True):
        if self.col:
            self.col.close()
            self.col = None
        r = subprocess.run([sys.executable, SCRIPT, "--collection", self.path, "-o", self.out, *args],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode == 0, ok, r.stdout + r.stderr)
        return r.stdout + r.stderr

    def deck(self, rel):
        with open(os.path.join(self.out, rel), encoding="utf-8") as f:
            return json.load(f)["cards"]

    def test_tree_text_and_tags(self):
        self.run_import()
        self.assertEqual(self.deck("infra.json")[0]["front"], "own")
        (card,) = self.deck("infra/a-b.json")
        self.assertEqual((card["front"], card["back"], card["tags"]), ("q", "l1\nl2", ["sd::caching"]))

    def test_one_card_per_template_with_its_own_id(self):
        self.run_import()
        cards = self.deck("rev.json")
        self.assertEqual([(c["front"], c["back"]) for c in cards], [("one", "two"), ("two", "one")])
        self.assertEqual(len({c["id"] for c in cards}), 2)
        self.assertTrue(all(c["id"].startswith("anki:") for c in cards))

    def test_cloze(self):
        self.run_import()
        cards = self.deck("cloze.json")
        self.assertEqual(len(cards), 2)
        self.assertIn("[...]", cards[0]["front"])
        self.assertIn("cat", cards[0]["back"])

    def test_media_is_marked_and_suspended_is_left(self):
        out = self.run_import()
        (card,) = self.deck("pics.json")
        self.assertEqual(card["front"], "[image]")
        self.assertIn("1  cards show [image]", out)
        self.assertIn("1  cards show [audio]", out)
        self.assertIn("1  cards skipped: suspended", out)

    def test_the_collection_is_not_touched(self):
        self.col.close()
        self.col = None

        def digest():
            with open(self.path, "rb") as f:
                return hashlib.sha256(f.read()).hexdigest()

        before = digest()
        self.run_import()
        self.assertEqual(digest(), before)

    def test_again(self):
        self.run_import()
        before = {f: self.deck(f) for f in ("rev.json", "cloze.json")}
        self.assertIn("Nothing was written", self.run_import(ok=False))
        self.run_import("--force")
        self.assertEqual({f: self.deck(f) for f in before}, before)

    def test_dry_run_writes_nothing(self):
        self.assertIn("would go to", self.run_import("--dry-run"))
        self.assertFalse(os.path.exists(self.out))

    def test_a_big_deck_is_split_under_the_cap(self):
        for i in range(40):
            self.add("Basic", "big", Front="q%d" % i, Back="é" * 8000)
        self.run_import()
        parts = [os.path.join(self.out, "big.json")] + [
            os.path.join(self.out, "big", f) for f in sorted(os.listdir(os.path.join(self.out, "big")))]
        self.assertGreater(len(parts), 1)
        self.assertTrue(all(os.path.getsize(p) < 262144 for p in parts))
        self.assertEqual(sum(len(self.deck(p)) for p in parts), 40)

    def test_a_filtered_deck_gives_its_cards_back(self):
        did = self.col.decks.new_filtered("Cram")
        deck = self.col.decks.get(did)
        deck["terms"][0] = ["deck:rev", 10, 0]
        self.col.decks.save(deck)
        self.col.sched.rebuild_filtered_deck(did)
        self.run_import()
        self.assertEqual(len(self.deck("rev.json")), 2)
        self.assertFalse(os.path.exists(os.path.join(self.out, "Cram.json")))

    def test_a_typing_box_goes_with_its_caption(self):
        box = '<div class="pad">\n<div><span>py</span>Tab indents</div>\n<textarea></textarea></div>'
        self.assertEqual(imp.to_text(imp.drop_typing_boxes('<div>Why?' + box + '</div><p>after</p>')), "Why?\nafter")
        self.assertEqual(imp.to_text(imp.drop_typing_boxes("<div>Why?<textarea></textarea></div>")), "Why?")
        self.assertEqual(imp.drop_typing_boxes("<b>x</b>"), "<b>x</b>")

    def test_names(self):
        self.assertEqual(imp.deck_path("a::..hidden::x/y"), "a/hidden/x-y")
        self.assertEqual(imp.deck_path("gleamdrill: one"), "gleamdrill - one")
        files = imp.files_for({"Deck": [{"id": "1"}], "deck": [{"id": "2"}]})
        self.assertEqual(len({f.lower() for f in files}), 2)


if __name__ == "__main__":
    unittest.main()
