import QtQuick
import Quickshell
import "plugin" as P
import "plugin/Anki.js" as Anki

// The "is this working" line on both statistics views: a deck nothing has been
// answered in says so, and one that has shows its numbers. Run by
// tests/qml/run.sh.
ShellRoot {
  FloatingWindow {
    id: w
    implicitWidth: 760; implicitHeight: 900
    color: "#1a1b26"
    property int fails: 0
    function check(name, ok, extra) { if (!ok) fails++; console.log((ok ? "OK   " : "FAIL ") + name + (ok ? "" : "  got " + JSON.stringify(extra))) }

    readonly property var fresh: Anki.mergeStats(Anki.deckStats(
        Anki.parseDeck(JSON.stringify([{ front: "q", back: "a" }])).cards, { reviews: {} }, 1795700000, 20, 0, []), null)
    readonly property var answered: Object.assign({}, w.fresh, {
        seen: 1, lapsed: 2, retention: 0.75, retentionReviews: 4, retentionLabel: "passed, last 30 days" })

    Column {
      width: 720; x: 20; y: 20
      P.StatsView { id: big; width: 720; stats: w.fresh; tab: 2 }
      P.PanelStats { id: small; width: 340; stats: w.fresh; tab: 2 }
    }

    function texts(item, out) {
      out = out || []
      if (item.text !== undefined && typeof item.text === "string" && item.visible) out.push(item.text)
      for (var i = 0; i < item.children.length; i++) texts(item.children[i], out)
      return out
    }
    function shows(item, s) { return texts(item).indexOf(s) !== -1 }
    function showsPart(item, s) { return texts(item).some(function(t) { return t.indexOf(s) !== -1 }) }

    Timer {
      interval: 300; running: true
      onTriggered: {
        w.check("the overlay says a fresh deck has no reviews yet", w.shows(big, "no reviews yet"), w.texts(big))
        w.check("so does the panel", w.shows(small, "no reviews yet"), w.texts(small))
        w.check("and the lifetime note is not shown for it", !w.showsPart(big, "A lifetime figure"), w.texts(big))
        big.stats = w.answered
        small.stats = w.answered
        w.check("an answered deck shows its retention in the overlay",
                w.shows(big, "75% passed, last 30 days  ·  2 lapsed cards"), w.texts(big))
        w.check("and in the panel", w.shows(small, "75% passed, last 30 days  ·  2 lapsed"), w.texts(small))
        console.log("DONE fails=" + w.fails)
        Qt.quit()
      }
    }
  }
}
