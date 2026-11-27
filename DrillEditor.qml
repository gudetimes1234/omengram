import QtQuick
import qs.Commons
import "Drill.js" as Drill

// Where an answer is typed: plain text, monospace, with the few things code
// needs. It keeps its own keys while it has focus, so nothing typed into it
// ever reaches the overlay's shortcuts: a 1 is a 1, not "Again".
//
//   Ctrl+Enter   check          Esc        hand the keys back
//   Ctrl+R       run the tests  Tab        indent (or the selected lines)
//   Enter        new line, indented like the last; one more after ":"
//   Shift+Tab    outdent        Ctrl+L     Line Drill, when the card has one
Rectangle {
  id: root

  property alias text: edit.text
  property string placeholder: ""
  property color foreground: Color.foreground
  property color accent: Color.accent
  property real fontSize: Style.font.body
  // Spaces per level; Python's four.
  property int indentWidth: 4
  property bool canRun: false
  property bool canLine: false
  readonly property bool editing: edit.activeFocus

  signal submitted()
  signal escaped()
  signal runRequested()
  signal lineDrillRequested()

  function focusEditor() {
    edit.forceActiveFocus()
    edit.cursorPosition = edit.length
  }

  function clear() {
    edit.text = ""
  }

  implicitHeight: Math.max(edit.implicitHeight, root.fontSize * 5) + Style.spacing.md * 2
  color: Util.alpha(root.foreground, 0.06)
  radius: Style.cornerRadius
  border.width: Math.max(1, Style.space(1))
  border.color: edit.activeFocus ? Util.alpha(root.accent, 0.6) : Util.alpha(root.foreground, 0.12)

  MouseArea {
    anchors.fill: parent
    cursorShape: Qt.IBeamCursor
    onClicked: root.focusEditor()
  }

  Text {
    textFormat: Text.PlainText
    x: Style.spacing.md
    y: Style.spacing.md
    width: root.width - Style.spacing.md * 2
    visible: edit.length === 0
    wrapMode: Text.Wrap
    text: root.placeholder
    color: root.foreground
    opacity: 0.3
    font.family: "monospace"
    font.pixelSize: root.fontSize
  }

  TextEdit {
    id: edit
    x: Style.spacing.md
    y: Style.spacing.md
    width: root.width - Style.spacing.md * 2
    textFormat: TextEdit.PlainText
    wrapMode: TextEdit.WrapAnywhere
    color: root.foreground
    selectionColor: Util.alpha(root.accent, 0.35)
    selectedTextColor: root.foreground
    font.family: "monospace"
    font.pixelSize: root.fontSize
    persistentSelection: false
    selectByMouse: true

    Keys.onPressed: function(event) {
      var ctrl = (event.modifiers & Qt.ControlModifier) !== 0
      var shift = (event.modifiers & Qt.ShiftModifier) !== 0
      if (event.key === Qt.Key_Escape) {
        root.escaped()
        event.accepted = true
      } else if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter) && ctrl) {
        root.submitted()
        event.accepted = true
      } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
        var pad = Drill.autoIndent(edit.text, edit.cursorPosition, root.indentWidth)
        edit.remove(edit.selectionStart, edit.selectionEnd)
        edit.insert(edit.cursorPosition, "\n" + pad)
        event.accepted = true
      } else if (event.key === Qt.Key_L && ctrl) {
        if (root.canLine) root.lineDrillRequested()
        event.accepted = true
      } else if (event.key === Qt.Key_R && ctrl) {
        if (root.canRun) root.runRequested()
        event.accepted = true
      } else if (event.key === Qt.Key_Backtab || (event.key === Qt.Key_Tab && shift)) {
        root.shift(true)
        event.accepted = true
      } else if (event.key === Qt.Key_Tab) {
        if (edit.selectionStart !== edit.selectionEnd) root.shift(false)
        else edit.insert(edit.cursorPosition, new Array(root.indentWidth + 1).join(" "))
        event.accepted = true
      }
    }
  }

  function shift(out) {
    var r = Drill.shiftLines(edit.text, edit.selectionStart, edit.selectionEnd, root.indentWidth, out)
    var cursorAtEnd = edit.cursorPosition === edit.selectionEnd
    edit.text = r.text
    if (r.start === r.end) edit.cursorPosition = r.start
    else if (cursorAtEnd) edit.select(r.start, r.end)
    else edit.select(r.end, r.start)
  }
}
