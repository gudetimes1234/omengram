"""Sync from inside Anki, for the omengram add-on.

When Anki is open it owns the collection, so omengram asks Anki to run its own
Sync, exactly as its Sync button does: media follows Anki's setting, and if
AnkiWeb needs a one-way sync Anki asks the person at the keyboard which way.

Anki reports errors in its own dialogs and gives the hooks no result, so the
outcome is read from the collection instead: after a good sync nothing is left
waiting to be sent. Kept apart from the add-on so it can be tested without Anki.
"""

import time

# A sync Anki never reports back on is given up on after this long.
STALE_AFTER = 600


class AddonSync:
    def __init__(self, mw, bridge, clock=time.time):
        self.mw = mw
        self.bridge = bridge
        self.clock = clock
        self.state = "idle"        # idle | running | done
        self.result = None
        self.started = 0
        self.before = None
        # Anki syncing by itself (on open, on close, its own button).
        self.anki_syncing = False

    # Called on Anki's main thread.
    def start(self):
        if self.state == "running" and self.clock() - self.started < STALE_AFTER:
            return {"status": "busy", "message": "Already syncing"}
        if self.anki_syncing:
            return {"status": "busy", "message": "Anki is already syncing"}
        if self.mw.col is None:
            return {"status": "error", "message": "Anki has no profile open"}
        auth = self.mw.pm.sync_auth()
        if auth is None:
            return {"status": "signedOut", "message": "Not signed in to AnkiWeb — sync once from Anki"}
        self.before = self.bridge.pending_changes(self.mw.col)
        self.state = "running"
        self.result = None
        self.started = self.clock()
        self.mw.on_sync_button_clicked()
        return {"status": "started"}

    def will_start(self):
        if self.state != "running":
            self.anki_syncing = True

    def did_finish(self):
        self.anki_syncing = False
        if self.state != "running":
            return
        col = self.mw.col
        if col is None:
            self.result = {"status": "error", "message": "Anki closed its collection during the sync"}
        else:
            after = self.bridge.pending_changes(col)
            left = after["cards"] + after["notes"] + after["revlog"]
            if left:
                self.result = {"status": "incomplete",
                               "message": "Anki's sync didn't finish — see its window"}
            else:
                before = self.before or after
                self.result = {
                    "status": "ok",
                    "pushed": before["revlog"],
                    "pulled": max(0, after["revlogTotal"] - before["revlogTotal"]),
                }
        self.state = "done"

    def snapshot(self):
        if self.state == "running" and self.clock() - self.started >= STALE_AFTER:
            self.state = "done"
            self.result = {"status": "error", "message": "Anki never finished the sync"}
        return {"state": self.state, "result": self.result}

    @property
    def busy(self):
        return self.state == "running" and self.clock() - self.started < STALE_AFTER

    # Called off the main thread: a network request Anki itself makes in the
    # background too.
    def check(self):
        col = self.mw.col
        auth = self.mw.pm.sync_auth()
        if col is None or auth is None:
            return {"status": "signedOut", "message": "Not signed in to AnkiWeb"}
        out = col.sync_status(auth)
        required = {0: "none", 1: "normal", 2: "full"}.get(int(getattr(out, "required", 0)), "unknown")
        return {"status": "ok", "required": required}
