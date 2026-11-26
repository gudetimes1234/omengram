import QtQuick
import Quickshell
import Quickshell.Io

// The connection to Anki for one surface. It keeps a single
// `omengram-anki serve` process alive, started on the first request: that
// process pays the second it takes to import Anki's library once, then opens
// and closes the collection around each request, so Anki itself can still open
// it at any moment.
//
// call(cmd, args, cb) queues a request; cb receives the parsed reply, which
// always has either the result or an `error` string (and maybe a `code`).
Item {
  id: root

  // Merged into every request: { profile }.
  property var defaults: ({})

  readonly property string path: decodeURIComponent(
      Qt.resolvedUrl("bin/omengram-anki").toString().replace(/^file:\/\//, ""))

  property int seq: 0
  property var callbacks: ({})
  property var backlog: []
  readonly property bool pending: Object.keys(root.callbacks).length > 0

  function call(cmd, args, cb) {
    var id = ++root.seq
    var next = {}
    for (var c in root.callbacks) next[c] = root.callbacks[c]
    next[id] = { cb: cb, cmd: cmd }
    root.callbacks = next
    var merged = {}
    for (var k in root.defaults) merged[k] = root.defaults[k]
    for (var j in args) merged[j] = args[j]
    var line = JSON.stringify({ id: id, cmd: cmd, args: merged })
    if (proc.running) proc.write(line + "\n")
    else {
      root.backlog.push(line)
      if (!restart.running) proc.running = true
    }
    return id
  }

  function receive(data) {
    var reply
    try { reply = JSON.parse(data) } catch (e) {
      console.warn("omengram-anki: unreadable reply: " + String(data).slice(0, 200))
      return
    }
    var entry = root.callbacks[reply.id]
    if (!entry) return
    var next = {}
    for (var c in root.callbacks) if (String(c) !== String(reply.id)) next[c] = root.callbacks[c]
    root.callbacks = next
    if (entry.cb) entry.cb(reply)
  }

  function failAll(message) {
    var pending = root.callbacks
    root.callbacks = ({})
    for (var id in pending) if (pending[id].cb) pending[id].cb({ error: message, code: "error" })
  }

  Process {
    id: proc
    command: [root.path, "serve"]
    stdinEnabled: true
    running: false
    stdout: SplitParser { onRead: function(data) { root.receive(data) } }
    stderr: SplitParser { onRead: function(data) { console.warn("omengram-anki: " + data) } }
    onStarted: {
      var lines = root.backlog
      root.backlog = []
      for (var i = 0; i < lines.length; i++) proc.write(lines[i] + "\n")
    }
    onExited: function(code) {
      root.failAll("The Anki bridge stopped (exit " + code + ")")
      if (root.backlog.length) restart.start()
    }
  }

  // A bridge that dies straight away is retried slowly rather than in a loop,
  // and only while something is still waiting for it.
  Timer {
    id: restart
    interval: 3000
    onTriggered: proc.running = true
  }
}
