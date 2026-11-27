import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "Anki.js" as Anki

// Bar widget: a card glyph with the number of cards waiting, opening the
// review session in a standard popup panel. Built on the same Ui.Panel base as
// Network and Tailscale so it inherits their open/close lifecycle, popout
// coordination, and IPC.
Panel {
  id: root
  moduleName: "gudetimes.omengram"
  ipcTarget: "gudetimes.omengram"

  // Bar widgets are handed their inline shell.json entry, so `setting()` from
  // the Panel base is all the config plumbing this surface needs.
  // `deck` names one file and is studied on its own; without it the library is.
  readonly property string deckPath: root.setting("deck", "")
      ? Anki.resolveDeck(root.setting("deck", ""), Quickshell.env("HOME")) : ""
  readonly property string deckDir: Anki.resolveDeckDir(root.setting("deckDir", ""), Quickshell.env("HOME"))
  readonly property var decks: Anki.normalizeDecks(root.setting("decks", []))
  readonly property var limits: Anki.normalizeLimits(root.setting("limits", {}))
  readonly property int newPerDay: Anki.sanePerDay(root.setting("newPerDay", 20))
  readonly property var tags: Anki.normalizeTags(root.setting("tags", []))
  readonly property int reviewsPerDay: Anki.sanePerDay(root.setting("reviewsPerDay", 0), 0)
  readonly property int leechThreshold: Anki.sanePerDay(root.setting("leechThreshold", Anki.LEECH_THRESHOLD), Anki.LEECH_THRESHOLD)
  readonly property bool leechSuspend: root.setting("leechSuspend", true) !== false
  readonly property int retention: Anki.saneRetention(root.setting("retention", Anki.RETENTION))
  readonly property bool drillsInPanel: root.setting("drillsInPanel", true) !== false
  // The count is the point of the widget, but a bar that has to stay narrow
  // can turn it off and keep the glyph.
  readonly property bool showCount: root.setting("showCount", true) !== false
  // Anki's collection beside the library, and how often to sync it.
  readonly property bool ankiEnabled: root.setting("anki", true) !== false
  readonly property string ankiProfile: String(root.setting("ankiProfile", "") || "")
  readonly property int syncInterval: Anki.sanePerDay(root.setting("syncInterval", 15), 15)

  // The bar sizes a widget from its implicit size, and Ui.Panel is a bare Item
  // with none — without this the widget occupies 0x0 and draws nothing.
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  // review | stats | pick. The overlay has room for the composer; the panel
  // does not, and a form typed into a popup that closes on focus loss is not a
  // trade worth making. The picker is ticks and steps, each saved as it is
  // made, so it has nothing to lose that way.
  property string mode: "review"

  // Written straight back to this widget's own shell.json entry, the way the
  // clock's panel does it. Applied here first so the press shows at once; the
  // write comes back through the bar as the same value. An empty list or
  // object is the default, so its key is dropped rather than left as noise.
  function persistSettings(values) {
    var entry = { id: root.moduleName }
    for (var k in root.settings) if (k !== "id") entry[k] = root.settings[k]
    for (var v in values) {
      var value = values[v]
      if (value && typeof value === "object" && JSON.stringify(value).length === 2) delete entry[v]
      else entry[v] = value
    }
    // Through text, so a list that came over a signal is stored as a plain one.
    entry = JSON.parse(JSON.stringify(entry))
    root.settings = entry
    if (root.bar && root.bar.shell && typeof root.bar.shell.updateEntryInline === "function")
      root.bar.shell.updateEntryInline(root.moduleName, entry)
  }

  // Restoring is offered wherever the leech count is. Until the panel had a
  // statistics view it had neither, and said so by pointing at the overlay.
  function restoreLeeches() {
    reviewer.restoreLeeches(function(n) {
      root.restoreNotice = n > 0
          ? (n === 1 ? "1 card restored" : n + " cards restored")
          : "No suspended cards to restore"
      restoreNoticeTimer.restart()
    })
  }

  property string restoreNotice: ""

  Timer {
    id: restoreNoticeTimer
    interval: 6000
    onTriggered: root.restoreNotice = ""
  }

  // Which statistics tab is showing. Held here because the strip that changes
  // it rides on the section header while the body it drives is further down the
  // column: one property both of them read, rather than a value bound in two
  // directions between two siblings.
  property int statsTab: 0
  property int pickTab: 0

  // Wraps, so the arrows walk the strip in a circle rather than stopping at the
  // ends and leaving the reader to work out which end they are on.
  function stepTab(delta) {
    if (root.mode === "pick") {
      root.pickTab = ((root.pickTab + delta) % picker.count + picker.count) % picker.count
      return
    }
    var n = stats.count
    if (n > 0) root.statsTab = ((root.statsTab + delta) % n + n) % n
  }

  // The leech tab appears and disappears with the leeches, and the last one
  // being restored must not leave the view pointing past the end of the strip.
  Connections {
    target: stats
    function onCountChanged() {
      if (root.statsTab >= stats.count) root.statsTab = Math.max(0, stats.count - 1)
    }
  }

  function showStats() { root.mode = "stats" }
  function showReview() { root.mode = "review" }
  function togglePick() { root.mode = root.mode === "pick" ? "review" : "pick" }
  function toggleStats() { root.mode = root.mode === "stats" ? "review" : "stats" }

  // A surface that closes and reopens is a new sitting, so it starts on the
  // cards rather than on whatever was last being read about them.
  onOpenedChanged: if (!root.opened) root.mode = "review"

  readonly property int panelContentWidth: Style.space(340)
  readonly property int pending: reviewer.stats ? reviewer.stats.pending : 0

  // WidgetButton rather than BarIconButton: the count makes this a
  // variable-width label, and BarIconButton is a fixed single-glyph slot that
  // would squeeze the number into the icon's box.
  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.showCount && root.pending > 0 ? "󰘸 " + root.pending : "󰘸"
    fontSize: Style.bar.iconFont
    // Cards waiting is the whole signal; with none, the widget should recede
    // rather than sit at full strength all day.
    dimmed: root.pending === 0
    tooltipText: root.pending > 0
        ? root.pending + " card" + (root.pending === 1 ? "" : "s") + " to review"
        : "omengram — nothing due"
    onPressed: function(buttonCode) { root.toggle() }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(root.panelContentWidth)
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(620))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent

      // Space and Enter both arrive as activate, which is exactly the
      // reveal-then-grade rhythm Anki uses.
      // Space and Enter reveal and grade, but only on the cards: in the
      // statistics they would grade a card that is not on screen.
      onActivateRequested: {
        if (root.mode === "review") reviewer.activate()
        else if (root.mode === "pick") picker.activate()
      }

      // Escape backs out one level before it closes, the way the overlay's
      // does. Leaving the panel entirely because someone wanted out of the
      // statistics would be a rude surprise.
      onCloseRequested: {
        if (root.mode !== "review") { root.showReview(); return }
        root.close()
      }

      // Tab belongs to the shell: it moves between bar panels, and every other
      // panel answers it that way. The statistics tabs are walked with the
      // arrows instead, which is what a row of tabs suggests anyway.
      onTabRequested: function(direction) { root.switchPanel(direction) }
      // Arrows walk the tabs, and so do h and l: PanelKeyCatcher turns those
      // into movement before any panel sees them, which is the shell's vim
      // convention and the reason `l` cannot also mean "restore" here. The
      // overlay has no such catcher, so there it still can.
      onMoveRequested: function(dx, dy) {
        if (root.mode === "pick" && dy !== 0) picker.move(dy)
        else if (root.mode === "review" && dy !== 0) reviewer.scrollFace(dy)
        else if (root.mode !== "review" && dx !== 0) root.stepTab(dx > 0 ? 1 : -1)
      }

      onTextKey: function(t) {
        var k = t.toLowerCase()
        // Same key as the overlay, so the two surfaces stay one set of keys.
        if (k === "s") root.toggleStats()
        else if (k === "d") root.togglePick()
        else if (k === "r") reviewer.reload()
        else if (k === "y") ankiSync.syncNow()
        else if (root.mode === "pick") {
          if (k === "+" || k === "=") picker.adjust(1)
          else if (k === "-") picker.adjust(-1)
          else if (k === "c") picker.clear()
        }
        else if (root.mode !== "review") return
        else if (k === "1") reviewer.answer("again")
        else if (k === "2") reviewer.answer("hard")
        else if (k === "3") reviewer.answer("good")
        else if (k === "4") reviewer.answer("easy")
        else if (k === "u") reviewer.undo()
      }

      Column {
        id: column
        width: parent.width
        spacing: Style.space(12)

        PanelHero {
          width: parent.width
          title: "omengram"
          meta: {
            if (reviewer.phase === "loading") return "Loading"
            if (reviewer.phase === "error") return "Deck error"
            if (reviewer.phase === "empty") return reviewer.scopeEmpty ? "Nothing matches" : "Empty deck"
            var s = reviewer.stats
            if (!s.pending) return s.total + " card" + (s.total === 1 ? "" : "s") + "  ·  all caught up"
            return s.due + " due  ·  " + s.fresh + " new"
          }
          foreground: root.foreground
          fontFamily: root.fontFamily

          iconComponent: Component {
            Text {
              textFormat: Text.PlainText
              text: "󰘸"
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.display
            }
          }

          // How many are left, on the trailing edge — the slot the native
          // panels use for at-a-glance state.
          trailingControl: Component {
            Row {
              spacing: Style.spacing.md

              Text {
                textFormat: Text.PlainText
                anchors.verticalCenter: parent.verticalCenter
                visible: reviewer.answered > 0
                text: "Done " + reviewer.answered
                color: root.foreground
                opacity: 0.5
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
              }

              Text {
                textFormat: Text.PlainText
                anchors.verticalCenter: parent.verticalCenter
                text: String(root.pending)
                color: root.pending > 0 ? Color.accent : root.foreground
                opacity: root.pending > 0 ? 1.0 : 0.4
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
              }
            }
          }
        }

        // Syncing is this widget's job: it is the surface that is always
        // there, so its timer is the one that runs.
        AnkiSync {
          id: ankiSync
          inUse: reviewer.anki.inUse && !reviewer.anki.absent
          profile: root.ankiProfile
          runsTimer: true
          interval: root.syncInterval
          onSynced: reviewer.syncFinished()
        }

        SyncStatus {
          width: parent.width
          visible: ankiSync.inUse && root.mode === "review"
          sync: ankiSync
          foreground: root.foreground
          urgent: root.urgent
          fontFamily: root.fontFamily
        }

        PanelSeparator {
          width: parent.width
          foreground: root.foreground
        }

        // The section header and, in the statistics, the tab strip on the end
        // of the same line. Stacking the strip under the header put two rows of
        // small-caps text against each other, which crowded both and spent a
        // row of a panel that has few to spare.
        Item {
          width: parent.width
          height: Math.max(sectionHeader.implicitHeight, tabStrip.height)

          PanelSectionHeader {
            id: sectionHeader
            textFormat: Text.PlainText
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            anchors.right: root.mode === "review" ? pickHint.left : tabStrip.left
            anchors.rightMargin: Style.spacing.sm
            elide: Text.ElideRight
            text: root.mode === "stats" ? "STATISTICS"
                : root.mode === "pick" ? "STUDY"
                : Anki.sectionLabel(reviewer.phase, reviewer.currentState, root.tags, reviewer.scopeDecks)
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          // What the header says is being studied is also where to change it.
          Text {
            id: pickHint
            textFormat: Text.PlainText
            visible: root.mode === "review"
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            text: "decks ▾"
            color: pickArea.containsMouse ? Color.accent : root.foreground
            opacity: pickArea.containsMouse ? 1.0 : 0.5
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            font.bold: true
          }

          MouseArea {
            id: pickArea
            anchors.fill: parent
            visible: root.mode === "review"
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: root.togglePick()
          }

          StatsTabs {
            id: tabStrip
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            visible: root.mode !== "review"
            tabs: root.mode === "pick" ? picker.tabs : stats.tabs
            current: root.mode === "pick" ? root.pickTab : root.statsTab
            foreground: root.foreground
            accent: Color.accent
            fontFamily: root.fontFamily
            onSelected: function(i) {
              if (root.mode === "pick") root.pickTab = i
              else root.statsTab = i
            }
          }
        }

        PanelStats {
          id: stats
          width: parent.width
          visible: root.mode === "stats"
          stats: reviewer.deckStats
          tab: root.statsTab
          foreground: root.foreground
          accent: Color.accent
          urgent: root.urgent
          fontFamily: root.fontFamily
          onRestoreRequested: root.restoreLeeches()
        }

        StudyPicker {
          id: picker
          width: parent.width
          visible: root.mode === "pick"
          active: root.opened && root.mode === "pick"
          reviewer: reviewer
          decks: root.decks
          tags: root.tags
          limits: root.limits
          newPerDay: root.newPerDay
          reviewsPerDay: root.reviewsPerDay
          tab: root.pickTab
          foreground: root.foreground
          accent: Color.accent
          fontFamily: root.fontFamily
          onChanged: function(values) { root.persistSettings(values) }
        }

        Reviewer {
          id: reviewer
          width: parent.width
          visible: root.mode === "review"
          deckPath: root.deckPath
          deckDir: root.deckDir
          decks: root.decks
          limits: root.limits
          maxFaceHeight: Style.space(330)
          onResetRequested: root.persistSettings({ decks: [], tags: [] })
          stateDir: Quickshell.env("HOME") + "/.local/state/omarchy"
          newPerDay: root.newPerDay
          reviewsPerDay: root.reviewsPerDay
          leechThreshold: root.leechThreshold
          leechSuspend: root.leechSuspend
          retention: root.retention
          skipDrills: !root.drillsInPanel
          tags: root.tags
          ankiEnabled: root.ankiEnabled
          ankiProfile: root.ankiProfile
          active: root.opened
          foreground: root.foreground
          accent: Color.accent
          urgent: root.urgent
          fontFamily: root.fontFamily
        }

        // Shown only with the answer: grading a card you have not turned over
        // is guessing, not recall.
        GradeButtons {
          width: parent.width
          visible: root.mode === "review" && reviewer.phase === "reviewing" && reviewer.revealed
          reviewer: reviewer
          foreground: root.foreground
          urgent: root.urgent
          fontFamily: root.fontFamily
        }

        Text {
          textFormat: Text.PlainText
          width: parent.width
          horizontalAlignment: Text.AlignHCenter
          // The hints are longer than the panel is wide once undo is offered.
          // A width alone does not contain a Text - without this it is drawn
          // centred at its natural width and spills past both edges - and
          // wrapping is right where eliding is not, since the part that would
          // be dropped is a key the reader is being told about.
          wrapMode: Text.Wrap
          // The bar panel has no statistics view to restore from, so it says
          // where the restoring lives rather than offering a key it does not
          // have. Saying nothing would leave a card gone with no account of it.
          text: {
            if (root.mode === "stats")
              return (root.restoreNotice ? root.restoreNotice + "  ·  " : "")
                  + "← → tabs  ·  s back to cards"
                  + "  ·  esc close"
            if (root.mode === "pick")
              return (root.pickTab === 2
                  ? "+ − change  ·  space new/reviews  ·  c clear"
                  : "space pick  ·  ↑ ↓ move")
                  + "  ·  ← → tabs  ·  esc back"
            // A card taken out mid-session says so here; the statistics are
            // now where it can be put back, rather than the overlay.
            if (reviewer.leechNotice)
              return reviewer.leechNotice + "  ·  s statistics to restore"
            return (reviewer.revealed ? "1-4 grade  ·  space good" : "space reveal")
                + (reviewer.canUndo ? "  ·  u undo" : "")
                + "  ·  d decks  ·  s stats"
                + (ankiSync.inUse ? "  ·  y sync" : "")
                + "  ·  esc close"
          }
          color: root.foreground
          opacity: 0.4
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
      }
    }
  }
}
