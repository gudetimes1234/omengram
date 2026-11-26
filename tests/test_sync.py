"""Tests for the sync half of the bridge: bridge/cli.py's `sync`, the profile
reader, the status file, and bridge/addon_sync.py with a stand-in Anki.

    /usr/local/share/anki/python/bin/python3 tests/test_sync.py
    # or, with `pip install anki`:
    python3 tests/test_sync.py

Nothing here talks to AnkiWeb or touches your own Anki: the network side of
the collection is replaced, and profiles are made up in a temporary folder.
"""

import json
import os
import pickle
import shutil
import sqlite3
import stat
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
ANKI_PKGS = os.path.join(os.environ.get("OMENGRAM_ANKI_DIR", "/usr/local/share/anki"), "app_packages")
if os.path.isdir(ANKI_PKGS):
    sys.path.insert(0, ANKI_PKGS)
sys.path.insert(0, os.path.join(ROOT, "bridge"))

from anki.collection import Collection  # noqa: E402
from anki.errors import NetworkError, SyncError, SyncErrorKind  # noqa: E402

import addon_sync  # noqa: E402
import cli  # noqa: E402
import omengram_bridge as br  # noqa: E402

KEY = "made-up-sync-key-0123456789"


class Evil:
    """Something a profile must never be able to construct."""

    def __reduce__(self):
        return (os.getcwd, ())


def write_prefs(base, name, profile):
    os.makedirs(base, exist_ok=True)
    db = sqlite3.connect(os.path.join(base, "prefs21.db"))
    db.execute("create table if not exists profiles (name text primary key, data blob not null)")
    db.execute("insert or replace into profiles values (?, ?)", (name, pickle.dumps(profile)))
    db.commit()
    db.close()


class Fixture(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="omengram-sync-")
        self.base = os.path.join(self.dir, "Anki2")
        self.state = os.path.join(self.dir, "state")
        prof = os.path.join(self.base, "Test")
        os.makedirs(prof)
        self.path = os.path.join(prof, "collection.anki2")
        col = Collection(self.path)
        note = col.new_note(col.models.by_name("Basic"))
        note["Front"], note["Back"] = "hola", "hello"
        col.add_note(note, col.decks.id("Spanish"))
        col.close()
        write_prefs(self.base, "Test", {"syncKey": KEY, "syncUser": "someone",
                                        "currentSyncUrl": "https://sync.example/", "customSyncUrl": ""})
        self.patches = [
            mock.patch.object(cli, "ANKI_BASE", self.base),
            mock.patch.object(cli, "STATE_DIR", self.state),
            mock.patch.dict(os.environ, {"OMENGRAM_DIRECT": "1", "OMENGRAM_RUNTIME_DIR": self.dir}),
            mock.patch.object(cli, "anki_running", lambda: False),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        shutil.rmtree(self.dir, ignore_errors=True)

    def fake_sync(self, required=1, pulled=0, error=None, new_endpoint="", server_message=""):
        """Replaces Collection.sync_collection: records the auth it was given,
        and pretends AnkiWeb answered."""
        seen = {}

        def fake(col, auth, media):
            seen["auth"] = auth
            seen["media"] = media
            if error is not None:
                raise error
            if required in (0, 1):
                # Sent: nothing is pending any more. Received: new reviews.
                col.db.execute("update revlog set usn = 3")
                col.db.execute("update cards set usn = 3")
                col.db.execute("update notes set usn = 3")
                for i in range(pulled):
                    col.db.execute("insert into revlog values (?, (select id from cards limit 1),"
                                   " 3, 3, 1, 0, 2500, 1000, 1)", 1 + i)
            return SimpleNamespace(required=required, new_endpoint=new_endpoint,
                                   server_message=server_message, host_number=0)

        return mock.patch.object(Collection, "sync_collection", fake), seen

    def answer_one(self):
        col = Collection(self.path)
        card = br.run(col, "next", {})["card"]
        br.run(col, "answer", {"id": card["id"], "mod": card["mod"], "grade": "good"})
        col.close()

    def status_file(self):
        with open(os.path.join(self.state, cli.SYNC_STATUS)) as f:
            return f.read()


class DirectSyncTest(Fixture):
    def test_normal_sync(self):
        self.answer_one()
        patch, seen = self.fake_sync(required=1, pulled=2)
        with patch:
            out = cli.sync({})
        self.assertEqual(out["status"], "ok")
        self.assertEqual(out["pushed"], 1)
        self.assertEqual(out["pulled"], 2)
        self.assertFalse(seen["media"])
        self.assertEqual(seen["auth"].hkey, KEY)
        self.assertEqual(seen["auth"].endpoint, "https://sync.example/")
        doc = json.loads(self.status_file())
        self.assertEqual(doc["status"], "ok")
        self.assertEqual(doc["lastSuccess"], doc["lastAttempt"])
        mode = stat.S_IMODE(os.stat(os.path.join(self.state, cli.SYNC_STATUS)).st_mode)
        self.assertEqual(mode, 0o600)

    def test_no_changes(self):
        patch, _ = self.fake_sync(required=0)
        with patch:
            self.assertEqual(cli.sync({})["status"], "ok")

    def test_full_sync_is_never_chosen(self):
        for required in (2, 3, 4):
            patch, _ = self.fake_sync(required=required)
            with patch, mock.patch.object(Collection, "full_upload_or_download",
                                          side_effect=AssertionError("full sync"), create=True):
                out = cli.sync({})
            self.assertEqual(out["status"], "fullSyncRequired")
            self.assertIn("open Anki", out["message"])

    def test_errors(self):
        cases = [
            (SyncError("bad login " + KEY, None, None, None, SyncErrorKind.AUTH), "auth"),
            (NetworkError("no route", None, None, None), "network"),
            (SyncError("server said no", None, None, None, SyncErrorKind.OTHER), "error"),
            (RuntimeError("boom " + KEY), "error"),
        ]
        for err, status in cases:
            patch, _ = self.fake_sync(error=err)
            with patch:
                out = cli.sync({})
            self.assertEqual(out["status"], status, err)
            self.assertNotIn(KEY, json.dumps(out))
        # A failed attempt keeps the last good sync.
        doc = json.loads(self.status_file())
        self.assertEqual(doc["lastSuccess"], 0)

    def test_new_endpoint_is_kept_and_used(self):
        patch, _ = self.fake_sync(required=0, new_endpoint="https://sync9.example/")
        with patch:
            cli.sync({})
        patch, seen = self.fake_sync(required=0)
        with patch:
            cli.sync({})
        self.assertEqual(seen["auth"].endpoint, "https://sync9.example/")

    def test_server_message_passes_through(self):
        patch, _ = self.fake_sync(required=1, server_message="AnkiWeb is down for maintenance")
        with patch:
            self.assertEqual(cli.sync({})["message"], "AnkiWeb is down for maintenance")

    def test_signed_out(self):
        write_prefs(self.base, "Test", {"syncUser": None, "currentSyncUrl": None})
        patch, seen = self.fake_sync()
        with patch:
            out = cli.sync({})
        self.assertEqual(out["status"], "signedOut")
        self.assertNotIn("auth", seen)

    def test_profile_with_a_class_is_refused(self):
        write_prefs(self.base, "Test", {"syncKey": KEY, "x": Evil()})
        with self.assertRaises(cli.Unavailable):
            cli.read_profile("Test", self.base)

    def test_anki_open_without_addon(self):
        patch, seen = self.fake_sync()
        with patch, mock.patch.object(cli, "anki_running", lambda: True):
            out = cli.sync({})
        self.assertEqual(out["status"], "ankiOpenNoAddon")
        self.assertNotIn("auth", seen)

    def test_one_sync_at_a_time(self):
        with cli.Lock("sync.lock", 0):
            self.assertEqual(cli.sync({})["status"], "busy")

    def test_key_never_leaves(self):
        self.answer_one()
        patch, _ = self.fake_sync(required=1)
        with patch:
            out = cli.sync({})
        self.assertNotIn(KEY, json.dumps(out))
        self.assertNotIn(KEY, self.status_file())
        self.assertNotIn(KEY, json.dumps(cli.read_status(self.state)))

    def test_prefs_are_not_written(self):
        prefs = os.path.join(self.base, "prefs21.db")
        with open(prefs, "rb") as f:
            before = f.read()
        patch, _ = self.fake_sync(required=0, new_endpoint="https://sync9.example/")
        with patch:
            cli.sync({})
        with open(prefs, "rb") as f:
            self.assertEqual(f.read(), before)


class FakeMw:
    def __init__(self, col, signed_in=True):
        self.col = col
        self.pm = SimpleNamespace(sync_auth=lambda: object() if signed_in else None)
        self.clicked = 0
        self.on_click = None

    def on_sync_button_clicked(self):
        self.clicked += 1
        if self.on_click:
            self.on_click()


class AddonSyncTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="omengram-addon-")
        self.col = Collection(os.path.join(self.dir, "collection.anki2"))
        note = self.col.new_note(self.col.models.by_name("Basic"))
        note["Front"], note["Back"] = "hola", "hello"
        self.col.add_note(note, self.col.decks.id("Spanish"))
        card = br.run(self.col, "next", {})["card"]
        br.run(self.col, "answer", {"id": card["id"], "mod": card["mod"], "grade": "good"})
        self.now = [1000.0]
        self.mw = FakeMw(self.col)
        self.sync = addon_sync.AddonSync(self.mw, br, clock=lambda: self.now[0])

    def tearDown(self):
        self.col.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_good_sync(self):
        self.assertEqual(self.sync.start()["status"], "started")
        self.assertEqual(self.mw.clicked, 1)
        self.assertTrue(self.sync.busy)
        self.assertEqual(self.sync.start()["status"], "busy")
        self.col.db.execute("update revlog set usn = 4")
        self.col.db.execute("update cards set usn = 4")
        self.col.db.execute("update notes set usn = 4")
        self.sync.did_finish()
        snap = self.sync.snapshot()
        self.assertEqual(snap["state"], "done")
        self.assertEqual(snap["result"], {"status": "ok", "pushed": 1, "pulled": 0})

    def test_unfinished_sync(self):
        self.sync.start()
        self.sync.did_finish()
        self.assertEqual(self.sync.snapshot()["result"]["status"], "incomplete")

    def test_signed_out_never_opens_a_login(self):
        sync = addon_sync.AddonSync(FakeMw(self.col, signed_in=False), br)
        self.assertEqual(sync.start()["status"], "signedOut")

    def test_anki_already_syncing(self):
        self.sync.will_start()
        self.assertEqual(self.sync.start()["status"], "busy")
        self.sync.did_finish()
        self.assertEqual(self.sync.start()["status"], "started")

    def test_a_lost_sync_is_given_up(self):
        self.sync.start()
        self.now[0] += addon_sync.STALE_AFTER + 1
        self.assertFalse(self.sync.busy)
        self.assertEqual(self.sync.snapshot()["result"]["status"], "error")


class AddonPathTest(Fixture):
    """cli.sync when the add-on answers: it starts Anki's sync and waits."""

    def test_waits_for_anki(self):
        replies = iter([{"status": "started"}, {"state": "running"},
                        {"state": "done", "result": {"status": "ok", "pushed": 2, "pulled": 1}}])
        with mock.patch.dict(os.environ, {"OMENGRAM_DIRECT": ""}), \
                mock.patch.object(cli, "via_addon", lambda *a, **k: next(replies)), \
                mock.patch.object(cli.time, "sleep", lambda s: None):
            out = cli.sync({})
        self.assertEqual(out["status"], "ok")
        self.assertEqual(out["via"], "addon")
        self.assertEqual(json.loads(self.status_file())["pulled"], 1)

    def test_falls_back_when_anki_is_closed(self):
        patch, seen = self.fake_sync(required=0)
        with patch, mock.patch.dict(os.environ, {"OMENGRAM_DIRECT": ""}), \
                mock.patch.object(cli, "via_addon", lambda *a, **k: None):
            out = cli.sync({})
        self.assertEqual(out["via"], "direct")
        self.assertIn("auth", seen)


if __name__ == "__main__":
    unittest.main()
