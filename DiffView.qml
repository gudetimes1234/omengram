import QtQuick
import qs.Commons
import "Drill.js" as Drill

// What was typed against the answer, line by line: lines in both as they are,
// answer lines not typed marked "+", typed lines not in the answer marked "-".
// Something to look at before grading yourself, never a grade.
Rectangle {
  id: root

  // Drill.diff's result.
  property var result: null
  property color foreground: Color.foreground
  property color accent: Color.accent
  property color urgent: Color.urgent
  property real fontSize: Style.font.body

  implicitHeight: column.implicitHeight + Style.spacing.md * 2
  color: Util.alpha(root.foreground, 0.06)
  radius: Style.cornerRadius

  Column {
    id: column
    x: Style.spacing.md
    y: Style.spacing.md
    width: root.width - Style.spacing.md * 2
    spacing: 0

    Text {
      textFormat: Text.PlainText
      width: parent.width
      bottomPadding: Style.spacing.xs
      text: "your answer  ·  " + Drill.summary(root.result)
      color: root.result && root.result.same ? root.accent : root.foreground
      opacity: root.result && root.result.same ? 1 : 0.55
      font.family: "monospace"
      font.pixelSize: Style.font.caption
    }

    Repeater {
      model: root.result ? root.result.lines : []

      Text {
        required property var modelData
        textFormat: Text.PlainText
        width: column.width
        wrapMode: Text.WrapAnywhere
        text: (modelData.op === "missing" ? "+ " : modelData.op === "extra" ? "- " : "  ") + modelData.text
        color: modelData.op === "missing" ? root.accent : modelData.op === "extra" ? root.urgent : root.foreground
        opacity: modelData.op === "same" ? 0.7 : 1
        font.family: "monospace"
        font.pixelSize: root.fontSize
      }
    }
  }
}
