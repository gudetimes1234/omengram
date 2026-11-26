"""omengram bridge: lets omengram study and sync this collection while Anki is open.

Anki holds its collection locked while it runs, so omengram's CLI cannot open
the file. This add-on listens on 127.0.0.1:8767 and runs the same operations
(bridge/omengram_bridge.py in the omengram repo) against `mw.col` on Anki's
main thread. When Anki is closed the CLI opens the file itself, so either way
omengram and Anki share one schedule. Sync from omengram presses Anki's own
Sync button.

Install by symlinking this folder into Anki's add-ons folder:

    ln -s ~/github/omarchy-plugins/omengram/anki-addon ~/.local/share/Anki2/addons21/omengram_bridge
"""

import importlib.util
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from aqt import gui_hooks, mw

HERE = os.path.dirname(os.path.realpath(__file__))
BRIDGE_DIR = os.path.normpath(os.path.join(HERE, "..", "bridge"))


def _load(name, filename):
    # Loaded by path under their own names: Anki imports this folder as a
    # module named after it, so a plain import from here could hand back this
    # add-on instead.
    spec = importlib.util.spec_from_file_location(name, os.path.join(BRIDGE_DIR, filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bridge = _load("omengram_bridge_core", "omengram_bridge.py")
addon_sync = _load("omengram_addon_sync", "addon_sync.py")

PORT = int(os.environ.get("OMENGRAM_ANKI_PORT", "8767"))
MAX_BODY = 1 << 20

_server = None
_sync = addon_sync.AddonSync(mw, bridge)


def _on_main(fn, wait=30):
    """Run fn on Anki's main thread and wait for its result."""
    done = threading.Event()
    box = {}

    def task():
        try:
            box["result"] = fn()
        except Exception as e:  # never let a request take Anki down
            box["result"] = {"error": "Anki add-on error: %s" % e}
        finally:
            done.set()

    mw.taskman.run_on_main(task)
    if not done.wait(wait):
        return {"error": "Anki did not answer in time", "code": "busy"}
    return box.get("result") or {"error": "no result"}


def _command(cmd, args):
    def run():
        if mw.col is None:
            return {"error": "Anki has no profile open", "code": "noCollection"}
        result = bridge.run(mw.col, cmd, args)
        if cmd in bridge.MUTATING and not result.get("error"):
            # Redraw Anki's own screens so its counts match what omengram did.
            try:
                mw.reset()
            except Exception:
                pass
        return result

    return _on_main(run)


def handle(cmd, args):
    if cmd == "sync":
        return _on_main(_sync.start)
    if cmd == "syncState":
        return _on_main(_sync.snapshot)
    if cmd == "syncCheck":
        try:
            return _sync.check()
        except Exception as e:
            return {"status": "error", "message": str(e)[:300]}
    # While Anki syncs, its collection may be closed and reopened under it.
    if _sync.busy or _sync.anki_syncing:
        return {"error": "Anki is syncing", "code": "busy"}
    return _command(cmd, args)


class _Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        # A custom header cannot be sent cross-origin without a preflight,
        # which this server never answers, so a web page cannot drive it.
        if self.headers.get("X-Omengram") != "1":
            self._send(403, {"error": "forbidden"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            self._send(400, {"error": "bad request"})
            return
        try:
            req = json.loads(self.rfile.read(length).decode())
        except ValueError:
            self._send(400, {"error": "bad request"})
            return
        if not isinstance(req, dict):
            self._send(400, {"error": "bad request"})
            return
        args = req.get("args") if isinstance(req.get("args"), dict) else {}
        # The collection is whatever Anki has open; a path from the client
        # means nothing here.
        args.pop("collection", None)
        self._send(200, handle(str(req.get("cmd") or ""), args))

    def log_message(self, *args):
        pass


def _start():
    global _server
    if _server is not None:
        return
    try:
        _server = ThreadingHTTPServer(("127.0.0.1", PORT), _Handler)
    except OSError as e:
        print("omengram bridge: could not listen on port %d: %s" % (PORT, e))
        _server = None
        return
    _server.daemon_threads = True
    threading.Thread(target=_server.serve_forever, name="omengram-bridge", daemon=True).start()


def _stop():
    global _server
    if _server is None:
        return
    server, _server = _server, None

    def close():
        server.shutdown()
        server.server_close()

    threading.Thread(target=close, daemon=True).start()


gui_hooks.profile_did_open.append(_start)
gui_hooks.profile_will_close.append(_stop)
gui_hooks.sync_will_start.append(_sync.will_start)
gui_hooks.sync_did_finish.append(_sync.did_finish)
