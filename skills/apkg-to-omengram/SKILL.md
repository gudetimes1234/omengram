---
name: apkg-to-omengram
description: Import an Anki .apkg deck into omengram's library. Use when the user has a shared, downloaded or exported Anki package and wants to study it in omengram, or asks to "import", "convert" or "use" an .apkg or Anki deck with omengram.
---

# Import an Anki `.apkg` into omengram

omengram's library is the `.json` files under `~/.local/share/omengram`, one
file per deck, folders for the deck tree. `tools/import_anki.py` in the
omengram checkout turns a package into those files. It needs Anki's Python
library, which the official Linux build ships.

## Run it

Always look first, then write:

```bash
/usr/local/share/anki/python/bin/python3 tools/import_anki.py --apkg path/to/deck.apkg --dry-run
/usr/local/share/anki/python/bin/python3 tools/import_anki.py --apkg path/to/deck.apkg
```

- **It will not replace a deck file.** If a file is already there it names it
  and writes nothing. `--force` replaces it; pass that only after the user has
  said so. Cards keep their ids, so a forced re-import keeps their progress.
- `-o DIR` writes somewhere else, such as a scratch directory to look at
  first.
- Anki can stay open: the package is loaded into a new collection in a
  temporary directory, and the user's own collection is never opened.

## What to tell the user

The script lists each deck file and its card count, then what it could not
carry. Relay those numbers:

- **Every card comes over**, one per Anki card: both sides of a reversed note,
  each cloze deletion. Cards are rendered through their own templates and
  flattened to plain text.
- **Pictures and audio become `[image]` and `[audio]`.** A deck that depends
  on them loses the part that mattered; say so.
- **Scheduling does not come over.** Every card starts new on omengram's
  schedule.
- **Big decks are split** under omengram's 256 KiB file cap, as child decks of
  the first part, so the deck is still one thing to pick.

The new decks show up the next time the panel opens, or on `r`. Nothing else
needs changing. Do not touch `~/.local/state/omarchy/omengram.json`; that is
the user's progress.
