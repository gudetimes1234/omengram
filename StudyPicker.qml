import QtQuick
import qs.Commons
import "Anki.js" as Anki

// What to study, chosen in the panel: which decks, which tags, and how much of
// each a day.
//
// Everything here is a tick or a step, and each one is saved as it is made.
// That is what makes it safe in a popup: a form typed into something that
// closes on focus loss can lose what was typed, and this has nothing to lose.
//
// It owns no settings. The panel hands it what is chosen and it asks for
// changes, so the one copy stays the one the shell keeps. What it does own is
// the cursor, because a keyboard walks rows and only this knows what they are.
Item {
  id: root

  property var reviewer: null
  property var decks: []
  property var tags: []
  property var limits: ({})
  property int newPerDay: 20
  property int reviewsPerDay: 0

  // True while this is what the panel is showing.
  property bool active: false
  property int tab: 0
  property int maxHeight: Style.space(360)

  property color foreground: Color.foreground
  property color accent: Color.accent
  property string fontFamily: Style.font.family

  // A patch of settings to save.
  signal changed(var values)

  readonly property var tabs: ["DECKS", "TAGS", "LIMITS"]
  readonly property int count: root.tabs.length

  property int cursor: 0
  // Which limit of a row + and - change: 0 new, 1 reviews.
  property int column: 0

  readonly property int rowHeight: Style.font.bodySmall + Style.space(14)

  // Steps match the ones the settings declare in manifest.json.
  readonly property int newStep: 5
  readonly property int reviewStep: 10

  // Counted when the picker opens and when the library changes, not on the
  // session's one-second tick: rebuilding the rows every second would scroll
  // the list back and drop the hover under the pointer.
  property var deckRows: []

  readonly property var tagRows: root.reviewer && root.active
      ? Anki.tagRows(root.reviewer.pickedCards, root.tags) : []

  readonly property var rows: {
    if (root.tab === 0) return [root.everything("All decks")].concat(root.deckRows)
    if (root.tab === 1) return [root.everything("All tags")].concat(root.tagRows)
    // Only what is being studied, so a limit is set on the rows in play.
    var picked = root.scopeDecks
    return [root.everything("Whole day")].concat(root.deckRows.filter(function(r) {
      return !picked.length || Anki.nodeState(r.id, picked, Anki.DECK_SEP) !== "off"
    }))
  }

  readonly property var scopeDecks: root.reviewer ? root.reviewer.scopeDecks : root.decks

  function everything(name) {
    return { id: "", name: name, depth: 0, total: -1, due: 0, fresh: 0 }
  }

  function recount() {
    root.deckRows = root.reviewer
        ? Anki.deckRows(root.reviewer.library, root.reviewer.progress, root.reviewer.now) : []
  }

  onActiveChanged: if (root.active) { root.cursor = 0; list.contentY = 0; root.recount() }
  onTabChanged: { root.cursor = 0; list.contentY = 0 }
  onRowsChanged: if (root.cursor >= root.rows.length) root.cursor = Math.max(0, root.rows.length - 1)

  Connections {
    target: root.reviewer
    function onLibraryChanged() { if (root.active) root.recount() }
  }

  // ------------------------------------------------------------------ keys
  function move(dy) {
    root.cursor = Math.max(0, Math.min(root.rows.length - 1, root.cursor + dy))
    var top = root.cursor * root.rowHeight
    if (top < list.contentY) list.contentY = top
    else if (top + root.rowHeight > list.contentY + list.height)
      list.contentY = top + root.rowHeight - list.height
  }

  // On the limits there is nothing to tick, so it moves between the two
  // numbers instead.
  function activate() {
    if (root.tab === 2) root.column = 1 - root.column
    else root.toggle(root.rows[root.cursor])
  }

  function toggle(row) {
    if (!row) return
    // One file is not a library: there is nothing in it to pick between.
    if (root.tab === 0 && root.reviewer.singleFile) return
    if (root.tab === 0)
      root.changed({ decks: row.id ? Anki.toggleDeck(root.deckRows, root.decks, row.id) : [] })
    else if (root.tab === 1)
      root.changed({ tags: row.id ? Anki.toggleTag(root.tagRows, root.tags, row.id) : [] })
  }

  // The whole-day row reads and writes the two settings that have always been
  // there. A review cap of 0 there has always meant no cap, so it is shown and
  // stepped as one.
  function valueOf(row, kind) {
    if (!row) return null
    if (!row.id) {
      if (kind === "new") return root.newPerDay
      return root.reviewsPerDay > 0 ? root.reviewsPerDay : null
    }
    var l = root.limits[row.id]
    return l && l[kind] !== undefined ? l[kind] : null
  }

  function setValue(row, kind, value) {
    if (!row) return
    if (row.id) root.changed({ limits: Anki.withLimit(root.limits, row.id, kind, value) })
    else if (kind === "new") root.changed({ newPerDay: value === null ? 0 : value })
    else root.changed({ reviewsPerDay: value === null ? 0 : value })
  }

  function step(row, kind, direction) {
    var by = kind === "new" ? root.newStep : root.reviewStep
    root.setValue(row, kind, Anki.stepLimit(root.valueOf(row, kind), direction, by))
  }

  readonly property string columnKind: root.column === 0 ? "new" : "reviews"

  function adjust(direction) {
    if (root.tab === 2) root.step(root.rows[root.cursor], root.columnKind, direction)
  }

  // Back to no cap - which for new cards in a whole day is the default, since
  // there is no such thing as no cap there.
  function clear() {
    if (root.tab !== 2) return
    var row = root.rows[root.cursor]
    if (row && !row.id && root.columnKind === "new") root.changed({ newPerDay: 20 })
    else root.setValue(row, root.columnKind, null)
  }

  // ---------------------------------------------------------------- render
  implicitHeight: heading.height + list.height

  Item {
    id: heading
    width: parent.width
    height: visible ? headingNew.implicitHeight + Style.spacing.xs : 0
    visible: root.tab === 2

    Text {
      id: headingNew
      textFormat: Text.PlainText
      anchors.right: parent.right
      anchors.rightMargin: Style.space(6) + root.stepperWidth + Style.spacing.sm
      width: root.stepperWidth
      horizontalAlignment: Text.AlignHCenter
      text: "new"
      color: root.foreground
      opacity: 0.5
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }

    Text {
      textFormat: Text.PlainText
      anchors.right: parent.right
      anchors.rightMargin: Style.space(6)
      width: root.stepperWidth
      horizontalAlignment: Text.AlignHCenter
      text: "reviews"
      color: root.foreground
      opacity: 0.5
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
  }

  readonly property int stepperWidth: Style.space(76)

  Flickable {
    id: list
    anchors.top: heading.bottom
    width: parent.width
    height: Math.min(contentHeight, root.maxHeight)
    contentHeight: root.rows.length * root.rowHeight
    clip: true
    boundsBehavior: Flickable.StopAtBounds

    Column {
      width: list.width

      Repeater {
        model: root.rows

        Rectangle {
          id: row
          required property var modelData
          required property int index
          readonly property bool current: root.cursor === row.index
          readonly property string state_: {
            if (root.tab === 2) return "off"
            var picked = root.tab === 0 ? root.scopeDecks : root.tags
            if (!row.modelData.id) return picked.length ? "off" : "on"
            return Anki.nodeState(row.modelData.id, picked, root.tab === 0 ? Anki.DECK_SEP : Anki.TAG_SEP)
          }

          width: list.width
          height: root.rowHeight
          radius: Style.cornerRadius
          color: row.current ? Util.alpha(root.foreground, 0.08) : "transparent"

          // Under the row's own controls, so a stepper gets its clicks first.
          MouseArea {
            anchors.fill: parent
            cursorShape: root.tab === 2 ? Qt.ArrowCursor : Qt.PointingHandCursor
            onClicked: {
              root.cursor = row.index
              if (root.tab !== 2) root.toggle(row.modelData)
            }
          }

          // Filled for picked, a bar for partly picked.
          Rectangle {
            id: box
            visible: root.tab !== 2
            anchors.left: parent.left
            anchors.leftMargin: Style.space(6) + row.modelData.depth * Style.space(14)
            anchors.verticalCenter: parent.verticalCenter
            width: Style.font.bodySmall
            height: width
            radius: Math.min(Style.cornerRadius, Style.space(3))
            color: "transparent"
            border.width: Math.max(1, Style.space(1))
            border.color: row.state_ === "off" ? Util.alpha(root.foreground, 0.4) : root.accent

            Rectangle {
              anchors.centerIn: parent
              visible: row.state_ !== "off"
              width: parent.width - Style.space(6)
              height: row.state_ === "some" ? Style.space(2) : width
              radius: parent.radius / 2
              color: root.accent
            }
          }

          Text {
            textFormat: Text.PlainText
            anchors.left: box.visible ? box.right : parent.left
            anchors.leftMargin: box.visible ? Style.spacing.md
                : Style.space(6) + row.modelData.depth * Style.space(14)
            anchors.right: root.tab === 2 ? steppers.left : waiting.left
            anchors.rightMargin: Style.spacing.sm
            anchors.verticalCenter: parent.verticalCenter
            elide: Text.ElideRight
            text: row.modelData.name
            color: row.state_ === "on" ? root.accent : root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }

          Text {
            id: waiting
            textFormat: Text.PlainText
            visible: root.tab !== 2
            anchors.right: parent.right
            anchors.rightMargin: Style.space(6)
            anchors.verticalCenter: parent.verticalCenter
            text: {
              var m = row.modelData
              if (!m.id) return ""
              if (root.tab === 1) return String(m.total)
              var parts = []
              if (m.due > 0) parts.push(m.due + " due")
              if (m.fresh > 0) parts.push(m.fresh + " new")
              return parts.join("  ")
            }
            color: root.foreground
            opacity: 0.5
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          Row {
            id: steppers
            visible: root.tab === 2
            anchors.right: parent.right
            anchors.rightMargin: Style.space(6)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.spacing.sm

            Repeater {
              model: ["new", "reviews"]

              Rectangle {
                id: stepper
                required property string modelData
                required property int index
                readonly property var value: root.valueOf(row.modelData, stepper.modelData)
                readonly property bool focused: row.current && root.column === stepper.index

                width: root.stepperWidth
                height: root.rowHeight - Style.space(4)
                radius: Style.cornerRadius
                color: "transparent"
                border.width: Math.max(1, Style.space(1))
                border.color: stepper.focused ? root.accent : Util.alpha(root.foreground, 0.15)

                Text {
                  textFormat: Text.PlainText
                  anchors.centerIn: parent
                  text: stepper.value === null ? "—" : String(stepper.value)
                  color: stepper.value === null ? root.foreground : root.accent
                  opacity: stepper.value === null ? 0.4 : 1.0
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                }

                Repeater {
                  model: [-1, 1]

                  Item {
                    id: press
                    required property int modelData
                    width: stepper.width / 3
                    height: stepper.height
                    x: press.modelData < 0 ? 0 : stepper.width - width

                    Text {
                      textFormat: Text.PlainText
                      anchors.centerIn: parent
                      text: press.modelData < 0 ? "−" : "+"
                      color: root.foreground
                      opacity: area.containsMouse ? 1.0 : 0.4
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.bodySmall
                    }

                    MouseArea {
                      id: area
                      anchors.fill: parent
                      hoverEnabled: true
                      cursorShape: Qt.PointingHandCursor
                      onClicked: {
                        root.cursor = row.index
                        root.column = stepper.index
                        root.step(row.modelData, stepper.modelData, press.modelData)
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // A list longer than the panel says so; nothing else here would.
  Rectangle {
    visible: list.contentHeight > list.height
    anchors.right: parent.right
    anchors.rightMargin: -Style.space(4)
    y: list.y + list.visibleArea.yPosition * list.height
    width: Style.space(2)
    height: list.visibleArea.heightRatio * list.height
    radius: width / 2
    color: Util.alpha(root.foreground, 0.3)
  }
}
