# Study picker

Choose what omanki studies from the bar panel: decks and subdecks, tags, and
daily limits. Before this, all three meant editing `shell.json` by hand, and
omanki read one deck file.

## What changes for the user

- **A deck library.** Every `*.json` under `~/.local/share/omanki` (`deckDir`)
  is a deck, and folders are parents: `infra/backend.json` is the deck
  `infra/backend`. `infra.json` beside `infra/` holds the parent's own cards.
  Setting `deck` still means exactly that one file.
- **A picker.** `d` in the panel, or a click on the section header, opens three
  tabs: Decks, Tags, Limits. Every change saves at once.
- **Both surfaces follow it.** The overlay honours the selection; it has no
  picker of its own yet.
- **An Anki copy.** `tools/import_anki.py` copies an Anki collection into the
  library once: deck tree, tags and text. Cards start as new. Nothing is
  written back to Anki.

## Rules

- No decks picked means every deck; no tags picked means every tag. A parent
  includes its children, and tag `sd` also matches `sd::caching`. Decks are a
  union; tags then narrow it.
- `newPerDay` and `reviewsPerDay` are overall caps. `limits` adds caps on a deck
  or parent. A card has to fit under every cap above it.
- Selection lives on the plugin's `shell.json` entry (`decks`, `tags`,
  `limits`), written through the shell's `updateEntryInline`.
- Schedules are keyed by card id, not by deck, so moving a file keeps progress.
  Imported cards carry an explicit id; others keep the hash of their front.

## Later: GleamDrill

GleamDrill is to become a second source in the same plugin. Not built here, but
kept possible: deck ids are opaque paths of any depth, ids starting with
`gleamdrill:` are reserved, and limits attach to any node. It needs its own
FSRS state (not SM-2), and a JSON catalogue exporter, which it lacks today.

## Milestones

1. Library, selection and limits in `Anki.js`, with tests
2. `Reviewer.qml` and both surfaces on the library
3. The picker
4. Anki import
5. Install, verify live, publish
