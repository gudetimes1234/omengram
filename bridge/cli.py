"""omengram-anki: omengram's way into an Anki collection.

    omengram-anki <command> ['<json args>']
    omengram-anki serve
    omengram-anki sync ['<json args>']
    omengram-anki syncCheck ['<json args>']

Prints one line of JSON. `serve` reads one JSON request per line on stdin,
`{"id": .., "cmd": .., "args": {..}}`, and answers each with a line carrying
the same id. Importing Anki's library costs about a second and opening the
collection costs nothing, so the server imports once and still opens and
closes the collection around every request: it never keeps Anki's lock.

On failure the JSON is {"error": "...", "code": "..."}, so the caller always
has something to show; a non-zero exit means the bridge itself could not run.

1. If Anki is open, its collection is locked, so the request goes to the
   omengram add-on inside Anki on 127.0.0.1:8767.
2. Otherwise the collection file is opened here under a lock, used, and closed
   again straight away, so Anki can still open it a moment later.

`sync` sends the collection's changes to AnkiWeb and brings the other
devices' in: through Anki's own Sync when Anki is open, or here with Anki's
library when it is closed. It never does a one-way (full) sync, and writes
what happened to omengram-sync.json for the bar to show.
"""

import errno
import fcntl
import io
import json
import os
import pickle
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

PORT = int(os.environ.get("OMENGRAM_ANKI_PORT", "8767"))
ANKI_DIR = os.environ.get("OMENGRAM_ANKI_DIR", "/usr/local/share/anki")
ANKI_BASE = os.path.expanduser(os.environ.get("OMENGRAM_ANKI_BASE", "~/.local/share/Anki2"))
STATE_DIR = os.path.expanduser(os.environ.get("OMENGRAM_STATE_DIR", "~/.local/state/omarchy"))
SYNC_STATUS = "omengram-sync.json"

# How long a sync may take before omengram stops waiting for Anki's window.
ADDON_SYNC_WAIT = 180
# How long a request waits for another one to finish with the collection.
LOCK_WAIT = 60


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


# ------------------------------------------------------------------ locks

def runtime_dir():
    base = os.environ.get("OMENGRAM_RUNTIME_DIR") or os.environ.get("XDG_RUNTIME_DIR")
    if not base or not os.path.isdir(base):
        base = STATE_DIR
    path = os.path.join(base, "omengram")
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        pass
    st = os.lstat(path)
    if not os.path.isdir(path) or os.path.islink(path) or st.st_uid != os.getuid():
        raise RuntimeError("unsafe lock directory " + path)
    return path


class Lock:
    """An flock on a file in the runtime directory. `wait` seconds of 0 means
    give up at once."""

    def __init__(self, name, wait):
        self.name = name
        self.wait = wait
        self.fd = None

    def __enter__(self):
        self.fd = os.open(os.path.join(runtime_dir(), self.name), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        deadline = time.monotonic() + self.wait
        while True:
            try:
                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except OSError as e:
                if e.errno not in (errno.EAGAIN, errno.EACCES):
                    raise
                if time.monotonic() >= deadline:
                    os.close(self.fd)
                    self.fd = None
                    raise TimeoutError(self.name)
                time.sleep(0.05)

    def __exit__(self, *exc):
        if self.fd is not None:
            fcntl.flock(self.fd, fcntl.LOCK_UN)
            os.close(self.fd)
            self.fd = None
        return False


# ----------------------------------------------------------- reaching Anki

def via_addon(cmd, args, timeout=15):
    """The add-on's answer, or None when Anki is not listening."""
    body = json.dumps({"cmd": cmd, "args": args}).encode()
    req = urllib.request.Request(
        "http://127.0.0.1:%d/" % PORT,
        data=body,
        headers={"Content-Type": "application/json", "X-Omengram": "1"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode() or "{}")
        except ValueError:
            return {"error": "Anki add-on returned HTTP %d" % e.code}
    except (urllib.error.URLError, ConnectionError, OSError, ValueError):
        return None


def anki_running():
    try:
        r = subprocess.run(["pgrep", "-u", str(os.getuid()), "-x", "anki"], capture_output=True)
    except OSError:
        return False
    return r.returncode == 0


def profile_name(profile):
    if profile:
        return profile
    # No profile named: the only one there is, or Anki's default.
    try:
        names = sorted(
            d for d in os.listdir(ANKI_BASE)
            if os.path.isfile(os.path.join(ANKI_BASE, d, "collection.anki2"))
        )
    except OSError:
        names = []
    return names[0] if len(names) == 1 else "User 1"


def collection_path(args):
    if args.get("collection"):
        return args["collection"]
    return os.path.join(ANKI_BASE, profile_name(args.get("profile")), "collection.anki2")


def load_anki():
    pkgs = os.path.join(ANKI_DIR, "app_packages")
    if os.path.isdir(pkgs) and pkgs not in sys.path:
        sys.path.insert(0, pkgs)
    from anki.collection import Collection  # noqa: F401
    return Collection


class Unavailable(Exception):
    def __init__(self, message, code):
        super().__init__(message)
        self.code = code


class Opened:
    """The collection, opened under the collection lock and closed again."""

    def __init__(self, path):
        self.path = path
        self.col = None
        self.lock = Lock("collection.lock", LOCK_WAIT)

    def __enter__(self):
        try:
            Collection = load_anki()
        except ImportError as e:
            raise Unavailable("Can't load Anki's Python library from %s (%s)" % (ANKI_DIR, e), "noAnki")
        if not os.path.isfile(self.path):
            raise Unavailable("No Anki collection at " + self.path, "noCollection")
        try:
            self.lock.__enter__()
        except TimeoutError:
            raise Unavailable("Another omengram request is still using the collection", "busy")
        try:
            self.col = Collection(self.path)
        except Exception as e:  # locked, corrupt, or a newer schema
            self.lock.__exit__()
            msg = str(e)
            if "lock" in msg.lower() or "busy" in msg.lower():
                raise Unavailable("Anki is open without the omengram add-on, so its collection is locked.",
                                  "ankiOpenNoAddon")
            raise Unavailable("Couldn't open the Anki collection: " + msg, "error")
        return self.col

    def __exit__(self, *exc):
        try:
            if self.col is not None:
                self.col.close()
        finally:
            self.col = None
            self.lock.__exit__()
        return False


def daily_backup(col, path):
    """Anki's own backup, once a study day, before the first write. Anki makes
    them while it runs; this covers the days it is never opened."""
    folder = os.path.join(os.path.dirname(path), "backups")
    start = col.sched.day_cutoff - 86400
    try:
        newest = max((os.path.getmtime(os.path.join(folder, f)) for f in os.listdir(folder)
                      if f.endswith(".colpkg")), default=0)
    except OSError:
        newest = 0
    if newest >= start:
        return False
    os.makedirs(folder, exist_ok=True)
    return col.create_backup(backup_folder=folder, force=True, wait_for_completion=True)


def direct(cmd, args):
    import omengram_bridge

    path = collection_path(args)
    try:
        with Opened(path) as col:
            if cmd in omengram_bridge.MUTATING:
                daily_backup(col, path)
            return omengram_bridge.run(col, cmd, args)
    except Unavailable as e:
        return {"error": str(e), "code": e.code}


def handle(cmd, args):
    if cmd == "sync":
        return sync(args)
    if cmd == "syncCheck":
        return sync_check(args)
    result = None
    if not os.environ.get("OMENGRAM_DIRECT"):
        result = via_addon(cmd, args)
    if result is None:
        result = direct(cmd, args)
    return result if isinstance(result, dict) else {"error": "bad result"}


# ------------------------------------------------------------------- sync

class _NoClasses(pickle.Unpickler):
    """Anki's profile is a pickled dict of plain values. Anything that asks
    for a class is not a profile, and is not given one."""

    def find_class(self, module, name):
        raise pickle.UnpicklingError("profile refers to %s.%s" % (module, name))


def read_profile(profile, base=None):
    """The profile's settings from prefs21.db, opened read-only. Raises
    Unavailable when there is none."""
    base = base or ANKI_BASE
    db_path = os.path.join(base, "prefs21.db")
    if not os.path.isfile(db_path):
        raise Unavailable("Anki has no profiles here yet", "signedOut")
    name = profile_name(profile)
    try:
        db = sqlite3.connect("file:%s?mode=ro" % urllib.request.pathname2url(db_path), uri=True)
        try:
            row = db.execute("select cast(data as blob) from profiles where name = ?", (name,)).fetchone()
        finally:
            db.close()
    except sqlite3.Error:
        raise Unavailable("Couldn't read Anki's profiles", "error")
    if not row:
        raise Unavailable("No Anki profile named " + name, "signedOut")
    try:
        data = _NoClasses(io.BytesIO(bytes(row[0]))).load()
    except Exception:
        raise Unavailable("Anki's profile could not be read", "error")
    if not isinstance(data, dict):
        raise Unavailable("Anki's profile could not be read", "error")
    return data


def auth_from_prefs(profile, base=None, endpoint_override=None):
    """(hkey, endpoint, timeout) for AnkiWeb. The key is handed straight to
    Anki's library and nowhere else."""
    data = read_profile(profile, base)
    hkey = data.get("syncKey")
    if not hkey or not isinstance(hkey, str):
        raise Unavailable("Not signed in to AnkiWeb — sync once from Anki", "signedOut")
    endpoint = endpoint_override or data.get("currentSyncUrl") or data.get("customSyncUrl") or None
    try:
        timeout = int(data.get("networkTimeout") or 60)
    except (TypeError, ValueError):
        timeout = 60
    return hkey, endpoint, timeout


def make_auth(hkey, endpoint, timeout):
    from anki.sync import SyncAuth
    auth = SyncAuth(hkey=hkey, io_timeout_secs=timeout)
    if endpoint:
        auth.endpoint = endpoint
    return auth


def _scrub(message, secret):
    message = str(message or "")
    if secret:
        message = message.replace(secret, "…")
    return message[:300]


def classify_error(e, secret=None):
    """(status, message) for an exception from a sync."""
    try:
        from anki.errors import NetworkError, SyncError, SyncErrorKind
    except ImportError:
        NetworkError = SyncError = SyncErrorKind = None
    if SyncError is not None and isinstance(e, SyncError):
        if getattr(e, "kind", None) == SyncErrorKind.AUTH:
            return "auth", "AnkiWeb rejected the login — sign in again in Anki"
        return "error", _scrub(e, secret) or "AnkiWeb sync failed"
    if NetworkError is not None and isinstance(e, NetworkError):
        return "network", "Can't reach AnkiWeb"
    return "error", _scrub(e, secret) or "Sync failed"


FULL_SYNC = {2, 3, 4}   # FULL_SYNC, FULL_DOWNLOAD, FULL_UPLOAD


def sync_direct(col, auth):
    """One normal sync of an open collection. Returns the result fields."""
    import omengram_bridge
    before = omengram_bridge.pending_changes(col)
    out = col.sync_collection(auth, False)
    required = int(getattr(out, "required", 0))
    result = {"via": "direct"}
    if getattr(out, "new_endpoint", ""):
        result["endpoint"] = out.new_endpoint
    if getattr(out, "server_message", ""):
        result["message"] = str(out.server_message)[:300]
    if required in FULL_SYNC:
        result.update(status="fullSyncRequired",
                      message="AnkiWeb needs a one-way sync — open Anki and sync once")
        return result
    after = omengram_bridge.pending_changes(col)
    result.update(status="ok",
                  pushed=before["revlog"],
                  pulled=max(0, after["revlogTotal"] - before["revlogTotal"]))
    return result


def read_status(state_dir=None):
    path = os.path.join(state_dir or STATE_DIR, SYNC_STATUS)
    try:
        with open(path, "rb") as f:
            data = json.loads(f.read(65536).decode() or "{}")
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def write_status(result, state_dir=None):
    """Merges this attempt into the status file, atomically, mode 600."""
    state_dir = state_dir or STATE_DIR
    os.makedirs(state_dir, mode=0o700, exist_ok=True)
    if os.path.islink(state_dir):
        raise RuntimeError("state directory is a symlink")
    old = read_status(state_dir)
    now = int(time.time())
    doc = {
        "lastAttempt": now,
        "lastSuccess": old.get("lastSuccess", 0),
        "status": result.get("status", "error"),
        "message": result.get("message", ""),
        "via": result.get("via", ""),
        "pushed": int(result.get("pushed") or 0),
        "pulled": int(result.get("pulled") or 0),
    }
    if result.get("status") == "ok":
        doc["lastSuccess"] = now
    endpoint = result.get("endpoint") or old.get("endpoint")
    if endpoint:
        doc["endpoint"] = endpoint
    fd, tmp = tempfile.mkstemp(prefix=".omengram.", dir=state_dir)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(doc, f)
        os.replace(tmp, os.path.join(state_dir, SYNC_STATUS))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return doc


def sync_via_addon(args, wait=ADDON_SYNC_WAIT, poll=1.0):
    """Anki's own Sync, run in Anki. None when Anki is not listening."""
    started = via_addon("sync", args, timeout=15)
    if started is None:
        return None
    if started.get("error"):
        return {"status": started.get("code") or "error", "message": started["error"], "via": "addon"}
    if started.get("status") != "started":
        return dict(started, via="addon")
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        time.sleep(poll)
        state = via_addon("syncState", {}, timeout=15)
        if state is None:
            return {"status": "error", "message": "Anki closed during the sync", "via": "addon"}
        if state.get("state") == "done":
            return dict(state.get("result") or {"status": "error"}, via="addon")
    return {"status": "pending", "message": "Anki is still syncing — see its window", "via": "addon"}


def sync(args, state_dir=None):
    """The `sync` command: one sync, never two at once."""
    try:
        with Lock("sync.lock", 0):
            result = None
            if not os.environ.get("OMENGRAM_DIRECT"):
                result = sync_via_addon(args)
            if result is None:
                result = _sync_closed(args, state_dir)
            doc = write_status(result, state_dir)
            return dict(result, lastSuccess=doc["lastSuccess"], lastAttempt=doc["lastAttempt"])
    except TimeoutError:
        return {"status": "busy", "message": "Already syncing"}


def _sync_closed(args, state_dir=None):
    if anki_running():
        return {"status": "ankiOpenNoAddon", "via": "direct",
                "message": "Anki is open without the omengram add-on — sync from Anki"}
    hkey = None
    try:
        hkey, endpoint, timeout = auth_from_prefs(
            args.get("profile"), endpoint_override=read_status(state_dir).get("endpoint"))
        with Opened(collection_path(args)) as col:
            return sync_direct(col, make_auth(hkey, endpoint, timeout))
    except Unavailable as e:
        return {"status": e.code, "message": str(e), "via": "direct"}
    except Exception as e:
        status, message = classify_error(e, hkey)
        return {"status": status, "message": message, "via": "direct"}


def sync_check(args, state_dir=None):
    """Asks AnkiWeb whether a sync is needed, changing nothing."""
    if not os.environ.get("OMENGRAM_DIRECT"):
        result = via_addon("syncCheck", args)
        if result is not None:
            return result
    if anki_running():
        return {"status": "ankiOpenNoAddon", "message": "Anki is open without the omengram add-on"}
    hkey = None
    try:
        hkey, endpoint, timeout = auth_from_prefs(
            args.get("profile"), endpoint_override=read_status(state_dir).get("endpoint"))
        with Opened(collection_path(args)) as col:
            out = col.sync_status(make_auth(hkey, endpoint, timeout))
            required = {0: "none", 1: "normal", 2: "full"}.get(int(getattr(out, "required", 0)), "unknown")
            return {"status": "ok", "required": required}
    except Unavailable as e:
        return {"status": e.code, "message": str(e)}
    except Exception as e:
        status, message = classify_error(e, hkey)
        return {"status": status, "message": message}


# ------------------------------------------------------------------ serve

def serve():
    # Warm the import now, so the first card does not pay for it.
    try:
        load_anki()
    except ImportError:
        pass
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            emit({"error": "request is not valid JSON"})
            continue
        rid = req.get("id") if isinstance(req, dict) else None
        args = req.get("args") if isinstance(req, dict) and isinstance(req.get("args"), dict) else {}
        try:
            result = handle(str(req.get("cmd") or ""), args)
        except Exception as e:  # keep serving; report it on this request
            result = {"error": "bridge error: %s" % e}
        result["id"] = rid
        emit(result)
    return 0


def main(argv):
    if len(argv) < 2:
        sys.stderr.write(__doc__)
        return 2
    cmd = argv[1]
    if cmd == "serve":
        return serve()
    try:
        args = json.loads(argv[2]) if len(argv) > 2 and argv[2] else {}
    except ValueError:
        emit({"error": "arguments are not valid JSON"})
        return 0
    if not isinstance(args, dict):
        args = {}
    emit(handle(cmd, args))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
