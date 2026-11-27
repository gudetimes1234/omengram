import QtQuick
import QtTest
import Quickshell
import qs.Commons
import "plugin" as P
import "plugin/Anki.js" as Anki

// Line Drill in the reviewer with real key presses. Run by tests/qml/run.sh.
ShellRoot {
  FloatingWindow {
    id: w
    implicitWidth: 760; implicitHeight: 900
    color: "#1a1b26"
    property int fails: 0
    function check(name, ok, extra) { if (!ok) fails++; console.log((ok ? "OK   " : "FAIL ") + name + (ok ? "" : "  got " + JSON.stringify(extra))) }
    readonly property string home: Quickshell.env("HOME")
    TestEvent { id: ev }
    property string lastKey: ""
    property int graded: 0
    Rectangle { id: stage; width: 760; height: 900; color: "#1a1b26"
      // Stands in for the overlay's key catcher: a sibling of the reviewer.
      Item {
        id: keyCatcher
        anchors.fill: parent
        focus: true
        Keys.onPressed: function(event) {
          var k = event.text ? event.text.toLowerCase() : ""
          w.lastKey = k
          if (k === "1") rev.answer("again")
          else if (k === "3") rev.answer("good")
          else if (k === "i") rev.startTyping()
          else if (event.key === Qt.Key_Space) rev.activate()
          else return
          event.accepted = true
        }
      }
      P.Reviewer {
        id: rev; x: 20; y: 20; width: 720; active: true; ankiEnabled: false; interactive: true
        foreground: "#c0caf5"; accent: "#7aa2f7"; urgent: "#f7768e"
        minFaceHeight: 300; maxFaceHeight: 840
        deckDir: w.home + "/.local/share/omengram"
        stateDir: w.home + "/.local/state/omarchy"
        onReleaseKeys: keyCatcher.forceActiveFocus()
        onGraded: w.graded++
      }
    }
    property var steps: []
    property int at: 0
    property int waited: 0
    property var until: null
    function type(s) { for (var i = 0; i < s.length; i++) ev.keyClickChar(s[i], 0, -1) }
    function key(k, mods) { ev.keyClick(k, mods || 0, -1) }
    Timer { interval: 300; repeat: true; running: true
      onTriggered: {
        if (w.until) { if (!w.until() && ++w.waited < 40) return; if (w.waited >= 40) console.log("TIMEOUT at step " + w.at); w.until = null; w.waited = 0 }
        if (w.at >= w.steps.length) { console.log("DONE fails=" + w.fails); Qt.quit(); return }
        try { var r = w.steps[w.at](); if (typeof r === "function") w.until = r } catch (e) { w.fails++; console.log("FAIL threw " + e + " at step " + w.at) }
        w.at++ } }
    Component.onCompleted: steps = [
      function() { return function() { return rev.phase === "reviewing" && rev.typing } },
      function() {
        check("a new drill with patterns opens in Line Drill", rev.lining && rev.answerMode === "line", [rev.lining, rev.answerMode])
        w.type("seen = set()"); w.key(Qt.Key_Return)
        return function() { return rev.lineState && rev.lineState.typed.length === 1 } },
      function() {
        check("a right line locks", rev.lineState.typed.length === 1 && rev.typing, rev.lineState)
        w.type("3"); w.key(Qt.Key_Return)
        return function() { return rev.lineState.misses[1] === 1 } },
      function() {
        check("a wrong line is a miss, and digits are text", rev.lineState.typed.length === 1 && w.graded === 0, [rev.lineState.misses, w.graded])
        w.key(Qt.Key_A, Qt.ControlModifier); w.key(Qt.Key_Backspace)
        w.key(Qt.Key_H, Qt.ControlModifier)
        return function() { return rev.lineState.shown[1] && rev.lineState.shown[1].hint } },
      function() {
        check("ctrl+h opens the hint", rev.lineState.shown[1].hint, rev.lineState.shown)
        w.key(Qt.Key_E, Qt.ControlModifier)
        return function() { return rev.lineState.typed.length === 2 } },
      function() {
        check("ctrl+e shows the line, as a reveal", rev.lineState.revealed[1] === true, rev.lineState.revealed)
        w.type("if v in seen:"); w.key(Qt.Key_Return)
        w.type("    return True"); w.key(Qt.Key_Return)
        w.type("seen.add(v)"); w.key(Qt.Key_Return)
        return function() { return rev.lineState.typed.length === 5 } },
      function() {
        check("the indentation is the blank's, not typed", rev.lineState.typed.length === 5 && !rev.revealed, rev.lineState.typed)
        w.key(Qt.Key_Escape)
        return function() { return !rev.typing } },
      function() {
        check("esc gives the keys back", keyCatcher.activeFocus && !rev.revealed, keyCatcher.activeFocus)
        w.type("i")
        return function() { return rev.typing && rev.lining } },
      function() {
        check("i goes back to the line being typed", rev.lining && rev.lineState.typed.length === 5, rev.lineState.typed)
        w.type("return False"); w.key(Qt.Key_Return)
        return function() { return rev.revealed } },
      function() {
        check("the last line in reveals the answer and gives the keys back", rev.revealed && keyCatcher.activeFocus, [rev.revealed, keyCatcher.activeFocus])
        w.type("3")
        return function() { return w.graded === 1 } },
      function() {
        var rec = rev.reviewLog.answers[0]
        check("logged as Line Drill, with the shown line as a reveal", rec && rec.mode === "line" && rec.revealed === true && rec.recall === false, rec)
      }
    ]
  }
}
