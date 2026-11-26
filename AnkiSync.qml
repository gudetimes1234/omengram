import QtQuick
import Quickshell
import Quickshell.Io
import "Anki.js" as Anki

// Syncing with AnkiWeb. Each sync is its own short `omengram-anki sync`
// process, so a slow network never holds up an answer, and the bridge refuses
// a second sync while one runs, whichever surface started it.
//
// The outcome is written to omengram-sync.json, which every surface reads: the
// one that owns the timer (the bar widget) and the ones that only show it.
Item {
  id: root

  property bool inUse: true
  property string profile: ""
  // Only one surface runs the timer; the others just read the status.
  property bool runsTimer: false
  // Minutes between syncs; 0 turns the timer off.
  property int interval: 15
  property string stateDir: Quickshell.env("HOME") + "/.local/state/omarchy"

  readonly property string home: Quickshell.env("HOME")
  readonly property string statusRel: Anki.relativeToHome(root.stateDir + "/omengram-sync.json", root.home)
  readonly property string path: decodeURIComponent(
      Qt.resolvedUrl("bin/omengram-anki").toString().replace(/^file:\/\//, ""))

  property var status: ({})
  readonly property bool running: syncer.running
  property int now: Math.floor(Date.now() / 1000)
  readonly property var line: Anki.syncLine(root.status, root.now, root.running)

  // A sync finished, here or on another surface: the stamp it left changed.
  signal synced(var status)

  function syncNow() {
    if (!root.inUse || syncer.running) return
    syncer.running = true
  }

  function read() {
    if (!root.statusRel || reader.running) return
    reader.running = true
  }

  Component.onCompleted: root.read()

  Process {
    id: syncer
    command: [root.path, "sync", JSON.stringify(root.profile ? { profile: root.profile } : {})]
    stdout: StdioCollector { id: syncOut; waitForEnd: true }
    onExited: root.read()
  }

  Process {
    id: reader
    command: ["sh", "-c", Anki.READ_SH, "omengram-sync", root.home, root.statusRel]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var next = Anki.parseSyncStatus(text)
        var changed = next.lastAttempt !== root.status.lastAttempt
        root.status = next
        root.now = Math.floor(Date.now() / 1000)
        if (changed && next.lastAttempt) root.synced(next)
      }
    }
  }

  // Once shortly after the bar starts, when the network has had a moment to
  // come up after login, then on the interval.
  Timer {
    id: first
    interval: 30000
    running: root.inUse && root.runsTimer && root.interval > 0
    onTriggered: root.syncNow()
  }

  Timer {
    interval: Math.max(1, root.interval) * 60000
    running: root.inUse && root.runsTimer && root.interval > 0 && !first.running
    repeat: true
    onTriggered: root.syncNow()
  }

  // Keeps "3 min ago" honest, and picks up a sync another surface ran.
  Timer {
    interval: 60000
    running: root.inUse
    repeat: true
    onTriggered: root.read()
  }
}
