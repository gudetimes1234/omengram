import QtQuick
import qs.Commons
import qs.Ui

// How syncing with AnkiWeb stands, in one line, and the button that syncs now.
// The surface that has no room for a button shows the line alone.
Item {
  id: root

  property var sync: null
  property bool showButton: true

  property color foreground: Color.foreground
  property color accent: Color.accent
  property color urgent: Color.urgent
  property string fontFamily: Style.font.family

  readonly property var line: root.sync ? root.sync.line : ({ text: "", urgent: false })

  implicitHeight: Math.max(label.implicitHeight, button.visible ? button.implicitHeight : 0)

  Text {
    id: label
    textFormat: Text.PlainText
    anchors.left: parent.left
    anchors.right: button.visible ? button.left : parent.right
    anchors.rightMargin: button.visible ? Style.spacing.sm : 0
    anchors.verticalCenter: parent.verticalCenter
    horizontalAlignment: root.showButton ? Text.AlignLeft : Text.AlignHCenter
    wrapMode: Text.Wrap
    text: root.line.text
    color: root.line.urgent ? root.urgent : root.foreground
    opacity: root.line.urgent ? 1.0 : 0.55
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
  }

  Button {
    id: button
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    visible: root.showButton
    enabled: root.sync && !root.sync.running
    text: root.sync && root.sync.running ? "Syncing…" : "Sync"
    bordered: true
    foreground: root.foreground
    accent: root.accent
    fontFamily: root.fontFamily
    fontSize: Style.font.caption
    onClicked: if (root.sync) root.sync.syncNow()
  }
}
