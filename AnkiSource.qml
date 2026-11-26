import QtQuick
import "Anki.js" as Anki

// Anki's side of a session: the next card Anki would show for what is picked,
// its counts and statistics, and the picker's rows for Anki's decks. Answers
// go to Anki's own scheduler through the bridge; nothing here schedules.
//
// Anki being absent (not installed, no collection) is quiet: the library goes
// on as if Anki were not there. Anki being present but out of reach (open
// without the add-on) is said, since only the reader can fix it.
Item {
  id: root

  property bool inUse: true
  property var decks: []
  property var tags: []
  property var limits: ({})
  property string profile: ""

  property var card: null
  property var counts: ({})
  property var stats: null
  property var clock: ({})
  property var rows: []
  property var tagTotals: ({})

  // idle | ok | noAnki | noCollection | ankiOpenNoAddon | error
  property string state: "idle"
  property string message: ""
  // The first answer has come back, so the session knows whether Anki has
  // anything to show.
  property bool settled: !root.inUse
  // An answer or an undo is on its way; the card on screen is not to be
  // answered again until it is back.
  property bool busy: false

  readonly property bool absent: root.state === "noAnki" || root.state === "noCollection"
  readonly property bool reachable: root.inUse && root.state === "ok"
  readonly property string notice: root.inUse && !root.absent
      && (root.state === "ankiOpenNoAddon" || root.state === "error") ? root.message : ""

  readonly property var scope: ({
    decks: Anki.normalizeDecks(root.decks),
    tags: Anki.normalizeTags(root.tags),
    limits: Anki.normalizeLimits(root.limits)
  })
  readonly property string scopeKey: JSON.stringify(root.scope)
  // Replies to a request made for another scope are dropped.
  property int generation: 0
  onScopeKeyChanged: { root.generation++; if (root.inUse) Qt.callLater(root.refresh) }
  onInUseChanged: {
    if (!root.inUse) { root.card = null; root.counts = ({}); root.stats = null; root.rows = [] }
    else Qt.callLater(root.refresh)
  }

  AnkiBridge {
    id: bridge
    defaults: root.profile ? { profile: root.profile } : ({})
  }

  function args(extra) {
    var out = { decks: root.scope.decks, tags: root.scope.tags, limits: root.scope.limits }
    for (var k in extra) out[k] = extra[k]
    return out
  }

  // Returns false when the reply was an error, having noted it.
  function take(reply, gen) {
    if (gen !== undefined && gen !== root.generation) return false
    if (reply.error) {
      var code = reply.code || "error"
      // A request that met another one, or Anki mid-sync, says nothing about
      // Anki itself: keep what is on screen and try again on the next tick.
      if (code === "busy" || code === "changed" || code === "synced") return false
      root.state = code
      root.message = reply.error
      root.card = null
      root.counts = ({})
      root.stats = null
      root.settled = true
      return false
    }
    root.state = "ok"
    root.message = ""
    if (reply.counts) root.counts = reply.counts
    if (reply.clock) root.clock = reply.clock
    if (reply.stats) root.stats = reply.stats
    if (reply.card !== undefined) root.card = reply.card
    root.settled = true
    return true
  }

  // The next card and everything around it.
  function refresh() {
    if (!root.inUse || root.busy) return
    var gen = root.generation
    bridge.call("next", root.args({}), function(reply) { root.take(reply, gen) })
  }

  // Counts only, for the bar while nobody is looking. Never moves Anki's
  // selected deck, so it gives a sync nothing to send.
  function poll() {
    if (!root.inUse || root.busy || bridge.pending) return
    var gen = root.generation
    bridge.call("status", root.args({}), function(reply) {
      if (gen !== root.generation) return
      if (reply.error) { root.take(reply, gen); return }
      root.state = "ok"
      root.message = ""
      root.counts = reply.counts || ({})
      if (reply.clock) root.clock = reply.clock
      root.settled = true
    })
  }

  function loadCatalog() {
    if (!root.inUse) return
    bridge.call("catalog", { decks: root.scope.decks }, function(reply) {
      if (reply.error) { root.rows = []; root.tagTotals = ({}); return }
      root.rows = Anki.ankiDeckRows(reply.decks)
      root.tagTotals = reply.tags || ({})
    })
  }

  // cb(reply): the reply carries `undo` and `leech` on success, `error` and
  // `code` when Anki refused.
  function answer(card, grade, elapsedMs, cb) {
    if (!card || root.busy) return
    root.busy = true
    var gen = root.generation
    bridge.call("answer", root.args({ id: card.id, mod: card.mod, grade: grade, elapsed: elapsedMs }),
        function(reply) {
          root.busy = false
          if (!reply.error) root.take(reply, gen)
          else root.refresh()
          if (cb) cb(reply)
        })
  }

  function undo(payload, cb) {
    if (root.busy) return
    root.busy = true
    var gen = root.generation
    bridge.call("undo", root.args({ undo: payload }), function(reply) {
      root.busy = false
      if (!reply.error) root.take(reply, gen)
      else root.refresh()
      if (cb) cb(reply)
    })
  }

  function restoreLeeches(cb) {
    if (!root.reachable) { if (cb) cb({ restored: 0 }); return }
    var gen = root.generation
    bridge.call("restoreLeeches", root.args({}), function(reply) {
      root.take(reply, gen)
      if (cb) cb(reply)
    })
  }
}
