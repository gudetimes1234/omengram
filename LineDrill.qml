import QtQuick
import qs.Commons
import "Drill.js" as Drill

// Line Drill: the solution typed one line at a time into blanks shaped like
// the lines they hold, each checked as it is submitted (Drill.line*). Like
// the editor, it keeps its own keys while it has focus:
//
//   Enter    submit the line           Ctrl+H   hint for this line
//   Ctrl+E   show me this line         Ctrl+Y   why this line
//   Ctrl+P   try another pattern       Ctrl+L   free typing instead
//   Esc      hand the keys back (or drop a proposed pattern)
Item {
  id: root

  // Drill.lineStart's state; the owner keeps it and passes it back in.
  property var drill: null
  property color foreground: Color.foreground
  property color accent: Color.accent
  property color urgent: Color.urgent
  property real fontSize: Style.font.body
  readonly property bool editing: input.activeFocus
  readonly property string typing: input.text

  // The new state, after a key here changed it.
  signal stepped(var next)
  signal finished()
  signal escaped()
  signal freeTypingRequested()

  property string outcome: ""

  function focusInput() {
    input.forceActiveFocus()
  }

  readonly property var shown: root.drill ? Drill.lineDisplayed(root.drill) : null
  readonly property var progress: root.drill ? Drill.lineProgress(root.drill) : ({ done: 0, total: 0 })
  readonly property var step: root.drill ? Drill.lineCurrentStep(root.drill) : null
  readonly property var ways: root.drill ? Drill.lineCurrentNotes(root.drill) : []
  readonly property var explained: root.drill ? Drill.lineExplanation(root.drill) : null
  readonly property var open: root.drill ? Drill.lineShownHere(root.drill) : ({ hint: false, why: false })
  readonly property var lockedIn: root.drill ? Drill.lineLockedIn(root.drill) : null
  readonly property string picking: root.drill ? root.drill.picking : ""
  readonly property real charWidth: metrics.averageCharacterWidth
  readonly property real rowHeight: Math.ceil(metrics.height * 1.25)
  readonly property var rows: root.drill ? Drill.lineSkeleton(root.drill) : []
  readonly property int activeIndex: {
    for (var i = 0; i < root.rows.length; i++) if (root.rows[i].kind === "active") return i
    return -1
  }

  FontMetrics {
    id: metrics
    font.family: "monospace"
    font.pixelSize: root.fontSize
  }

  function apply(next, outcome) {
    root.outcome = outcome || ""
    root.stepped(next)
    if (Drill.lineComplete(next)) root.finished()
  }

  function nameOf(slug) {
    var ps = root.drill ? root.drill.patterns : []
    for (var i = 0; i < ps.length; i++) if (ps[i].slug === slug) return ps[i].name
    return slug
  }

  implicitHeight: column.implicitHeight

  Column {
    id: column
    width: root.width
    spacing: Style.spacing.sm

    // Pattern, step and progress.
    Text {
      textFormat: Text.PlainText
      width: parent.width
      wrapMode: Text.Wrap
      text: !root.shown ? "" : [
        root.shown.name + (root.lockedIn ? " (the lines you typed chose this one)" : ""),
        root.step ? "step " + (root.step.index + 1) + " of " + root.step.count + ": " + root.step.title : "",
        root.progress.done + " / " + root.progress.total + " lines",
        root.ways.length > 1 ? root.ways.length + " ways from here" : ""
      ].filter(function(s) { return s }).join("  ·  ")
      color: root.foreground
      opacity: 0.6
      font.family: "monospace"
      font.pixelSize: Style.font.caption
    }

    // The code column: one row per line, at a fixed height, so the one
    // input can sit over whichever row is the active blank and keep its
    // focus while the rows around it change.
    Rectangle {
      width: parent.width
      implicitHeight: code.height + Style.spacing.md * 2
      color: Util.alpha(root.foreground, 0.06)
      radius: Style.cornerRadius
      border.width: Math.max(1, Style.space(1))
      border.color: input.activeFocus ? Util.alpha(root.accent, 0.6) : "transparent"

      MouseArea {
        anchors.fill: parent
        cursorShape: Qt.IBeamCursor
        onClicked: root.focusInput()
      }

      Item {
        id: code
        x: Style.spacing.md
        y: Style.spacing.md
        width: parent.width - Style.spacing.md * 2
        height: root.rows.length * root.rowHeight

        Repeater {
          model: root.rows

          Item {
            required property var modelData
            required property int index
            y: index * root.rowHeight
            width: code.width
            height: root.rowHeight

            Text {
              textFormat: Text.PlainText
              visible: modelData.kind === "given" || modelData.kind === "locked"
              x: modelData.kind === "locked" ? modelData.indent * root.charWidth : 0
              width: parent.width - x
              anchors.verticalCenter: parent.verticalCenter
              elide: Text.ElideRight
              text: modelData.text || ""
              color: modelData.kind === "locked" && modelData.revealed ? root.accent : root.foreground
              opacity: modelData.kind === "given" ? 0.5 : 1
              font.family: "monospace"
              font.pixelSize: root.fontSize
            }

            // A blank: its shape, not its text.
            Rectangle {
              visible: modelData.kind === "blank" || modelData.kind === "active"
              x: (modelData.indent || 0) * root.charWidth
              y: parent.height - height - 1
              width: Math.max((modelData.width || 0) * root.charWidth,
                              modelData.kind === "active" ? input.contentWidth : 0)
              height: Math.max(1, Style.space(modelData.kind === "active" ? 2 : 1))
              color: modelData.kind === "active"
                  ? (root.outcome === "miss" ? root.urgent : root.accent) : root.foreground
              opacity: modelData.kind === "active" ? 0.9 : 0.3
            }
          }
        }

        TextInput {
          id: input
          readonly property var slot: root.activeIndex >= 0 ? root.rows[root.activeIndex] : null
          visible: !!slot
          enabled: visible
          x: slot ? slot.indent * root.charWidth : 0
          y: root.activeIndex * root.rowHeight + (root.rowHeight - height) / 2
          width: code.width - x
          color: root.foreground
          selectionColor: Util.alpha(root.accent, 0.35)
          selectedTextColor: root.foreground
          font.family: "monospace"
          font.pixelSize: root.fontSize
          Keys.onPressed: function(event) { root.handleKey(event, input) }
        }
      }
    }

    // A pattern proposed with Ctrl+P, waiting for a yes.
    Text {
      textFormat: Text.PlainText
      width: parent.width
      wrapMode: Text.Wrap
      visible: root.picking !== ""
      text: "switch to " + root.nameOf(root.picking)
          + (root.drill && Drill.lineDroppedBy(root.drill, root.picking) > 0
             ? "? it drops " + Drill.lineDroppedBy(root.drill, root.picking) + " of your lines" : "?")
          + "  ·  enter yes  ·  ctrl+p next  ·  esc no"
      color: root.accent
      font.family: "monospace"
      font.pixelSize: Style.font.caption
    }

    Text {
      textFormat: Text.PlainText
      width: parent.width
      visible: root.outcome === "miss" && !!root.drill
      text: "not that line" + (root.drill && Drill.lineMissesHere(root.drill) > 1
                               ? " (" + Drill.lineMissesHere(root.drill) + " tries)" : "")
            + "  ·  ctrl+h hint  ·  ctrl+e show me"
      color: root.urgent
      font.family: "monospace"
      font.pixelSize: Style.font.caption
    }

    // The hint and why for the line to come, once asked for.
    Repeater {
      model: root.open.hint || root.open.why ? root.ways : []

      Text {
        required property var modelData
        textFormat: Text.PlainText
        width: column.width
        wrapMode: Text.Wrap
        text: (root.ways.length > 1 ? modelData.pattern.name + ": " : "")
            + modelData.notes.map(function(n) {
                return [root.open.hint ? "hint: " + n.hint : "", root.open.why ? "why: " + n.why : ""]
                    .filter(function(s) { return s }).join("\n")
              }).join("\n")
        color: root.foreground
        opacity: 0.85
        font.family: "monospace"
        font.pixelSize: Style.font.caption
      }
    }

    // The line just locked, explained: free.
    Text {
      textFormat: Text.PlainText
      width: parent.width
      wrapMode: Text.Wrap
      visible: !!root.explained && root.explained.notes.length > 0 && !root.open.hint && !root.open.why
      text: root.explained
          ? root.explained.notes.map(function(n) { return n.pseudo.trim() + "  —  " + n.why }).join("\n") : ""
      color: root.foreground
      opacity: 0.55
      font.family: "monospace"
      font.pixelSize: Style.font.caption
    }
  }

  function handleKey(event, field) {
    var ctrl = (event.modifiers & Qt.ControlModifier) !== 0
    var s = root.drill
    if (!s) return
    if (event.key === Qt.Key_Escape) {
      if (s.picking) root.apply(Drill.lineCancelPick(s), "")
      else root.escaped()
      event.accepted = true
    } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
      if (s.picking) { root.apply(Drill.lineConfirmPick(s), ""); event.accepted = true; return }
      var r = Drill.lineSubmit(s, field.text)
      if (r.outcome !== Drill.MISS) field.text = ""
      root.apply(r.state, r.outcome)
      event.accepted = true
    } else if (ctrl && event.key === Qt.Key_H) {
      root.apply(Drill.lineShowNote(s, true), root.outcome); event.accepted = true
    } else if (ctrl && event.key === Qt.Key_Y) {
      root.apply(Drill.lineShowNote(s, false), root.outcome); event.accepted = true
    } else if (ctrl && event.key === Qt.Key_E) {
      field.text = ""
      root.apply(Drill.lineReveal(s), "revealed"); event.accepted = true
    } else if (ctrl && event.key === Qt.Key_P) {
      root.apply(Drill.lineCyclePick(s), root.outcome); event.accepted = true
    } else if (ctrl && event.key === Qt.Key_L) {
      root.freeTypingRequested(); event.accepted = true
    } else if (event.key === Qt.Key_Tab || event.key === Qt.Key_Backtab) {
      // Indentation is the blank's, not typed: keep Tab from leaving.
      event.accepted = true
    }
  }
}
