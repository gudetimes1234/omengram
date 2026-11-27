import QtQuick
import qs.Commons

// The tests' verdict on what was typed: each case passed or failed, what it
// expected and got, and anything the solution printed. Feedback only; the
// grade is still yours.
Rectangle {
  id: root

  property var result: null
  property bool running: false
  property color foreground: Color.foreground
  property color accent: Color.accent
  property color urgent: Color.urgent
  property real fontSize: Style.font.body

  readonly property var cases: root.result && root.result.cases ? root.result.cases : []
  readonly property int passed: root.cases.filter(function(c) { return c.pass }).length

  function headline() {
    if (root.running) return "running the tests…"
    var r = root.result
    if (!r) return ""
    if (r.status === "ran")
      return root.cases.length === 0 ? "the tests ran, but checked nothing"
          : root.passed === root.cases.length ? "all " + root.cases.length + " tests pass"
          : root.passed + " of " + root.cases.length + " tests pass"
    if (r.status === "timeout") return "stopped after 8 seconds: an endless loop?"
    if (r.status === "unavailable") return r.message || "the tests cannot run here"
    var where = r.line ? " (" + (r.file || "solution.py") + ", line " + r.line + ")" : ""
    return (r.message || "the run failed") + where
  }

  readonly property bool good: !!root.result && root.result.status === "ran"
      && root.cases.length > 0 && root.passed === root.cases.length

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
      width: parent.width
      wrapMode: Text.Wrap
      text: "tests  ·  " + root.headline()
      color: root.good ? root.accent
          : (root.result && root.result.status !== "ran" && !root.running) ? root.urgent : root.foreground
      opacity: root.running ? 0.55 : 1
      font.family: "monospace"
      font.pixelSize: Style.font.caption
    }

    Repeater {
      model: root.running ? [] : root.cases

      Text {
        required property var modelData
        textFormat: Text.PlainText
        width: column.width
        wrapMode: Text.WrapAnywhere
        text: (modelData.pass ? "✓ " : "✗ ") + modelData.label
            + (modelData.pass ? "" : "\n    expected " + modelData.expected + ", got " + modelData.actual)
        color: modelData.pass ? root.foreground : root.urgent
        opacity: modelData.pass ? 0.7 : 1
        font.family: "monospace"
        font.pixelSize: root.fontSize
      }
    }

    Text {
      textFormat: Text.PlainText
      width: parent.width
      visible: !root.running && !!root.result && !!root.result.stdout
      wrapMode: Text.WrapAnywhere
      maximumLineCount: 12
      elide: Text.ElideRight
      text: root.result && root.result.stdout ? "printed:\n" + root.result.stdout.replace(/\s+$/, "") : ""
      color: root.foreground
      opacity: 0.55
      font.family: "monospace"
      font.pixelSize: Style.font.caption
    }
  }
}
