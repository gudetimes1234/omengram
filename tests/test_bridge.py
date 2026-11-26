"""Tests for bridge/omengram_bridge.py and bridge/cli.py against a real,
throwaway Anki collection with made-up decks.

    /usr/local/share/anki/python/bin/python3 tests/test_bridge.py
    # or, with `pip install anki`:
    python3 tests/test_bridge.py

Nothing here touches your own collection.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
ANKI_PKGS = os.path.join(os.environ.get("OMENGRAM_ANKI_DIR", "/usr/local/share/anki"), "app_packages")
if os.path.isdir(ANKI_PKGS):
    sys.path.insert(0, ANKI_PKGS)
sys.path.insert(0, os.path.join(ROOT, "bridge"))

from anki.collection import Collection  # noqa: E402

import omengram_bridge as br  # noqa: E402


class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="omengram-bridge-")
        self.path = os.path.join(self.dir, "User 1", "collection.anki2")
        os.makedirs(os.path.dirname(self.path))
        self.col = Collection(self.path)
        self.notes = {}
        for i in range(4):
            self.add("Spanish", "es%d" % i, ["grammar"] if i % 2 else [])
        for i in range(3):
            self.add("Spanish::Verbs", "verb%d" % i, ["grammar::verbs"])
        for i in range(2):
            self.add("Python", "py%d" % i, ["code"])
        self.add("a/b", "slash", [])

    def tearDown(self):
        if self.col:
            self.col.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def add(self, deck, front, tags):
        note = self.col.new_note(self.col.models.by_name("Basic"))
        note["Front"] = front
        note["Back"] = "back of " + front
        note.tags = list(tags)
        self.col.add_note(note, self.col.decks.id(deck, create=True))
        self.notes[front] = note
        return note

    def run_cmd(self, cmd, **args):
        out = br.run(self.col, cmd, args)
        self.assertIsInstance(out, dict)
        return out

    def fronts(self, decks=None, tags=None, limits=None, n=50):
        """Every card the scope would show, answering Good to walk it."""
        seen = []
        args = {"decks": decks or [], "tags": tags or [], "limits": limits or {}, "withStats": False}
        for _ in range(n):
            out = self.run_cmd("next", **args)
            card = out["card"]
            if not card:
                break
            seen.append(card["front"])
            self.run_cmd("answer", id=card["id"], mod=card["mod"], grade="easy", **args)
        return seen

    # --------------------------------------------------------------- ids
    def test_deck_ids(self):
        self.assertEqual(br.deck_id("Spanish::Verbs"), "anki:/Spanish/Verbs")
        self.assertEqual(br.deck_id("a/b"), "anki:/a∕b")
        rows = {r["id"]: r for r in self.run_cmd("catalog")["decks"]}
        self.assertEqual(rows["anki:/Spanish"]["total"], 7)
        self.assertEqual(rows["anki:/Spanish/Verbs"]["total"], 3)
        self.assertEqual(rows["anki:/Spanish"]["fresh"], 7)
        self.assertIn("anki:/a∕b", rows)

    def test_catalog_tags_follow_picked_decks(self):
        tags = self.run_cmd("catalog", decks=["anki:/Spanish"])["tags"]
        self.assertEqual(tags, {"grammar": 5, "grammar::verbs": 3})
        self.assertEqual(self.run_cmd("catalog", decks=["infra"])["tags"], {})

    # ------------------------------------------------------------- scope
    def test_everything_matches_anki(self):
        out = self.run_cmd("next")
        self.assertTrue(out["card"]["id"].startswith("anki-cid:"))
        self.assertEqual(out["counts"]["fresh"], 10)
        self.assertEqual(out["counts"]["total"], 10)

    def test_library_only_selection_leaves_anki_out(self):
        out = self.run_cmd("next", decks=["infra/backend"])
        self.assertIsNone(out["card"])
        self.assertEqual(out["counts"]["pending"], 0)
        self.assertEqual(out["counts"]["total"], 0)
        self.assertEqual(out["counts"]["collection"], 10)

    def test_subdeck_and_own_only(self):
        self.assertEqual(sorted(self.fronts(["anki:/Spanish/Verbs"])), ["verb0", "verb1", "verb2"])
        self.assertEqual(sorted(self.fronts(["anki:/Spanish/."])), ["es0", "es1", "es2", "es3"])

    def test_tags_narrow(self):
        got = self.fronts(["anki:/Spanish"], tags=["grammar"])
        self.assertEqual(sorted(got), ["es1", "es3", "verb0", "verb1", "verb2"])
        self.assertEqual(sorted(self.fronts([], tags=["code"])), ["py0", "py1"])

    def test_cap_lowers_anki_limit(self):
        limits = {"anki:/Spanish": {"new": 2}}
        out = self.run_cmd("next", decks=["anki:/Spanish"], limits=limits)
        self.assertEqual(out["counts"]["fresh"], 2)
        self.assertEqual(len(self.fronts(["anki:/Spanish"], limits=limits)), 2)
        # Spent today counts from the revlog, so it holds on a fresh request.
        out = self.run_cmd("next", decks=["anki:/Spanish"], limits=limits)
        self.assertIsNone(out["card"])
        self.assertEqual(out["counts"]["fresh"], 0)

    def test_parent_limit_applies_to_subdeck(self):
        conf = self.col.decks.get_config(1)
        conf["new"]["perDay"] = 2
        self.col.decks.save(conf)
        self.assertEqual(self.run_cmd("next", decks=["anki:/Spanish/Verbs"])["counts"]["fresh"], 2)

    # ------------------------------------------------------------ answer
    def test_answer_is_an_anki_review(self):
        card = self.run_cmd("next")["card"]
        before = self.col.db.scalar("select count() from revlog")
        out = self.run_cmd("answer", id=card["id"], mod=card["mod"], grade="good", elapsed=4000)
        self.assertNotIn("error", out)
        cid = int(card["cid"])
        row = self.col.db.first("select usn, time from revlog where cid = ?", cid)
        self.assertEqual(self.col.db.scalar("select count() from revlog"), before + 1)
        self.assertEqual(row[0], -1)
        self.assertGreaterEqual(row[1], 3900)
        self.assertNotEqual(self.col.get_card(cid).type, 0)

    def test_stale_card_is_refused(self):
        card = self.run_cmd("next")["card"]
        c = self.col.get_card(int(card["cid"]))
        c.flags = 1
        time.sleep(1.1)
        self.col.update_card(c)
        out = self.run_cmd("answer", id=card["id"], mod=card["mod"], grade="good")
        self.assertEqual(out.get("code"), "changed")
        self.assertEqual(self.col.db.scalar("select count() from revlog"), 0)

    def test_undo_takes_the_review_back(self):
        card = self.run_cmd("next")["card"]
        out = self.run_cmd("answer", id=card["id"], mod=card["mod"], grade="again")
        undone = self.run_cmd("undo", undo=out["undo"])
        self.assertNotIn("error", undone)
        self.assertEqual(self.col.db.scalar("select count() from revlog"), 0)
        self.assertEqual(self.col.get_card(int(card["cid"])).type, 0)
        self.assertEqual(undone["card"]["id"], card["id"])

    def test_undo_refused_once_synced(self):
        card = self.run_cmd("next")["card"]
        out = self.run_cmd("answer", id=card["id"], mod=card["mod"], grade="good")
        self.col.db.execute("update revlog set usn = 5")
        undone = self.run_cmd("undo", undo=out["undo"])
        self.assertEqual(undone.get("code"), "synced")
        self.assertEqual(self.col.db.scalar("select count() from revlog"), 1)

    def test_undo_refused_after_card_changed(self):
        card = self.run_cmd("next")["card"]
        out = self.run_cmd("answer", id=card["id"], mod=card["mod"], grade="good")
        self.col.db.execute("update cards set usn = 7 where id = ?", int(card["cid"]))
        self.assertEqual(self.run_cmd("undo", undo=out["undo"]).get("code"), "synced")

    # ------------------------------------------------------- side effects
    def test_selection_is_put_back(self):
        start = self.col.decks.id("Python")
        self.col.decks.select(start)
        # A new collection records its time zone on first use; a real one has.
        self.run_cmd("status")
        self.col.db.execute("update config set usn = 0")
        self.run_cmd("status")
        self.assertEqual(self.col.get_config("curDeck"), start)
        # Counts alone never touch Anki's config, so the slow tick does not
        # give every sync something to send.
        self.assertEqual(self.col.db.scalar("select count() from config where usn = -1"), 0)
        self.run_cmd("next", decks=["anki:/Spanish"])
        self.assertEqual(self.col.get_config("curDeck"), start)

    def test_learning_card_waits(self):
        self.col.set_config("collapseTime", 0)
        card = self.run_cmd("next", decks=["anki:/Python"])["card"]
        self.run_cmd("answer", id=card["id"], mod=card["mod"], grade="again", decks=["anki:/Python"])
        out = self.run_cmd("next", decks=["anki:/Python"])
        self.assertEqual(out["counts"]["waiting"], 1)
        self.assertGreater(out["counts"]["nextDue"], time.time())
        self.assertEqual(out["clock"]["learnAheadSecs"], 0)
        self.assertGreater(out["clock"]["dayCutoff"], time.time())

    def test_stats(self):
        card = self.run_cmd("next", decks=["anki:/Python"])["card"]
        self.run_cmd("answer", id=card["id"], mod=card["mod"], grade="good")
        stats = self.run_cmd("next", decks=["anki:/Python"])["stats"]
        self.assertEqual(stats["total"], 2)
        self.assertEqual(stats["introducedToday"], 1)
        self.assertEqual(stats["answeredToday"], 1)

    def test_text_is_flattened(self):
        self.assertEqual(br.to_text("<div>a</div><div>b &amp; c</div>"), "a\nb & c")
        self.assertEqual(br.to_text('<img src="x.png"> [sound:a.mp3]'), "[image] [audio]")


class CliTest(unittest.TestCase):
    """The CLI end to end, opening the collection itself (Anki is closed)."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="omengram-cli-")
        prof = os.path.join(self.dir, "Anki2", "Test")
        os.makedirs(prof)
        self.path = os.path.join(prof, "collection.anki2")
        col = Collection(self.path)
        note = col.new_note(col.models.by_name("Basic"))
        note["Front"], note["Back"] = "hola", "hello"
        col.add_note(note, col.decks.id("Spanish"))
        col.close()
        self.env = dict(os.environ, OMENGRAM_DIRECT="1", OMENGRAM_ANKI_BASE=os.path.join(self.dir, "Anki2"),
                        OMENGRAM_STATE_DIR=os.path.join(self.dir, "state"),
                        OMENGRAM_RUNTIME_DIR=self.dir)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def cli(self, *args):
        r = subprocess.run([os.path.join(ROOT, "bin", "omengram-anki")] + list(args),
                           capture_output=True, text=True, env=self.env, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def test_one_shot_and_backup(self):
        card = self.cli("next")["card"]
        self.assertEqual(card["front"], "hola")
        backups = os.path.join(os.path.dirname(self.path), "backups")
        self.assertFalse(os.path.isdir(backups) and os.listdir(backups))
        out = self.cli("answer", json.dumps({"id": card["id"], "mod": card["mod"], "grade": "good"}))
        self.assertNotIn("error", out)
        self.assertTrue([f for f in os.listdir(backups) if f.endswith(".colpkg")])

    def test_serve(self):
        r = subprocess.run([os.path.join(ROOT, "bin", "omengram-anki"), "serve"],
                           input='{"id": 1, "cmd": "ping"}\nnot json\n{"id": 2, "cmd": "status"}\n',
                           capture_output=True, text=True, env=self.env, timeout=60)
        lines = [json.loads(x) for x in r.stdout.splitlines()]
        self.assertEqual(lines[0], {"bridge": "omengram", "version": 1, "id": 1})
        self.assertIn("error", lines[1])
        self.assertEqual(lines[2]["counts"]["fresh"], 1)

    def test_missing_collection(self):
        self.env["OMENGRAM_ANKI_BASE"] = os.path.join(self.dir, "nowhere")
        out = self.cli("status")
        self.assertEqual(out["code"], "noCollection")


if __name__ == "__main__":
    unittest.main()
