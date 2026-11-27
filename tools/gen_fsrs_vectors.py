"""Write tests/fsrs-vectors.json from the reference py-fsrs implementation.

    uv run --no-project --with fsrs==6.3.3 python tools/gen_fsrs_vectors.py

Fsrs.js is a port of GleamDrill's FSRS-6, which is itself a port of py-fsrs.
These vectors are upstream's own output for each input, so the port is checked
against FSRS rather than against a reading of the spec. The same inputs as
GleamDrill's fsrs/tools/gen_vectors.py, written as JSON for node.

The output is committed. Regenerate it when changing the pinned py-fsrs
version; a diff means FSRS itself changed and Fsrs.js needs another look.
"""

import json
import os
import random
from datetime import datetime, timedelta, timezone
from importlib.metadata import version

import fsrs.scheduler as sched_mod
from fsrs import Card, Rating, Scheduler, State

S = Scheduler(enable_fuzzing=False)
R = list(Rating)
out = {
    "generator": "py-fsrs " + version("fsrs"),
    "parameters": list(S.parameters),
    "decay": S._DECAY,
    "factor": S._FACTOR,
    "initial_stability": [[int(r), S._initial_stability(rating=r)] for r in R],
    "initial_difficulty": [[int(r), S._initial_difficulty(rating=r, clamp=True)] for r in R],
    "next_difficulty": [
        [d, int(r), S._next_difficulty(difficulty=d, rating=r)]
        for d in [1.0, 2.5, 5.0, 7.3, 9.9, 10.0]
        for r in R
    ],
    "short_term_stability": [
        [s, int(r), S._short_term_stability(stability=s, rating=r)]
        for s in [0.001, 0.212, 1.0, 3.5, 10.0, 100.0]
        for r in R
    ],
    "recall_stability": [
        [s, d, rv, int(g),
         S._next_recall_stability(difficulty=d, stability=s, retrievability=rv, rating=g)]
        for s in [0.5, 2.0, 10.0, 60.0, 365.0]
        for d in [1.0, 5.0, 9.0]
        for rv in [0.2, 0.6, 0.9, 0.99]
        for g in [Rating.Hard, Rating.Good, Rating.Easy]
    ],
    "forget_stability": [
        [s, d, rv, S._next_forget_stability(difficulty=d, stability=s, retrievability=rv)]
        for s in [0.5, 2.0, 10.0, 60.0, 365.0]
        for d in [1.0, 5.0, 9.0]
        for rv in [0.2, 0.6, 0.9, 0.99]
    ],
    "next_interval": [
        [s, S._next_interval(stability=s)]
        for s in [0.001, 0.5, 1.0, 3.7, 25.0, 400.0, 100000.0]
    ],
}

BASE = datetime(2026, 1, 1, tzinfo=timezone.utc)
rows = []
for s in [0.5, 2.0, 10.0, 365.0]:
    for t in [0, 1, 5, 30, 365]:
        c = Card(state=State.Review, stability=s, difficulty=5.0, due=BASE, last_review=BASE)
        rows.append([s, t, S.get_card_retrievability(card=c, current_datetime=BASE + timedelta(days=t))])
out["retrievability"] = rows

# End-to-end: each step is what was pressed, when, and the card that came out.
# state is 1 learning, 2 review, 3 relearning; step is -1 once graduated.
START = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
D = 1440
G, A, H, E = Rating.Good, Rating.Again, Rating.Hard, Rating.Easy
SCENARIOS = [
    ("all_good", [(G, 0), (G, 10), (G, 1 * D), (G, 5 * D), (G, 20 * D)]),
    ("all_again", [(A, 0), (A, 1), (A, 2), (A, 3)]),
    ("easy_first", [(E, 0), (E, 15 * D), (E, 90 * D)]),
    ("hard_grind", [(H, 0), (H, 1), (H, 10), (H, 2 * D)]),
    ("lapse_recovery", [(G, 0), (G, 10), (G, 3 * D), (A, 10 * D), (G, 10 * D + 10), (G, 12 * D)]),
    ("same_day_repeats", [(G, 0), (G, 5), (G, 10), (G, 15), (G, 20)]),
    ("mixed", [(G, 0), (H, 10), (G, 1 * D), (E, 4 * D), (A, 30 * D), (H, 30 * D + 10),
               (G, 31 * D), (G, 45 * D)]),
    ("new_hard_start", [(H, 0), (G, 10), (G, 2 * D)]),
    ("long_horizon", [(G, 0), (G, 10), (E, 1 * D), (E, 30 * D), (E, 200 * D), (E, 1000 * D)]),
    ("relearn_chain", [(G, 0), (G, 10), (G, 5 * D), (A, 20 * D), (A, 20 * D + 10),
                       (H, 20 * D + 20), (G, 20 * D + 30), (G, 25 * D)]),
]

scenarios = []
for sample in [None, 0.0, 0.5, 0.999]:
    if sample is None:
        scheduler, name_tag, fuzz = Scheduler(enable_fuzzing=False), "", -1.0
    else:
        scheduler = Scheduler(enable_fuzzing=True)
        sched_mod.random = lambda v=sample: v
        name_tag, fuzz = "_fuzz" + str(sample).replace(".", ""), sample
    for name, steps in SCENARIOS:
        card = Card(due=START)
        card.card_id = 1
        body = []
        for rating, mins in steps:
            card, _ = scheduler.review_card(card, rating, START + timedelta(minutes=mins))
            body.append({
                "rating": int(rating),
                "at": mins * 60,
                "state": int(card.state),
                "stability": card.stability,
                "difficulty": card.difficulty,
                "step": -1 if card.step is None else card.step,
                "due": round((card.due - START).total_seconds()),
            })
        scenarios.append({"name": name + name_tag, "fuzz": fuzz, "steps": body})
    sched_mod.random = random.random

out["start"] = int(START.timestamp())
out["scenarios"] = scenarios

path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tests", "fsrs-vectors.json")
with open(path, "w") as f:
    json.dump(out, f, indent=1)
    f.write("\n")
print(f"wrote {path}: {len(scenarios)} scenarios")
