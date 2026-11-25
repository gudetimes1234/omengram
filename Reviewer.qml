import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Anki.js" as Anki

// The study session: owns the deck, the scheduling progress, and the queue,
// and knows nothing about what is hosting it. The panel mounts one of these
// and drives it with reveal()/answer(); everything else lives here.
Item {
  id: root

  // The directory of decks the user authors, or a single deck file instead of
  // it, and the directory the scheduling progress is written to.
  property string deckDir: ""
  property string deckPath: ""
  property string stateDir: ""
  readonly property bool singleFile: root.deckPath !== ""

  readonly property string home: Quickshell.env("HOME")

  // Everything must sit inside the home directory: the helpers walk the chain
  // component by component and refuse symlinks, and a path outside home cannot
  // be walked that way. Empty means refused, and no process is started for it.
  readonly property string deckRel: Anki.relativeToHome(root.deckPath, root.home)
  readonly property string dirRel: Anki.relativeToHome(root.deckDir, root.home)
  readonly property string progressRel:
      Anki.relativeToHome(root.stateDir + "/omanki.json", root.home)
  property int newPerDay: 20
  // 0 means no cap. A limit you have not set should not be a limit of nothing.
  property int reviewsPerDay: 0

  // How many times a card may be forgotten before it is treated as a leech.
  // 0 turns leeches off. `leechSuspend` decides whether reaching it takes the
  // card out of the rotation or only marks it.
  property int leechThreshold: Anki.LEECH_THRESHOLD
  property bool leechSuspend: true

  // How much of a lapsed card's interval survives the lapse, as a percentage.
  // Anki's own default is 0; see LAPSE_PERCENT for why this one differs.
  property int lapsePercent: Anki.LAPSE_PERCENT

  // Everything a grade depends on beyond the card itself. Named for what it is
  // rather than for the leeches it used to be, now that it carries the lapse
  // share too.
  readonly property var gradeOpts: ({
    lapsePercent: root.lapsePercent,
    leechThreshold: root.leechThreshold,
    leechSuspend: root.leechSuspend
  })

  // Restrict the session to these decks, and to cards carrying any of these
  // tags. Empty means all of them. A single file is not a library, so there is
  // nothing in it to pick and the selection is left alone rather than obeyed.
  property var decks: []
  property var tags: []
  readonly property var scopeDecks: root.singleFile ? [] : root.decks

  // Daily caps on single decks, on top of the two above.
  property var limits: ({})

  // False whenever the panel is closed, so a session neither ticks nor holds
  // a card revealed while nobody is looking at it.
  property bool active: false

  property color foreground: Color.foreground
  property color accent: Color.accent
  property color urgent: Color.urgent
  property string fontFamily: Style.font.family

  // How big the card reads and how much room it holds are the host's call, the
  // way a game board lets its host pick the cell size. The bar panel is a popup
  // and sizes to its text; the fullscreen overlay is a study surface and wants a
  // fixed, larger face that does not jump as answers change length.
  property int minFaceHeight: 0
  // A card taller than this scrolls rather than pushing the grades off the
  // surface. 0 is no limit.
  property int maxFaceHeight: 0
  property real questionFontSize: Style.font.heading
  property real answerFontSize: Style.font.subtitle

  // ----------------------------------------------------------------- state
  //
  // One entry per deck file: { id, rel, stamp, cards, error }.
  property var library: []

  // Every card there is, picked or not. Not deduplicated: limits are per deck,
  // and a card listed in two of them belongs to both.
  readonly property var allCards: {
    var out = []
    for (var i = 0; i < root.library.length; i++) out = out.concat(root.library[i].cards)
    return out
  }
  readonly property var pickedCards: Anki.mergeDecks(root.library, root.scopeDecks)
  readonly property var cards: Anki.filterByTags(root.pickedCards, root.tags)
  readonly property var caps: ({ limits: root.limits, library: root.allCards })

  // Nothing to show because of what was picked, rather than because there is
  // nothing.
  readonly property bool scopeEmpty: root.loaded && !root.cards.length && root.allCards.length > 0

  // Decks that could not be read. The rest of the library still loads.
  readonly property string libraryNotice: {
    if (root.singleFile) return ""
    var bad = root.library.filter(function(d) { return d.error })
    if (!bad.length) return ""
    return bad[0].id + ": " + bad[0].error
        + (bad.length > 1 ? " (and " + (bad.length - 1) + " more)" : "")
  }

  property var progress: Anki.emptyProgress()
  property var queue: []
  property string deckError: ""
  property bool loaded: false

  // Answered in this sitting, which is the only number that tells you whether
  // the session did anything — the due count moves for other reasons.
  property int answered: 0

  property bool revealed: false

  // Answers taken back, newest last. In memory and per sitting: undo is for
  // the grade you just fumbled, not a history you carry between sessions, and
  // a snapshot from an hour ago could no longer be true after the other
  // surface has been answering the same deck.
  property var undoStack: []
  readonly property bool canUndo: root.undoStack.length > 0

  // Set by undo so the next rebuild puts that card back in front of you.
  property string pinned: ""

  // Re-derived on every tick as well as on every answer, so a card that comes
  // due mid-session appears without the user doing anything.
  property var stats: Anki.counts(root.cards, root.progress, root.now, root.newPerDay, root.reviewsPerDay, root.caps)

  property int now: Math.floor(Date.now() / 1000)

  readonly property string currentId: root.queue.length ? root.queue[0] : ""
  readonly property var current: root.cardById(root.currentId)
  readonly property var currentState: Anki.stateFor(root.progress, root.currentId)

  // loading | error | empty | reviewing | waiting | done
  readonly property string phase: {
    if (!root.loaded) return "loading"
    if (root.deckError) return "error"
    if (root.current) return "reviewing"
    if (!root.cards.length) return "empty"
    if (root.stats.waiting > 0) return "waiting"
    return "done"
  }

  // Re-evaluated as `now` ticks, so an idle session counts down rather than
  // showing whatever the gap was when the last card was answered.
  readonly property string untilNext:
      root.stats.nextDue ? Anki.formatInterval(root.stats.nextDue - root.now) : ""

  readonly property var preview: root.current
      ? Anki.previewIntervals(root.currentState, root.now)
      : ({ again: "", hard: "", good: "", easy: "" })

  // Recomputed whenever the deck, the progress, or the clock moves, which is
  // exactly when a statistic could have changed.
  readonly property var deckStats:
      Anki.deckStats(root.cards, root.progress, root.now, root.newPerDay, root.reviewsPerDay)

  signal graded(string grade)
  signal cardAdded()
  signal resetRequested()

  // Empty unless the last attempt to add a card failed, in which case it says
  // why and the composer keeps what was typed.
  property string addError: ""
  property bool adding: false

  // Set when the last answer turned a card into a leech, and cleared a few
  // seconds later. A card that silently disappears from the rotation is the
  // one thing about leeches that would read as a bug rather than a decision,
  // so the surface says it happened at the moment it happens.
  property string leechNotice: ""

  Timer {
    id: leechNoticeTimer
    interval: 6000
    onTriggered: root.leechNotice = ""
  }

  Component.onCompleted: root.reload()

  // Coming back is the moment to pick up deck edits made while the panel was
  // closed, and to drop a card that was left face-up in the last session.
  onActiveChanged: {
    if (root.active) {
      root.revealed = false
      root.answered = 0
      root.undoStack = []
      root.reload()
    }
  }

  // Later, as with the scope below: which of the two is in use, and their paths
  // under home, are bindings on the same properties.
  onDeckPathChanged: if (root.loaded) Qt.callLater(root.reload)
  onDeckDirChanged: if (root.loaded) Qt.callLater(root.reload)

  // Compared as text. Every write to shell.json hands the surface new arrays
  // with the same things in them, and rebuilding for those would turn a
  // revealed card face down because something else in the bar was configured.
  //
  // Later, because this fires while the bindings that depend on the same
  // properties are still being brought up to date.
  readonly property string scopeKey: JSON.stringify(
    [root.scopeDecks, root.tags, root.limits, root.newPerDay, root.reviewsPerDay])
  onScopeKeyChanged: if (root.loaded) Qt.callLater(root.rebuild)

  function cardById(id) {
    if (!id) return null
    for (var i = 0; i < root.cards.length; i++)
      if (root.cards[i].id === id) return root.cards[i]
    return null
  }

  readonly property bool faceScrolls: face.implicitHeight > faceView.height + 1

  // A line or so of a long card, for a surface's arrow keys.
  function scrollFace(direction) {
    if (!root.faceScrolls) return
    faceView.contentY = Math.max(0, Math.min(faceView.contentHeight - faceView.height,
        faceView.contentY + direction * root.answerFontSize * 3))
  }

  // Every card starts at its top, and a reveal on a long one goes to where the
  // answer begins rather than leaving it below the fold.
  onCurrentIdChanged: faceView.contentY = 0
  onRevealedChanged: Qt.callLater(function() {
    faceView.contentY = root.revealed && root.faceScrolls
        ? Math.max(0, Math.min(rule.y, faceView.contentHeight - faceView.height)) : 0
  })

  // ------------------------------------------------------------- the session
  function refresh() {
    root.now = Math.floor(Date.now() / 1000)
    root.stats = Anki.counts(root.cards, root.progress, root.now, root.newPerDay, root.reviewsPerDay, root.caps)
  }

  function rebuild() {
    root.refresh()
    var queue = Anki.buildQueue(root.cards, root.progress, root.now, root.newPerDay, root.reviewsPerDay, root.caps)

    // Only pin a card the session can actually show: a filter change could
    // have removed it, and a queue holding an id with no card behind it would
    // leave the surface with nothing to render.
    if (root.pinned) {
      if (root.cardById(root.pinned)) queue = Anki.promote(queue, root.pinned)
      root.pinned = ""
    }

    root.queue = queue
    root.revealed = false
  }

  function reveal() {
    if (root.phase === "reviewing") root.revealed = true
  }

  // Space and Enter mean "show me the answer", then "I knew it" — the same two
  // presses Anki trains into your hands.
  function activate() {
    if (root.revealed) root.answer("good")
    else root.reveal()
  }

  function answer(g) {
    if (root.phase !== "reviewing" || !root.revealed) return

    var id = root.currentId
    var before = Anki.stateFor(root.progress, id)
    // The roll is drawn here rather than inside the scheduler, so that the
    // interval spreads once — at the moment the answer is committed — and the
    // priced labels above, which grade the same card without a roll, keep
    // showing a number that does not move while you decide.
    var after = Anki.grade(before, g, root.now, Math.random(), root.gradeOpts)

    // Only on the answer that makes one. A card already marked stays marked,
    // and re-answering it must not announce the same thing again.
    if (after.leech && !before.leech) {
      root.leechNotice = after.suspended
          ? "Leech — suspended after " + after.lapses + " lapses"
          : "Leech — forgotten " + after.lapses + " times"
      leechNoticeTimer.restart()
    }

    // Copied rather than mutated in place: `progress` is a var property, and
    // QML only re-evaluates the bindings that depend on it when the reference
    // itself changes.
    var reviews = {}
    for (var key in root.progress.reviews) reviews[key] = root.progress.reviews[key]

    // Snapshot before the write. `had` separates a card with no history at all
    // from one whose history merely looks new, so taking back a card's first
    // answer removes its entry instead of leaving a zeroed one behind — which
    // would otherwise count against the day's new-card allowance forever.
    root.undoStack = root.undoStack.concat([{
      id: id,
      had: Object.prototype.hasOwnProperty.call(reviews, id),
      before: before
    }]).slice(-Anki.UNDO_DEPTH)

    reviews[id] = after
    root.progress = { reviews: reviews }

    root.answered++
    root.save()
    root.rebuild()
    root.graded(g)
  }

  // Put every suspended card back in the rotation. The leech mark itself is
  // kept — the card has been trouble and the statistics should go on saying
  // so — so a restored card that keeps lapsing is raised again at the next
  // half-threshold rather than immediately.
  //
  // Returns how many came back, so the caller can say so rather than leaving
  // the user to guess whether anything happened.
  function restoreLeeches() {
    var result = Anki.unsuspendAll(root.progress, root.now)
    if (!result.restored) return 0

    root.progress = result.progress
    root.save()
    root.rebuild()
    return result.restored
  }

  // Take back the last answer. The card returns to exactly the state it was in
  // before, and comes back revealed and in front of you — you undid because
  // the grade was wrong, so the next keystroke should be able to be the right
  // one.
  function undo() {
    if (!root.undoStack.length) return

    var stack = root.undoStack.slice()
    var last = stack.pop()
    root.undoStack = stack

    var reviews = {}
    for (var key in root.progress.reviews) reviews[key] = root.progress.reviews[key]

    // Restored with a fresh stamp, and written rather than deleted. A merge
    // resolves per card by which entry is newer, so an older restored state
    // would lose to the answer it is undoing, and an outright deletion would
    // simply be re-added from the other surface's copy. A card that had no
    // history goes back as an untouched new one, which counts as new
    // everywhere it matters.
    var restored = Anki.normalizeState(last.had ? last.before : null)
    restored.updated = root.now
    reviews[last.id] = restored

    root.progress = { reviews: reviews }
    root.answered = Math.max(0, root.answered - 1)
    root.save()

    // Undoing the lapse that made a leech takes the mark back with it, since
    // the whole prior state is restored — so a notice still on screen would be
    // describing something that no longer happened.
    root.leechNotice = ""
    leechNoticeTimer.stop()

    root.pinned = last.id
    root.rebuild()
    // After the rebuild, which clears it.
    root.revealed = true
  }

  // --------------------------------------------------------------- loading
  // A path the helpers will refuse is caught here, before any process runs, so
  // the surface can say what is wrong instead of showing an empty deck.
  function checkPaths() {
    if (root.singleFile ? !root.deckRel : !root.dirRel) {
      root.deckError = "Deck must be inside your home directory"
      return false
    }
    root.deckError = ""
    return true
  }

  // Asked for while one is under way, a reload happens after it: a card just
  // written may be in a file that has already been read past.
  property bool reloadQueued: false
  readonly property bool reading: lister.running || deckReader.running || progressReader.running
  onReadingChanged: if (!root.reading && root.reloadQueued) Qt.callLater(root.flushReload)

  function flushReload() {
    if (root.reading || !root.reloadQueued) return
    root.reload()
  }

  function reload() {
    if (root.reading) { root.reloadQueued = true; return }
    root.reloadQueued = false
    root.deckRead = false
    root.progressRead = false
    if (!root.checkPaths()) {
      root.library = []
      root.deckRead = true
      root.progressRead = true
      root.loaded = true
      root.rebuild()
      return
    }
    progressReader.running = true
    if (root.singleFile)
      // No stamp, so it is always read.
      root.readDecks([{ id: Anki.baseOf(root.deckPath).replace(/\.json$/, ""), rel: root.deckRel, stamp: "" }])
    else
      lister.running = true
  }

  property bool deckRead: false
  property bool progressRead: false

  // The queue needs the decks and the progress, and the two finish in
  // whichever order they finish, so building it waits for the pair.
  function readFinished() {
    if (!root.deckRead || !root.progressRead) return
    root.loaded = true
    root.rebuild()
  }

  Process {
    id: lister
    command: ["sh", "-c", Anki.LIST_SH, "omanki-list", root.home, root.dirRel]
    stdout: StdioCollector { id: listing; waitForEnd: true }
    onExited: {
      var base = root.dirRel
      root.readDecks(Anki.parseListing(listing.text).map(function(f) {
        return { id: f.id, rel: base + "/" + f.path, stamp: f.stamp }
      }))
    }
  }

  // Files not changed since they were parsed are carried over, so the slow
  // tick that keeps the bar's count honest costs one listing and no parsing.
  property var incoming: []
  property int incomingAt: -1

  function readDecks(files) {
    var have = {}
    root.library.forEach(function(d) { have[d.rel] = d })
    root.incoming = files.map(function(f) {
      var old = have[f.rel]
      return old && f.stamp && old.stamp === f.stamp ? old : f
    })
    root.incomingAt = -1
    root.readNextDeck()
  }

  // One file at a time: a library is a handful of small files, and a process
  // each at once would be a burst every time the shell starts.
  function readNextDeck() {
    for (var i = root.incomingAt + 1; i < root.incoming.length; i++) {
      if (root.incoming[i].cards) continue
      root.incomingAt = i
      deckReader.rel = root.incoming[i].rel
      deckReader.running = true
      return
    }

    // Only a library that differs is adopted, so an idle tick does not send
    // every binding downstream of it round again.
    var next = root.incoming
    var same = next.length === root.library.length
        && next.every(function(d, n) { return d === root.library[n] })
    if (!same) root.library = next
    if (root.singleFile) root.deckError = next[0].error
    root.incoming = []
    root.deckRead = true
    root.readFinished()
  }

  Process {
    id: deckReader
    property string rel: ""
    command: ["sh", "-c", Anki.READ_SH, "omanki-deck", root.home, deckReader.rel]
    stdout: StdioCollector { id: deckText; waitForEnd: true }
    onExited: {
      var f = root.incoming[root.incomingAt]
      if (!f) return
      // An absent deck is the first-run state, not an error; a deck that
      // exists but does not parse is one the user needs told about.
      var parsed = deckText.text.trim() ? Anki.parseDeck(deckText.text) : { cards: [], error: "" }
      root.incoming[root.incomingAt] = {
        id: f.id, rel: f.rel, stamp: f.stamp,
        cards: Anki.assignDeck(parsed.cards, f.id), error: parsed.error
      }
      // Later, so this process has finished stopping before it is started on
      // the next file.
      Qt.callLater(root.readNextDeck)
    }
  }

  Process {
    id: progressReader
    command: ["sh", "-c", Anki.READ_SH, "omanki-progress", root.home, root.progressRel]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.progress = Anki.parseProgress(text)
        root.progressRead = true
        root.readFinished()
      }
    }
  }

  // ---------------------------------------------------------------- saving
  //
  // Every save is read-merge-write, never a blind overwrite. Both surfaces can
  // be on screen at once, each holding its own copy of the document, and
  // neither reloads while it is being used — so a surface writing what it
  // remembers erases whatever the other one did in the meantime. Merging on
  // the way out costs one small read per answer and makes the two independent.
  //
  // The read closes the window to the few milliseconds between it and the
  // rename, which no human answering cards can hit; the alternative, holding
  // the file open across the merge, would mean the shell holding a lock on a
  // file the user may want to delete.
  //
  // One writer at a time. Each document is complete, so a save landing
  // mid-write waits and supersedes whatever was queued behind it.
  property bool saveQueued: false

  function save() {
    root.saveQueued = true
    root.flushSave()
  }

  function flushSave() {
    if (!root.saveQueued || writer.running || merger.running) return
    root.saveQueued = false
    merger.running = true
  }

  // Reads what is on disk right now, folds this surface's state into it, and
  // hands the result to the writer.
  Process {
    id: merger
    command: ["sh", "-c", Anki.READ_SH, "omanki-merge", root.home, root.progressRel]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var merged = Anki.mergeProgress(root.progress, Anki.parseProgress(text))

        // Adopt the merged document, so the next answer builds on the other
        // surface's work rather than on a copy that is already behind. The
        // queue is left alone: it is rebuilt on the next answer anyway, and
        // rearranging cards under someone mid-session would be worse than a
        // slightly stale order.
        root.progress = merged

        writer.document = Anki.serializeProgress(merged)
        // Reopened for every write. Closing stdin is how the document is
        // terminated (see below), and a Process keeps that setting, so without
        // this the second save of a session starts a `cat` that blocks forever
        // on a stdin nobody will write to — leaving `running` true and
        // silently dropping every save after the first.
        writer.stdinEnabled = true
        writer.running = true
      }
    }
  }

  Process {
    id: writer
    property string document: ""
    command: ["sh", "-c", Anki.WRITE_SH, "omanki-write", root.home, root.progressRel]
    stdinEnabled: true
    onStarted: {
      write(document)
      document = ""
      // Closing stdin is what tells `cat` the document is finished; without
      // it the write never completes and the next save never starts.
      // flushSave reopens it before each run.
      stdinEnabled = false
    }
    onExited: root.flushSave()
  }

  // ------------------------------------------------------------ adding cards
  //
  // The deck belongs to the user, so this is read-modify-write over its actual
  // text rather than a regeneration from what the session parsed: their
  // formatting is lost to a reserialize, but their cards, their field order,
  // and any field this plugin knows nothing about are not.
  property var pendingCard: null

  // Which deck a new card goes to. Worked out as it changes so the composer
  // can say, and pinned when the card is saved so a session moving on to
  // another deck's card mid-write cannot redirect it.
  readonly property string addDeck: root.singleFile
      ? Anki.baseOf(root.deckPath).replace(/\.json$/, "")
      : Anki.addTarget(root.current ? root.current.deck : "", root.library, root.scopeDecks)
  property string addRel: ""

  // Every refusal goes through here. A refused add is shown in the composer and
  // then forgotten, which leaves nothing behind for a test to look at: from
  // outside, a card correctly refused and an add that quietly did nothing are
  // the same event - the deck simply did not change. That ambiguity is not
  // hypothetical. The soak's two refusal assertions are both of the form "the
  // file did not change", and they sat green through a whole session in which
  // adds were going to a different file entirely.
  //
  // So the reason is written to the log as well as to the screen. It is also
  // the only trace a user has after the composer clears.
  //
  // The reason only, never the card: these strings are fixed messages from
  // appendCard, and a front typed into a flashcard has no business in the
  // journal.
  function refuseAdd(reason) {
    root.addError = reason
    root.adding = false
    console.log("omanki: add refused: " + reason)
  }

  function addCard(front, back, tags) {
    if (root.adding) return
    root.addError = ""
    root.adding = true
    root.pendingCard = { front: front, back: back, tags: tags }
    root.addRel = root.singleFile ? root.deckRel : root.dirRel + "/" + root.addDeck + ".json"
    deckEditReader.running = true
  }

  Process {
    id: deckEditReader
    command: ["sh", "-c", Anki.READ_SH, "omanki-deck-edit", root.home, root.addRel]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var card = root.pendingCard
        root.pendingCard = null
        if (!card) { root.adding = false; return }

        var result = Anki.appendCard(text, card.front, card.back, card.tags)
        if (result.error) {
          root.refuseAdd(result.error)
          return
        }

        deckWriter.document = result.raw
        deckWriter.stdinEnabled = true
        deckWriter.running = true
      }
    }
  }

  Process {
    id: deckWriter
    property string document: ""
    command: ["sh", "-c", Anki.WRITE_SH, "omanki-deck-write", root.home, root.addRel]
    stdinEnabled: true
    onStarted: {
      write(document)
      document = ""
      stdinEnabled = false
    }
    onExited: function(code) {
      root.adding = false
      if (code !== 0) {
        root.refuseAdd("Could not write the deck (" + code + ")")
        return
      }
      // Re-read so the new card joins the session it was written for.
      root.reload()
      root.cardAdded()
    }
  }

  // Two cadences from one timer.
  //
  // On screen it ticks every second, so a learning card due in a minute
  // arrives on its own without the user doing anything.
  //
  // Off screen it ticks slowly and re-reads both files, which is what keeps
  // the bar's count honest. Cards come due on a clock nobody is watching, and
  // the other surface writes progress this one has never seen — without this
  // the count would freeze at whatever it was when the surface last closed.
  Timer {
    interval: root.active ? 1000 : 60000
    running: root.loaded
    repeat: true
    onTriggered: {
      if (!root.active) {
        root.reload()
        return
      }

      var was = root.queue.length
      root.refresh()
      // Only rebuild when something actually became available — rebuilding
      // every second would reset the card under the user's hands.
      if (!was && root.stats.pending > 0) root.rebuild()
    }
  }

  // ---------------------------------------------------------------- render
  implicitHeight: content.implicitHeight

  Column {
    id: content
    width: parent.width
    spacing: Style.spacing.md

    // ------------------------------------------------------- the card face
    Rectangle {
      width: parent.width
      visible: root.phase === "reviewing"
      readonly property real wanted: Math.max(root.minFaceHeight, face.implicitHeight + Style.spacing.lg * 2)
      implicitHeight: root.maxFaceHeight > 0
          ? Math.min(wanted, Math.max(root.minFaceHeight, root.maxFaceHeight)) : wanted
      color: Util.alpha(root.foreground, 0.05)
      radius: Style.cornerRadius
      border.width: Math.max(1, Style.space(1))
      border.color: Util.alpha(root.foreground, 0.12)

      Flickable {
        id: faceView
        anchors.fill: parent
        anchors.margins: Style.spacing.lg
        contentHeight: face.implicitHeight
        interactive: root.faceScrolls
        boundsBehavior: Flickable.StopAtBounds
        clip: root.faceScrolls

        Column {
          id: face
          width: faceView.width
          // Centred while it fits, which a Flickable's content has to do for
          // itself.
          y: Math.max(0, (faceView.height - face.implicitHeight) / 2)
          spacing: Style.spacing.md

          Text {
            textFormat: Text.PlainText
            width: parent.width
            // Lines that were laid out - a list, some code - are read from a
            // straight left edge. A sentence is not.
            horizontalAlignment: text.indexOf("\n") === -1 ? Text.AlignHCenter : Text.AlignLeft
            wrapMode: Text.Wrap
            text: root.current ? root.current.front : ""
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: root.questionFontSize
          }

          // The separator only appears with the answer, so the face of an
          // unrevealed card is the question and nothing else.
          Rectangle {
            id: rule
            width: parent.width
            height: Math.max(1, Style.space(1))
            visible: root.revealed
            color: Util.alpha(root.foreground, 0.15)
          }

          Text {
            textFormat: Text.PlainText
            width: parent.width
            visible: root.revealed
            horizontalAlignment: text.indexOf("\n") === -1 ? Text.AlignHCenter : Text.AlignLeft
            wrapMode: Text.Wrap
            text: root.current ? root.current.back : ""
            color: root.accent
            font.family: root.fontFamily
            font.pixelSize: root.answerFontSize
          }

          Text {
            textFormat: Text.PlainText
            width: parent.width
            visible: !root.revealed
            horizontalAlignment: Text.AlignHCenter
            text: "space to reveal"
            color: root.foreground
            opacity: 0.35
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }
      }

      Rectangle {
        visible: root.faceScrolls
        anchors.right: parent.right
        anchors.rightMargin: Style.space(3)
        y: faceView.y + faceView.visibleArea.yPosition * faceView.height
        width: Style.space(2)
        height: faceView.visibleArea.heightRatio * faceView.height
        radius: width / 2
        color: Util.alpha(root.foreground, 0.3)
      }
    }

    // --------------------------------------------------------- other states
    Text {
      textFormat: Text.PlainText
      width: parent.width
      visible: root.phase !== "reviewing"
      horizontalAlignment: Text.AlignHCenter
      wrapMode: Text.Wrap
      topPadding: Style.spacing.lg
      bottomPadding: Style.spacing.lg
      color: root.phase === "error" ? root.urgent : root.foreground
      opacity: root.phase === "error" ? 1.0 : 0.55
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      text: {
        if (root.phase === "loading") return "Loading deck…"
        if (root.phase === "error") return root.deckError + "\n" + (root.singleFile ? root.deckPath : root.deckDir)

        // An empty session means one of two different things, and sending
        // someone to edit a deck that is actually full would be a wild goose
        // chase.
        //
        // A deck ships with the plugin, but copying it is a manual step, so
        // this is the screen a fresh install lands on. Naming the file here
        // saves going back to the README to learn it exists.
        if (root.phase === "empty") {
          return root.scopeEmpty
              ? "No cards match " + (Anki.scopeLabel(root.scopeDecks, root.tags) || "this") + ".\n"
                + root.allCards.length + " card" + (root.allCards.length === 1 ? "" : "s") + " in the library."
              : "No cards yet.\nAdd some to " + (root.singleFile ? root.deckPath : root.deckDir + "/cards.json")
                + "\nor copy cards.example.json from the plugin folder."
        }

        if (root.phase === "waiting") return "Nothing due right now.\n"
            + root.stats.waiting + " card" + (root.stats.waiting === 1 ? "" : "s")
            + " still learning — next in " + root.untilNext + "."

        var done = root.answered > 0
            ? "Done for now — " + root.answered + " reviewed."
            : "Nothing due."
        // Cards are there and today's limits are what is holding them, which
        // is a different thing to be told than that nothing is due.
        if (root.stats.held > 0)
          done += "\n" + root.stats.held + " more held back by today's limits."
        return root.stats.nextDue ? done + "\nNext card in " + root.untilNext + "." : done
      }
    }

    // The way out of a selection that matches nothing, where the reader finds
    // out about it.
    Button {
      anchors.horizontalCenter: parent.horizontalCenter
      visible: root.scopeEmpty
      text: "Study everything"
      bordered: true
      foreground: root.foreground
      accent: root.accent
      fontFamily: root.fontFamily
      fontSize: Style.font.body
      onClicked: root.resetRequested()
    }

    Text {
      textFormat: Text.PlainText
      width: parent.width
      visible: root.libraryNotice !== ""
      horizontalAlignment: Text.AlignHCenter
      wrapMode: Text.Wrap
      text: root.libraryNotice
      color: root.urgent
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
  }
}
