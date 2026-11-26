"""omengram's view onto an Anki collection.

Every command takes an open `anki.collection.Collection` and returns a plain
dict that is sent to the QML side as JSON. Nothing here opens, closes, locks
or syncs a collection: bridge/cli.py does that when Anki is closed, and the
add-on (anki-addon/) hands in `mw.col` when Anki is open. Both run exactly this
code, so the two paths cannot drift apart.

The scheduling is Anki's own. Cards come from `sched.get_queued_cards()` and
answers go through `sched.answer_card()`, so deck options, daily limits,
burying, learn-ahead, leeches and FSRS all behave as they do in Anki and on
the phone, and every answer lands in the review log that AnkiWeb carries to
other devices. What omengram adds only narrows Anki's queue: which decks, which
tags, and per-deck caps that can lower Anki's limits but never raise them.

Ported from the bridge in the author's earlier niri fork of this plugin.
"""

import base64
import html
import re
import time

DAY = 86400
MATURE_DAYS = 21
FORECAST_DAYS = 7
RETENTION_DAYS = 30

# Ids as the plugin sees them. An Anki deck `A::B` is the picker deck
# `anki:/A/B`, under the root `anki:` that stands for the whole collection.
ROOT = "anki:"
SEP = "/"
TAG_SEP = "::"
# A slash inside an Anki deck name would read as a level, so it is shown as
# the division slash instead.
SLASH_STANDIN = "∕"
CARD_PREFIX = "anki-cid:"

# CardAnswer.Rating is AGAIN=0 .. EASY=3.
GRADES = {"again": 0, "hard": 1, "good": 2, "easy": 3}

# QueuedCards.Queue
Q_NEW, Q_LEARNING, Q_REVIEW = 0, 1, 2


class BridgeError(Exception):
    """A refusal with a message fit to show on the card face."""

    def __init__(self, message, code=""):
        super().__init__(message)
        self.code = code


# ------------------------------------------------------------------- text
#
# Anki renders cards as HTML for a web view. omengram draws plain text, so the
# rendered question and answer are flattened: styles and scripts dropped,
# block elements turned into line breaks, list items into bullets, media into
# a marker so a card that relies on an image does not look silently empty.

_DROP = re.compile(r"(?is)<(style|script|head|textarea|button|select|template)\b.*?</\1\s*>")
# Elements a template keeps hidden until its own script reveals them.
_HIDDEN = re.compile(r"(?is)<(\w+)\b[^>]*\shidden\b[^>]*>.*?</\1\s*>")
_VOID_DROP = re.compile(r"(?i)<input\b[^>]*>")
_COMMENT = re.compile(r"(?s)<!--.*?-->")
_PRE = re.compile(r"(?is)<pre\b[^>]*>(.*?)</pre\s*>")
_BREAK = re.compile(r"(?i)<br\s*/?>|<hr\b[^>]*>")
_BLOCKS = "p|div|h[1-6]|tr|blockquote|ul|ol|table|section|article|header|footer|dl|dt|dd|figure|figcaption"
_BLOCK_END = re.compile(r"(?i)</(%s)\s*>" % _BLOCKS)
_BLOCK_START = re.compile(r"(?i)<(%s)\b[^>]*>" % _BLOCKS)
_LI = re.compile(r"(?i)<li\b[^>]*>")
_CELL = re.compile(r"(?i)</t[dh]\s*>")
_IMG = re.compile(r"(?i)<img\b[^>]*>")
_TAG = re.compile(r"<[^>]+>")
_SOUND = re.compile(r"\[sound:[^\]]*\]")
_ANSWER_SPLIT = re.compile(r"(?i)<hr[^>]*\bid\s*=\s*[\"']?answer[\"']?[^>]*>")
_ISOLATES = re.compile("[⁦-⁩]")

_NL = "\x00"     # a line break from markup
_BLK = "\x01"    # a block edge; adjacent ones merge into one line break
_PRE_MARK = "\x02%d\x02"


def to_text(markup):
    s = markup or ""
    s = _COMMENT.sub("", s)
    s = _DROP.sub("", s)
    s = _HIDDEN.sub("", s)
    s = _VOID_DROP.sub("", s)

    # <pre> keeps its whitespace exactly; set it aside before the rest of the
    # markup has its whitespace collapsed the way a browser would.
    pres = []

    def keep_pre(m):
        pres.append(html.unescape(_TAG.sub("", m.group(1))).replace("\xa0", " ").strip("\n"))
        return _BLK + (_PRE_MARK % (len(pres) - 1)) + _BLK

    s = _PRE.sub(keep_pre, s)

    s = _IMG.sub("[image]", s)
    s = _SOUND.sub("[audio]", s)
    s = _BREAK.sub(_NL, s)
    s = _LI.sub(_BLK + "• ", s)
    s = _CELL.sub("  ", s)
    s = _BLOCK_START.sub(_BLK, s)
    s = _BLOCK_END.sub(_BLK, s)
    s = _TAG.sub("", s)

    s = re.sub(r"\s+", " ", s)
    s = html.unescape(s).replace("\xa0", " ")

    s = re.sub(" *%s[ %s]*" % (_BLK, _BLK), _BLK, s)
    s = s.replace(_BLK, "\n")
    s = re.sub(" *%s *" % _NL, "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    s = re.sub("\x02(\\d+)\x02", lambda m: pres[int(m.group(1))], s)
    return "\n".join(line.rstrip() for line in s.split("\n")).strip()


def answer_text(card):
    """The back of the card without the front repeated above it."""
    rendered = card.answer()
    parts = _ANSWER_SPLIT.split(rendered, maxsplit=1)
    back = to_text(parts[1] if len(parts) == 2 else rendered)
    if len(parts) != 2:
        front = to_text(card.question())
        if front and back.startswith(front):
            back = back[len(front):].strip() or back
    return back


def clean_label(label):
    return _ISOLATES.sub("", label or "").strip()


# -------------------------------------------------------------------- ids

def deck_id(name):
    """The picker id of an Anki deck name."""
    parts = [p.replace(SEP, SLASH_STANDIN) for p in (name or "").split("::")]
    return ROOT + SEP + SEP.join(parts)


def _own_only(entry):
    return entry + SEP + "."


def covers(entry, id_, sep=SEP):
    """Same rule as Anki.js `covers`: the entry itself, its own-only form, or
    anything under it."""
    return entry == id_ or entry == id_ + sep + "." or id_.startswith(entry + sep)


def _norm_list(value):
    if value is None:
        return []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, (list, tuple)):
        return []
    out = []
    for v in value:
        s = str(v).strip()
        if s and s not in out:
            out.append(s)
    return out


def _norm_tags(value):
    out = []
    for t in _norm_list(value):
        t = t.lower()
        if t not in out:
            out.append(t)
    return out


def tag_matches(card_tags, wanted):
    """Same rule as Anki.filterByTags: any wanted tag, parents included."""
    if not wanted:
        return True
    for tag in card_tags:
        t = tag.lower()
        for w in wanted:
            if t == w or w == t + TAG_SEP + "." or t.startswith(w + TAG_SEP):
                return True
    return False


# ------------------------------------------------------------------ decks

def _walk(node, out, parent=None):
    for child in node.children:
        out.append((child, parent))
        _walk(child, out, child)
    return out


def _deck_nodes(col):
    """Every deck in the due tree, parents before children, with its full
    name and picker id. Counts on a node include its children and Anki's
    limits, as Anki's deck list shows them."""
    tree = col.sched.deck_due_tree()
    nodes = []
    for node, parent in _walk(tree, []):
        name = col.decks.name(node.deck_id)
        nodes.append({
            "node": node,
            "did": node.deck_id,
            "name": name,
            "id": deck_id(name),
            "parent": parent.deck_id if parent is not None else None,
        })
    return nodes


class Scope:
    """What part of the collection a request is about.

    `decks` is the picker's selection, which may mix library decks with Anki
    ones. No selection means everything; a selection with no `anki:` entry
    means none of Anki. Tags and caps narrow it the way they narrow the
    library, with the same rules as Anki.js.
    """

    def __init__(self, col, args):
        self.col = col
        entries = _norm_list(args.get("decks"))
        anki_entries = [e for e in entries if e == ROOT or e.startswith(ROOT + SEP) or e == _own_only(ROOT)]
        self.everything = not entries
        self.none = bool(entries) and not anki_entries
        self.tags = _norm_tags(args.get("tags"))
        self.limits = _norm_limits(args.get("limits"))
        self.nodes = _deck_nodes(col)
        by_did = {n["did"]: n for n in self.nodes}

        if self.none:
            selected = set()
        elif self.everything or ROOT in anki_entries:
            selected = {n["did"] for n in self.nodes}
        else:
            selected = {n["did"] for n in self.nodes if any(covers(e, n["id"]) for e in anki_entries)}
        self.selected = selected

        # The topmost selected decks: walking each of their queues reaches
        # every selected card once.
        self.tops = [n for n in self.nodes if n["did"] in selected
                     and (n["parent"] is None or n["parent"] not in selected)]
        # Whether everything under each top is wanted as Anki would show it.
        # Then the queue needs no filtering and the counts are Anki's own.
        whole = all(all(d in selected for d in col.decks.deck_and_child_ids(t["did"]))
                    for t in self.tops)
        self.caps = {k: v for k, v in self.limits.items() if k == ROOT or k.startswith(ROOT + SEP)}
        self.plain = whole and not self.tags and not self.caps
        self.by_did = by_did

    def picker_id(self, did):
        n = self.by_did.get(did)
        return n["id"] if n else deck_id(self.col.decks.name(did))

    def card_ids(self):
        """Cards in scope, tags applied, suspended included."""
        if not self.selected:
            return []
        rows = self.col.db.all(
            "select c.id, n.tags from cards c join notes n on n.id = c.nid"
            " where c.did in %s or c.odid in %s" % (_ids_sql(self.selected), _ids_sql(self.selected)))
        if not self.tags:
            return [r[0] for r in rows]
        return [cid for cid, tags in rows if tag_matches(tags.split(), self.tags)]


def _ids_sql(ids):
    ids = list(ids)
    return "(" + ",".join(str(int(i)) for i in ids) + ")" if ids else "(0)"


def _norm_limits(value):
    out = {}
    if not isinstance(value, dict):
        return out
    for key, v in value.items():
        if not isinstance(v, dict):
            continue
        entry = {}
        for kind in ("new", "reviews"):
            x = v.get(kind)
            if x is None or x == "":
                continue
            try:
                n = int(round(float(x)))
            except (TypeError, ValueError):
                continue
            if n >= 0:
                entry[kind] = n
        if entry:
            out[str(key)] = entry
    return out


class _KeepSelection:
    """Select a deck for the duration of a block, then put the old one back.

    Queues are built from the selected deck, so walking several decks means
    selecting each in turn. Leaving that behind would switch the deck Anki's
    own window is studying, which is not omengram's to change.
    """

    def __init__(self, col):
        self.col = col

    def __enter__(self):
        self.cur = self.col.get_config("curDeck", None)
        self.active = self.col.get_config("activeDecks", None)
        return self

    def select(self, did):
        if self.col.get_config("curDeck", None) != did:
            self.col.decks.select(did)

    def __exit__(self, *exc):
        if self.cur is not None and self.col.get_config("curDeck", None) != self.cur:
            self.col.set_config("curDeck", self.cur)
        if self.active is not None and self.col.get_config("activeDecks", None) != self.active:
            self.col.set_config("activeDecks", self.active)
        return False


# ---------------------------------------------------------------- reading

def _card_state(card):
    # type: 0 new, 1 learning, 2 review, 3 relearning
    phase = {0: "new", 1: "learning", 2: "review", 3: "relearning"}.get(card.type, "review")
    return {
        "phase": phase,
        "interval": max(0, card.ivl) * DAY,
        "ease": card.factor,
        "lapses": card.lapses,
        "reps": card.reps,
    }


def _payload(col, scope, card, states):
    labels = [clean_label(x) for x in col.sched.describe_next_states(states)]
    while len(labels) < 4:
        labels.append("")
    note = card.note()
    return {
        "id": CARD_PREFIX + str(card.id),
        "cid": str(card.id),
        "mod": card.mod,
        "front": to_text(card.question()) or "(empty question)",
        "back": answer_text(card) or "(empty answer)",
        "deck": scope.picker_id(card.did),
        "tags": [t for t in note.tags if t.lower() not in ("leech", "marked")],
        "state": _card_state(card),
        "intervals": {"again": labels[0], "hard": labels[1], "good": labels[2], "easy": labels[3]},
    }


def _learn_ahead(col):
    try:
        return int(col.get_config("collapseTime", 1200))
    except (TypeError, ValueError):
        return 1200


def _day_start_ms(col):
    return (col.sched.day_cutoff - DAY) * 1000


def _spent_today(col, scope):
    """What each capped deck has studied today, from the review log, with the
    same rules as Anki.deckBudgets: cards, not answers, and a card whose first
    answer ever was today counts as new rather than as a review."""
    if not scope.caps:
        return {}
    start = _day_start_ms(col)
    rows = col.db.all(
        "select r.cid, c.did, c.odid, min(r.id), (select min(id) from revlog where cid = r.cid)"
        " from revlog r join cards c on c.id = r.cid where r.id >= ? group by r.cid",
        start)
    spent = {k: {"new": 0, "reviews": 0} for k in scope.caps}
    for cid, did, odid, _first_today, first_ever in rows:
        home = odid or did
        pid = scope.picker_id(home)
        introduced = first_ever >= start
        for key in scope.caps:
            if key == ROOT or covers(key, pid):
                spent[key]["new" if introduced else "reviews"] += 1
    return spent


class _Budgets:
    def __init__(self, scope, spent):
        self.left = {}
        for key, cap in scope.caps.items():
            used = spent.get(key, {"new": 0, "reviews": 0})
            self.left[key] = {
                "new": cap["new"] - used["new"] if "new" in cap else None,
                "reviews": cap["reviews"] - used["reviews"] if "reviews" in cap else None,
            }

    def spend(self, pid, kind):
        hits = [k for k in self.left if k == ROOT or covers(k, pid)]
        for k in hits:
            v = self.left[k][kind]
            if v is not None and v <= 0:
                return False
        for k in hits:
            if self.left[k][kind] is not None:
                self.left[k][kind] -= 1
        return True


def _queue(col, scope, want=1):
    """Anki's queue for the scope, narrowed, in Anki's order. Returns
    (first `want` queued cards with their deck, counts)."""
    counts = {"fresh": 0, "learning": 0, "review": 0}
    shown = []
    if not scope.tops:
        return shown, counts

    if scope.plain:
        # Anki's own counts and order: nothing to filter.
        for t in scope.tops:
            counts["fresh"] += t["node"].new_count
            counts["learning"] += t["node"].learn_count
            counts["review"] += t["node"].review_count
        if want <= 0:
            return shown, counts
        with _KeepSelection(col) as keep:
            for t in scope.tops:
                n = t["node"]
                if not (n.new_count or n.learn_count or n.review_count):
                    continue
                keep.select(t["did"])
                queued = col.sched.get_queued_cards(fetch_limit=want - len(shown))
                shown.extend(queued.cards)
                if len(shown) >= want:
                    break
        return shown, counts

    budgets = _Budgets(scope, _spent_today(col, scope))
    with _KeepSelection(col) as keep:
        for t in scope.tops:
            n = t["node"]
            limit = n.new_count + n.learn_count + n.review_count
            if not limit:
                continue
            keep.select(t["did"])
            queued = col.sched.get_queued_cards(fetch_limit=limit)
            notes = {}
            for qc in queued.cards:
                card = qc.card
                if card.deck_id not in scope.selected and (card.original_deck_id or 0) not in scope.selected:
                    continue
                if scope.tags:
                    tags = notes.get(card.note_id)
                    if tags is None:
                        tags = (col.db.scalar("select tags from notes where id = ?", card.note_id) or "").split()
                        notes[card.note_id] = tags
                    if not tag_matches(tags, scope.tags):
                        continue
                pid = scope.picker_id(card.original_deck_id or card.deck_id)
                if qc.queue == Q_NEW:
                    if not budgets.spend(pid, "new"):
                        continue
                    counts["fresh"] += 1
                elif qc.queue == Q_REVIEW:
                    if not budgets.spend(pid, "reviews"):
                        continue
                    counts["review"] += 1
                else:
                    counts["learning"] += 1
                if len(shown) < want:
                    shown.append(qc)
    return shown, counts


def _waiting(col, scope):
    """Learning cards in scope not due yet, and when the first one is."""
    ids = scope.card_ids()
    if not ids:
        return 0, 0
    soon = int(time.time()) + _learn_ahead(col)
    row = col.db.first(
        "select count(), min(due) from cards where queue = 1 and due > ? and id in " + _ids_sql(ids), soon)
    count, first = row or (0, None)
    return int(count or 0), int(first or 0)


def _counts(col, scope, queued_counts):
    waiting, next_due = _waiting(col, scope)
    fresh = queued_counts["fresh"]
    learning = queued_counts["learning"]
    review = queued_counts["review"]
    return {
        "fresh": fresh,
        "learning": learning,
        "review": review,
        "due": learning + review,
        "pending": fresh + learning + review,
        "waiting": waiting,
        "nextDue": next_due,
        "total": len(scope.card_ids()),
        # Whether there is anything at all, so "nothing matches" can be told
        # apart from "nothing there".
        "collection": int(col.db.scalar("select count() from cards") or 0),
    }


def _clock(col):
    return {
        "dayCutoff": int(col.sched.day_cutoff),
        "learnAheadSecs": _learn_ahead(col),
    }


def _stats(col, scope):
    """Everything the statistics tabs draw, for the cards in scope."""
    ids = scope.card_ids()
    sql_ids = _ids_sql(ids)
    db = col.db
    where = "id in " + sql_ids

    row = db.first(
        "select count(),"
        " sum(type = 0),"
        " sum(type in (1, 3)),"
        " sum(type = 2 and ivl < ?),"
        " sum(type = 2 and ivl >= ?),"
        " sum(queue = -1),"
        " sum(reps), sum(lapses), sum(lapses > 0),"
        " sum(case when type != 0 then factor else 0 end),"
        " sum(type != 0 and factor > 0)"
        " from cards where " + where,
        MATURE_DAYS, MATURE_DAYS)
    total, fresh, learning, young, mature, suspended, reps, lapses, lapsed, ease_sum, ease_n = [int(x or 0) for x in row]

    leeches = db.scalar(
        "select count() from cards c join notes n on n.id = c.nid"
        " where c." + where + " and (' ' || lower(n.tags) || ' ') like '% leech %'") or 0

    start_ms = _day_start_ms(col)
    answered_today = db.scalar(
        "select count(distinct cid) from revlog where id >= ? and cid in " + sql_ids, start_ms) or 0
    introduced_today = db.scalar(
        "select count() from (select cid, min(id) first from revlog where cid in " + sql_ids +
        " group by cid) where first >= ?", start_ms) or 0

    since_ms = (col.sched.day_cutoff - RETENTION_DAYS * DAY) * 1000
    passed, reviewed = db.first(
        "select sum(ease > 1), count() from revlog where type = 1 and id >= ? and cid in " + sql_ids,
        since_ms) or (0, 0)
    reviewed = int(reviewed or 0)

    forecast = [0] * FORECAST_DAYS
    today = col.sched.today
    for queue, due in db.execute("select queue, due from cards where queue in (1, 2, 3) and " + where):
        if queue == 1:
            days = int((due - (col.sched.day_cutoff - DAY)) // DAY)
        else:
            days = due - today
        days = max(0, days)
        if days < FORECAST_DAYS:
            forecast[days] += 1

    return {
        "total": total,
        "fresh": fresh,
        "learning": learning,
        "young": young,
        "mature": mature,
        "seen": total - fresh,
        "reps": reps,
        "lapses": lapses,
        "lapsed": lapsed,
        "easeSum": ease_sum,
        "easeCount": ease_n,
        "ease": (ease_sum / ease_n / 1000.0) if ease_n else 0,
        "leeches": int(leeches),
        "suspended": suspended,
        "answeredToday": int(answered_today),
        "introducedToday": int(introduced_today),
        "reviewsToday": max(0, int(answered_today) - int(introduced_today)),
        "retention": (int(passed or 0) / reviewed) if reviewed else 0,
        "retentionReviews": reviewed,
        "retentionDays": RETENTION_DAYS,
        "forecast": forecast,
    }


def _session(col, args, scope=None):
    scope = scope or Scope(col, args)
    queued, qcounts = _queue(col, scope, want=1)
    card = None
    if queued:
        qc = queued[0]
        card = _payload(col, scope, col.get_card(qc.card.id), qc.states)
    out = {"card": card, "counts": _counts(col, scope, qcounts), "clock": _clock(col)}
    if args.get("withStats", True):
        out["stats"] = _stats(col, scope)
    return out


def _status(col, args):
    scope = Scope(col, args)
    _queued, qcounts = _queue(col, scope, want=0)
    return {"counts": _counts(col, scope, qcounts), "clock": _clock(col)}


def _catalog(col, args):
    """The picker's rows for Anki: every deck with what is in it, and the
    tags of the cards in the decks picked."""
    rows = []
    for n in _deck_nodes(col):
        node = n["node"]
        dids = col.decks.deck_and_child_ids(n["did"])
        total = col.db.scalar(
            "select count() from cards where did in %s or odid in %s" % (_ids_sql(dids), _ids_sql(dids))) or 0
        rows.append({
            "id": n["id"],
            "name": n["name"],
            "total": int(total),
            "due": node.learn_count + node.review_count,
            "fresh": node.new_count,
        })

    scope = Scope(col, {"decks": args.get("decks")})
    tag_totals = {}
    ids = scope.card_ids()
    if ids:
        for (tags,) in col.db.all(
                "select n.tags from cards c join notes n on n.id = c.nid where c.id in " + _ids_sql(ids)):
            mine = set()
            for tag in tags.split():
                t = tag.lower()
                if t in ("leech", "marked"):
                    continue
                parts = t.split(TAG_SEP)
                if any(not p or p == "." for p in parts):
                    continue
                for i in range(1, len(parts) + 1):
                    mine.add(TAG_SEP.join(parts[:i]))
            for t in mine:
                tag_totals[t] = tag_totals.get(t, 0) + 1
    return {"decks": rows, "tags": tag_totals}


# ---------------------------------------------------------------- writing

def _today_counts(col, did):
    """(new, review) studied today as the deck's own counters hold them."""
    deck = col.decks.get(did) or {}
    today = col.sched.today

    def pick(key):
        pair = deck.get(key) or [0, 0]
        return pair[1] if pair and pair[0] == today else 0

    return pick("newToday"), pick("revToday")


def _card_from_args(col, args):
    raw = str(args.get("cid") or args.get("id") or "")
    if raw.startswith(CARD_PREFIX):
        raw = raw[len(CARD_PREFIX):]
    try:
        cid = int(raw)
    except ValueError:
        raise BridgeError("answer needs a card id")
    try:
        return col.get_card(cid)
    except Exception:
        raise BridgeError("That card is no longer in Anki", "changed")


def _forget_queue(col, keep, did):
    """Make Anki drop the queue it built last.

    Anki only accepts an answer for the card at the top of the queue it has
    cached, and a narrowed queue (tags, caps) often shows a card further down.
    Changing the selected deck makes Anki rebuild the queue, so the answer is
    taken for whichever card it is. The selection is put back afterwards.
    """
    cur = col.get_config("curDeck", None)
    target = did
    if target == cur:
        target = next((d.id for d in col.decks.all_names_and_ids() if d.id != cur), None)
    if target is not None:
        col.decks.select(target)


def _answer(col, args):
    rating = GRADES.get(str(args.get("grade", "")).lower())
    if rating is None:
        raise BridgeError("unknown grade %r" % args.get("grade"))
    card = _card_from_args(col, args)
    cid = card.id

    # Answered elsewhere since it was shown (the phone, Anki's own window, the
    # other surface): grading it now would grade a card nobody is looking at.
    if args.get("mod") is not None and int(args.get("mod")) != card.mod:
        raise BridgeError("Reviewed elsewhere — here is the next card", "changed")
    if card.queue < 0:
        raise BridgeError("That card is suspended or buried in Anki now", "changed")

    snapshot = base64.b64encode(card._to_backend_card().SerializeToString()).decode()
    before_today = _today_counts(col, card.did)
    before_leech = card.note().has_tag("leech")

    # How long the card was in front of the user, so Anki's time statistics
    # mean something. Anki caps it again with the deck's own option.
    elapsed = max(0.0, min(float(args.get("elapsed") or 0) / 1000.0, 3600.0))
    card.timer_started = time.time() - elapsed

    with _KeepSelection(col) as keep:
        _forget_queue(col, keep, card.did)
        states = col._backend.get_scheduling_states(cid)
        col.sched.answer_card(col.sched.build_answer(card=card, states=states, rating=rating))

    revlog_id = col.db.scalar("select max(id) from revlog where cid = ?", cid) or 0
    after_today = _today_counts(col, card.did)

    after = col.get_card(cid)
    leech = None
    if not before_leech and after.note().has_tag("leech"):
        leech = {"lapses": after.lapses, "suspended": after.queue == -1}

    out = _session(col, args)
    out["undo"] = {
        "cid": str(cid),
        "snapshot": snapshot,
        "revlogId": revlog_id,
        "modAfter": after.mod,
        "deckId": card.did,
        "newDelta": after_today[0] - before_today[0],
        "reviewDelta": after_today[1] - before_today[1],
        "leechTagged": leech is not None,
    }
    out["leech"] = leech
    return out


def _undo(col, args):
    from anki.cards import Card
    from anki import cards_pb2

    u = args.get("undo") or {}
    try:
        cid = int(u["cid"])
        raw = base64.b64decode(u["snapshot"])
    except (KeyError, TypeError, ValueError):
        raise BridgeError("nothing to undo")
    rid = int(u.get("revlogId") or 0)

    try:
        now = col.get_card(cid)
    except Exception:
        raise BridgeError("That card is no longer in Anki", "changed")
    # Once the answer has gone to AnkiWeb, deleting it here would not delete
    # it there, and the phone would keep a review this side had taken back.
    usn = col.db.scalar("select usn from revlog where id = ? and cid = ?", rid, cid) if rid else None
    if (rid and usn is None) or (usn is not None and usn != -1) or now.usn != -1:
        raise BridgeError("Already synced — that answer can't be taken back", "synced")
    if u.get("modAfter") is not None and int(u["modAfter"]) != now.mod:
        raise BridgeError("Reviewed elsewhere since — nothing taken back", "changed")

    pb = cards_pb2.Card()
    pb.ParseFromString(raw)
    card = Card(col)
    card._load_from_backend_card(pb)
    if card.id != cid:
        raise BridgeError("undo snapshot does not match its card")
    col.update_card(card, skip_undo_entry=True)

    if rid:
        col.db.execute("delete from revlog where id = ? and cid = ?", rid, cid)

    did = int(u.get("deckId") or card.did)
    new_delta = int(u.get("newDelta") or 0)
    review_delta = int(u.get("reviewDelta") or 0)
    if new_delta or review_delta:
        col.sched.update_stats(did, new_delta=-new_delta, review_delta=-review_delta)

    if u.get("leechTagged"):
        note = card.note()
        note.remove_tag("leech")
        col.update_note(note, skip_undo_entry=True)

    scope = Scope(col, args)
    out = _session(col, args, scope)
    # Put the card back in front of the user, as it was.
    card = col.get_card(cid)
    states = col._backend.get_scheduling_states(cid)
    out["card"] = _payload(col, scope, card, states)
    return out


def _restore_leeches(col, args):
    scope = Scope(col, args)
    ids = scope.card_ids()
    if ids:
        ids = col.db.list(
            "select c.id from cards c join notes n on n.id = c.nid where c.queue = -1 and c.id in "
            + _ids_sql(ids) + " and (' ' || lower(n.tags) || ' ') like '% leech %'")
    if ids:
        col.sched.unsuspend_cards(ids)
    out = _session(col, args)
    out["restored"] = len(ids)
    return out


def _ping(col, args):
    return {"bridge": "omengram", "version": 1}


def pending_changes(col):
    """Rows not yet sent to AnkiWeb, and the size of the review log."""
    db = col.db
    return {
        "cards": int(db.scalar("select count() from cards where usn = -1") or 0),
        "notes": int(db.scalar("select count() from notes where usn = -1") or 0),
        "revlog": int(db.scalar("select count() from revlog where usn = -1") or 0),
        "revlogTotal": int(db.scalar("select count() from revlog") or 0),
    }


COMMANDS = {
    "ping": _ping,
    "status": _status,
    "next": _session,
    "catalog": _catalog,
    "answer": _answer,
    "undo": _undo,
    "restoreLeeches": _restore_leeches,
}

MUTATING = {"answer", "undo", "restoreLeeches"}


def run(col, cmd, args=None):
    fn = COMMANDS.get(cmd)
    if not fn:
        return {"error": "unknown command %r" % cmd}
    try:
        return fn(col, dict(args or {}))
    except BridgeError as e:
        out = {"error": str(e)}
        if e.code:
            out["code"] = e.code
        return out
