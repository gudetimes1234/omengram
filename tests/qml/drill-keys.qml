import QtQuick
import QtTest
import Quickshell
import qs.Commons
import "plugin" as P
import "plugin/Anki.js" as Anki

// Typing a drill in the reviewer with real key presses. Run by tests/qml/run.sh.
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
        check("a new drill opens in Line Drill", rev.typing && rev.lining && !rev.revealed, [rev.typing, rev.lining])
        w.key(Qt.Key_L, Qt.ControlModifier)
        return function() { return rev.typing && !rev.lining } },
      function() {
        check("ctrl+l switches to free typing, keeping the keys", rev.typing && rev.canType && !rev.lining, [rev.typing, rev.lining])
        w.type("1a4 ")
        return function() { return rev.typed.length > 0 } },
      function() {
        check("digits and letters typed are text, not shortcuts", rev.typed === "1a4 " && w.graded === 0 && w.lastKey === "", [rev.typed, w.graded, w.lastKey])
        w.key(Qt.Key_Backspace); w.key(Qt.Key_Backspace); w.key(Qt.Key_Backspace); w.key(Qt.Key_Backspace)
        w.type("def has_repeat(values):"); w.key(Qt.Key_Return)
        w.type("seen = set()"); w.key(Qt.Key_Return)
        w.type("for v in values:"); w.key(Qt.Key_Return)
        w.type("if v in seen: return True"); w.key(Qt.Key_Return)
        w.type("seen.add(v)"); w.key(Qt.Key_Return)
        w.key(Qt.Key_Backtab)
        w.type("return False")
        return function() { return rev.typed.indexOf("return False") >= 0 } },
      function() {
        check("enter indents like the line above, one more after a colon", rev.typed.indexOf("\n    seen = set()\n    for v in values:\n        if v") >= 0, rev.typed)
        check("shift+tab outdents", rev.typed.indexOf("\n    return False") >= 0, rev.typed)
        check("this drill has tests to run", rev.canRun, rev.currentDrill)
        w.key(Qt.Key_R, Qt.ControlModifier)
        return function() { return rev.runResult !== null && !rev.runningTests } },
      function() {
        var r = rev.runResult
        check("ctrl+r runs the tests in the sandbox", r && r.status === "ran" && r.cases.length === 3
              && r.cases.every(function(c) { return c.pass }), r)
        check("running does not reveal, and the editor keeps the keys", !rev.revealed && rev.typing, [rev.revealed, rev.typing])
        w.key(Qt.Key_Escape)
        return function() { return !rev.typing } },
      function() {
        check("esc gives the keys back", !rev.typing && keyCatcher.activeFocus, [rev.typing, keyCatcher.activeFocus])
        w.type("i")
        return function() { return rev.typing } },
      function() {
        check("i goes back to typing, keeping what was typed", rev.typing && rev.typed.indexOf("return False") >= 0, rev.typed)
        w.key(Qt.Key_Return, Qt.ControlModifier)
        return function() { return rev.revealed } },
      function() {
        check("ctrl+enter checks and reveals", rev.revealed && rev.checkResult !== null, rev.checkResult)
        check("the diff sees the one line written differently", rev.checkResult.matched === 5 && rev.checkResult.total === 7, rev.checkResult)
        check("logged as typed", rev.answerMode === "free", rev.answerMode)
        check("keys are back for grading", keyCatcher.activeFocus, keyCatcher.activeFocus)
        w.type("3")
        return function() { return w.graded === 1 } },
      function() {
        var rec = rev.reviewLog.answers[0]
        check("3 grades once the answer is checked", w.graded === 1 && rev.reviewLog.answers.length === 1 && rec.mode === "free", rev.reviewLog.answers)
        check("the log has the drill's kind and its test results", rec.kind === "code" && rec.tests && rec.tests.pass === 3 && rec.tests.total === 3, rec)
        return function() { return rev.typing } },
      function() {
        check("the next drill opens in the editor, empty", rev.typing && rev.typed === "" && !rev.checkResult && !rev.runResult, [rev.typing, rev.typed])
        check("a typed card has no tests to run", !rev.canRun, rev.canRun)
        check("a typed card is typed too", rev.currentDrill && rev.currentDrill.kind === "type", rev.currentDrill)
        w.key(Qt.Key_Escape)
        return function() { return !rev.typing } },
      function() {
        w.key(Qt.Key_Space)
        return function() { return rev.revealed } },
      function() {
        check("space without typing is a plain reveal", rev.revealed && rev.checkResult === null && rev.answerMode === "recall", [rev.checkResult, rev.answerMode])
      }
    ]
  }
}
