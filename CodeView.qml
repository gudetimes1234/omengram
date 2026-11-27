import QtQuick
import qs.Commons

// Code as code: monospace, on its own panel, left-aligned, whitespace kept.
// Plain text like every other sink here; nothing in it is interpreted.
Rectangle {
  id: root

  property string code: ""
  // A caption above it: the language, or what the code is.
  property string label: ""
  property color foreground: Color.foreground
  property real fontSize: Style.font.body

  implicitHeight: column.implicitHeight + Style.spacing.md * 2
  color: Util.alpha(root.foreground, 0.06)
  radius: Style.cornerRadius

  Column {
    id: column
    x: Style.spacing.md
    y: Style.spacing.md
    width: root.width - Style.spacing.md * 2
    spacing: Style.spacing.xs

    Text {
      textFormat: Text.PlainText
      visible: root.label !== ""
      text: root.label
      color: root.foreground
      opacity: 0.45
      font.family: "monospace"
      font.pixelSize: Style.font.caption
    }

    Text {
      textFormat: Text.PlainText
      width: parent.width
      // Wrapped rather than scrolled: the bar panel is narrow, and a line cut
      // off at the edge reads as a line that ends there.
      wrapMode: Text.WrapAnywhere
      text: root.code
      color: root.foreground
      font.family: "monospace"
      font.pixelSize: root.fontSize
    }
  }
}
