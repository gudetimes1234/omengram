# Study from Anki, sync with AnkiWeb

Study your Anki decks in omengram and have every answer reach Anki on your
phone, and the phone's answers reach omengram. Before this, omengram studied a
one-way copy of an Anki collection (`tools/import_anki.py`) on its own schedule,
so the two drifted apart.

## What changes for the user

- **Anki decks in the picker.** Your Anki collection shows up as an "Anki" deck
  with your Anki decks under it. Pick them, their subdecks and their tags the
  same way as library decks.
- **Anki's schedule.** An Anki card is shown when Anki would show it, and a
  grade is an Anki review: it goes into Anki's review history and its
  scheduler, FSRS or not. Anki's deck options apply; a limit set in the picker
  can only lower them.
- **Sync.** The bar dropdown has a Sync button (`y`) and a line saying when it
  last synced. It also syncs 30 seconds after the bar starts and then every
  `syncInterval` minutes (15; 0 turns the timer off). Sync is AnkiWeb's, so
  AnkiDroid and AnkiMobile see the same reviews once they sync too.
- **With Anki open.** Anki locks its collection while it runs. The omengram add-on
  (`anki-addon/`, symlinked into Anki's add-ons folder) lets omengram study and
  sync through Anki then; Sync is Anki's own Sync button.
- **Library decks stay.** JSON decks keep omengram's own scheduler, as before.

## Rules

- Anki cards come from Anki's own queue (`get_queued_cards`), so its limits,
  order, burying and learn-ahead are the phone's. The picker only narrows that
  queue: decks, then tags, then per-deck caps. Anki's day rollover applies to
  Anki cards.
- Per-deck caps count what was studied today from Anki's review log: cards,
  not answers, and learning cards spend nothing from a review cap.
- Before an answer, the card's `mod` must match what was shown. A card
  reviewed elsewhere in the meantime is reloaded, not answered twice.
- Undo takes an answer back only while it has not been synced. After a sync
  the Anki part of the undo history is dropped.
- omengram never chooses a one-way (full) sync. When AnkiWeb needs one, it says
  to open Anki and sync there.
- The AnkiWeb key is read from Anki's profile when syncing and used only for
  that. It is never logged, printed, stored or sent anywhere else. Anki's
  profile file is never written.
- Media is not synced while Anki is closed: cards are shown as text.
- The collection is opened for one request at a time and closed straight away,
  under a lock, so Anki can always open it.
- A backup (`create_backup`) is made in Anki's backups folder before the first
  write of each day.

## Ids

- Anki deck `A::B` is the picker deck `anki:/A/B`. `anki:` is the whole
  collection. A `/` inside an Anki deck name is shown as `∕`.
- Anki cards are `anki-cid:<card id>` inside the plugin. They are never written
  to omengram's progress file.
- Sync status is kept in `~/.local/state/omarchy/omengram-sync.json`.

## Milestones

1. PRD and epic
2. Bridge to the collection (`bin/omengram-anki`, `bridge/`), with tests
3. Anki add-on
4. Sync command, with tests
5. Anki decks in the reviewer and the picker
6. Sync button, status line and timer
7. Land and verify on this machine
