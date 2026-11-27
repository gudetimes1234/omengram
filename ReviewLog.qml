import QtQuick
import Quickshell
import Quickshell.Io
import "Anki.js" as Anki

// The review log: one line per answer to a library card, in a file per month
// under the state directory (see APPEND_SH in Anki.js). Appending is all this
// ever does to the files; an undo is a record of its own.
//
// `answers` holds the last two months as parseLog gives them, read when asked
// and kept up to date with what this surface appends. Another surface's
// answers arrive on the next read().
Item {
  id: root

  property string stateDir: ""
  readonly property string home: Quickshell.env("HOME")
  readonly property string dirRel: Anki.relativeToHome(root.stateDir + "/omengram", root.home)

  property var answers: []
  property bool loaded: false

  // Records waiting for the appender, oldest first. One process at a time, so
  // the order on disk is the order they were made in.
  property var pending: []

  // What this surface appended and undid, by rid, so a read that lands before
  // an append does neither drops the answer nor brings an undone one back.
  property var mine: ({})
  property var undone: ({})

  function append(rec) {
    var line = Anki.serializeRecord(rec)
    if (!line || !root.dirRel) return
    root.pending = root.pending.concat([{ rel: root.dirRel + "/" + Anki.logName(rec.at), line: line }])
    if (rec.op === "undo") {
      var rid = rec.rid
      root.undone[rid] = true
      root.answers = root.answers.filter(function(r) { return r.rid !== rid })
    } else {
      root.mine[rec.rid] = rec
      root.answers = root.answers.concat([rec])
    }
    root.flush()
  }

  function flush() {
    if (appender.running || !root.pending.length) return
    var next = root.pending[0]
    root.pending = root.pending.slice(1)
    appender.rel = next.rel
    appender.line = next.line
    appender.stdinEnabled = true
    appender.running = true
  }

  function read() {
    if (!root.dirRel || reader.running) return
    var names = Anki.logNames(Math.floor(Date.now() / 1000))
    reader.command = ["sh", "-c", Anki.LOGTAIL_SH, "omengram-log", root.home,
                      root.dirRel + "/" + names[0]].concat(names.slice(1))
    reader.running = true
  }

  Process {
    id: appender
    property string rel: ""
    property string line: ""
    command: ["sh", "-c", Anki.APPEND_SH, "omengram-log-append", root.home, appender.rel]
    stdinEnabled: true
    onStarted: {
      write(line)
      line = ""
      // Closing stdin ends the record; flush reopens it for the next one.
      stdinEnabled = false
    }
    onExited: function(code) {
      if (code !== 0) console.log("omengram: could not append to the review log (" + code + ")")
      Qt.callLater(root.flush)
    }
  }

  Process {
    id: reader
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var read = Anki.parseLog(text).filter(function(r) { return !root.undone[r.rid] })
        var seen = {}
        read.forEach(function(r) { seen[r.rid] = true })
        for (var rid in root.mine)
          if (!seen[rid] && !root.undone[rid]) read.push(root.mine[rid])
        read.sort(function(a, b) { return a.at - b.at })
        root.answers = read
        root.loaded = true
      }
    }
  }
}
