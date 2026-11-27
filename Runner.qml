import QtQuick
import Quickshell.Io

// Runs a drill's solution against its tests through bin/omengram-run, which
// does it inside bubblewrap. One run at a time; a new run or cancel() stops the
// one before, and a result that comes back for a run since replaced is dropped.
Item {
  id: root

  readonly property string path: decodeURIComponent(
      Qt.resolvedUrl("bin/omengram-run").toString().replace(/^file:\/\//, ""))
  readonly property bool running: proc.running
  // bridge/run.py's verdict for the latest run, or null.
  property var result: null

  property int seq: 0
  property string request: ""

  function run(lang, solution, harness) {
    root.cancel()
    root.seq++
    root.request = JSON.stringify({ lang: lang || "python", solution: solution, harness: harness })
    proc.seq = root.seq
    proc.stdinEnabled = true
    proc.running = true
  }

  function cancel() {
    root.seq++
    root.result = null
    if (proc.running) proc.running = false
  }

  // Passed and total, for the review log; null unless the tests ran.
  function tally() {
    var r = root.result
    if (!r || r.status !== "ran" || !r.cases) return null
    return { pass: r.cases.filter(function(c) { return c.pass }).length, total: r.cases.length }
  }

  Process {
    id: proc
    property int seq: 0
    command: [root.path]
    stdinEnabled: true
    onStarted: {
      write(root.request)
      stdinEnabled = false
    }
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (proc.seq !== root.seq) return
        var lines = text.trim().split("\n")
        var r = null
        try { r = JSON.parse(lines[lines.length - 1]) } catch (e) {}
        root.result = r && r.status ? r
            : { status: "unavailable", message: "The test runner gave no answer." }
      }
    }
  }
}
