"""Tests for tools/import_gleamdrill.py, against a tiny made-up GleamDrill tree.

    python3 tests/test_import_gleamdrill.py
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "..", "tools", "import_gleamdrill.py")
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
import import_gleamdrill as gd  # noqa: E402

CATALOG = '''//// listing
pub fn groups() -> List(Group) {
  [
    Group("Arrays & Hashing", [
      Drill(
        "Has Repeat",
        "Return true if any value appears twice. Say \\"yes\\" \\u{2014} or no.",
        "nc01_has_repeat",
        Easy,
      ),
      Drill("Pair Sum", "Return the indices of two numbers adding up to target.", "nc02_pair_sum", Medium),
    ]),
    Group("Not In Python", [
      Drill("Only Gleam", "Nothing here for Python.", "nc99_only_gleam", Hard),
    ]),
  ]
}
'''

FILES = {
    "drills/python/solutions/nc01_has_repeat.py": (
        "def hasRepeat(nums):\n"
        "    # a full-line comment is dropped\n"
        "    seen = set()  # @1\n"
        "    for n in nums:  # @2\n"
        "        if n in seen:  # @3\n"
        "            return True  # @3\n"
        "        seen.add(n)  # @4\n"
        "\n\n"
        "    return False  # @5\n"),
    "drills/python/solutions/nc01_has_repeat__sorting.py": (
        "def hasRepeat(nums):\n"
        "    nums = sorted(nums)  # @1\n"
        "    for i in range(1, len(nums)):  # @2\n"
        "        if nums[i] == nums[i - 1]:  # @2,3\n"
        "            return True  # @3\n"
        "    return False  # @4\n"),
    "drills/python/solutions/nc01_has_repeat__brute.py": "def hasRepeat(nums):\n    return False\n",
    "drills/python/harnesses/nc01_has_repeat.py": (
        "__results__ = []\n"
        "def __case__(label, expected, actual):\n"
        "    __results__.append([label, repr(expected), repr(actual)])\n"
        "__case__('hasRepeat([1, 1])', True, hasRepeat([1, 1]))\n"),
    "drills/notes/nc01_has_repeat.txt": "@kind Hash Set\n@big-o O(n) time\n@order 1\n@pattern hash-set\nThe signal is a repeat.\n",
    "drills/notes/nc01_has_repeat__sorting.txt": "@kind Sorting\n@big-o O(n log n)\n@order 2\n@pattern sort-scan\nNeighbours.\n",
    "drills/notes/nc01_has_repeat__brute.txt": "@kind Brute force\n@order 3\nSlow.\n",
    "drills/patterns/VOCAB": "hash-set\tHash set\nsort-scan\tSort then scan\n",
    "drills/patterns/nc01_has_repeat.txt": (
        "== pattern hash-set\n"
        "complexity: O(n) time\n"
        "nudge: What do you keep?\n"
        "-- step Remember\n"
        "1 seen = empty set\n"
        "  hint: What do you keep?\n"
        "  why: What is to the left.\n"
        "-- step Walk\n"
        "2 for n in nums:\n"
        "  hint: How?\n"
        "  why: Once.\n"
        "3     if n in seen: return True\n"
        "  hint: When?\n"
        "  why: A repeat.\n"
        "4     add n to seen\n"
        "  hint: Then?\n"
        "  why: Remember it.\n"
        "5 return False\n"
        "  hint: At the end?\n"
        "  why: None found.\n"
        "== pattern sort-scan\n"
        "complexity: O(n log n)\n"
        "nudge: Neighbours?\n"
        "-- step Sort\n"
        "1 sort nums\n  hint: h\n  why: w\n"
        "2 for each neighbour pair:\n  hint: h\n  why: w\n"
        "3     if equal: return True\n  hint: h\n  why: w\n"
        "4 return False\n  hint: h\n  why: w\n"),
    "drills/approaches/has-repeat.txt": "== nudge\nAsk the elements before.\n== walk\n# x\n",
    "drills/python/solutions/nc02_pair_sum.py": "def pairSum(nums, target):\n    return []\n",
    "drills/notes/nc02_pair_sum.txt": "@kind Hash Map\n@big-o O(n)\nComplements.\n",
}


def make_tree(root):
    os.makedirs(os.path.join(root, "src/gleamdrill/content/problems"))
    with open(os.path.join(root, "src/gleamdrill/content/problems/catalog.gleam"), "w") as f:
        f.write(CATALOG)
    for rel, body in FILES.items():
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(body)


class ImportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.tmp.name, "gleamdrill")
        self.out = os.path.join(self.tmp.name, "out")
        make_tree(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def run_tool(self, *extra):
        return subprocess.run([sys.executable, "-I", TOOL, self.root, "--out", self.out, *extra],
                              capture_output=True, text=True)

    def deck(self, name="arrays-hashing"):
        with open(os.path.join(self.out, name + ".json")) as f:
            return json.load(f)

    def test_catalogue_strings_and_groups(self):
        groups = gd.parse_catalog(os.path.join(self.root, "src/gleamdrill/content/problems/catalog.gleam"))
        self.assertEqual([g for g, _ in groups], ["Arrays & Hashing", "Not In Python"])
        first = groups[0][1][0]
        self.assertEqual(first["prompt"], 'Return true if any value appears twice. Say "yes" — or no.')
        self.assertEqual(first["difficulty"], "easy")
        self.assertEqual(groups[0][1][1]["stem"], "nc02_pair_sum")

    def test_one_deck_per_group_with_python(self):
        r = self.run_tool()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(sorted(os.listdir(self.out)), ["arrays-hashing.json"])
        d = self.deck()
        self.assertEqual(d["source"], gd.SOURCE)
        self.assertEqual([c["id"] for c in d["cards"]], ["gd:python:nc01_has_repeat", "gd:python:nc02_pair_sum"])
        self.assertEqual(os.stat(os.path.join(self.out, "arrays-hashing.json")).st_mode & 0o777, 0o600)

    def test_the_card(self):
        self.run_tool()
        c = self.deck()["cards"][0]
        self.assertEqual(c["kind"], "code")
        self.assertTrue(c["front"].startswith("Has Repeat\n\nReturn true"))
        self.assertEqual(c["back"], "The signal is a repeat.")
        self.assertNotIn("# @", c["answer"])
        self.assertIn("    seen = set()\n", c["answer"])
        self.assertEqual(c["complexity"], "O(n) time")
        self.assertEqual(c["tags"], ["neetcode", "easy", "arrays-hashing"])
        self.assertEqual(c["nudge"], "Ask the elements before.")
        self.assertIn("hasRepeat([1, 1]))", c["harness"])
        self.assertEqual([a["label"] for a in c["alternates"]], ["Sorting", "Brute force"])
        self.assertNotIn("# @", c["alternates"][0]["answer"])

    def test_line_drill_patterns(self):
        self.run_tool()
        c = self.deck()["cards"][0]
        self.assertEqual([p["slug"] for p in c["patterns"]], ["hash-set", "sort-scan"])
        p = c["patterns"][0]
        self.assertEqual(p["name"], "Hash set")
        self.assertEqual(p["steps"], ["Remember", "Walk"])
        self.assertEqual(p["notes"][2], {"id": 3, "step": 1, "pseudo": "    if n in seen: return True",
                                         "hint": "When?", "why": "A repeat."})
        lines = p["lines"]
        self.assertEqual(lines[0], {"given": "def hasRepeat(nums):"})
        self.assertEqual(lines[1], {"text": "seen = set()", "indent": 4, "notes": [1]})
        self.assertNotIn({"given": "    # a full-line comment is dropped"}, lines)
        # Two blank lines squeezed to one, none at the end.
        self.assertEqual(sum(1 for l in lines if l.get("given") == ""), 1)
        self.assertEqual(lines[-1], {"text": "return False", "indent": 4, "notes": [5]})
        sort = c["patterns"][1]["lines"]
        self.assertIn({"text": "if nums[i] == nums[i - 1]:", "indent": 8, "notes": [2, 3]}, sort)

    def test_a_card_without_patterns(self):
        self.run_tool()
        c = self.deck()["cards"][1]
        self.assertNotIn("patterns", c)
        self.assertNotIn("harness", c)

    def test_never_overwrites_a_deck_it_did_not_write(self):
        os.makedirs(self.out)
        mine = os.path.join(self.out, "arrays-hashing.json")
        with open(mine, "w") as f:
            f.write('{"cards": [{"front": "mine", "back": "keep"}]}')
        r = self.run_tool()
        self.assertEqual(r.returncode, 1)
        self.assertIn("arrays-hashing", r.stderr)
        with open(mine) as f:
            self.assertIn("mine", f.read())

    def test_runs_again_over_its_own_decks(self):
        self.assertEqual(self.run_tool().returncode, 0)
        self.assertEqual(self.run_tool().returncode, 0)

    def test_dry_run_writes_nothing(self):
        r = self.run_tool("--dry-run")
        self.assertEqual(r.returncode, 0)
        self.assertFalse(os.path.exists(self.out))

    def test_verify_runs_every_solution_and_writes_nothing_on_a_failure(self):
        sys.path.insert(0, os.path.join(HERE, "..", "bridge"))
        import run as runner
        probe = runner.run({"solution": "def f(): pass", "harness": "__results__ = []"})
        if probe["status"] == "unavailable":
            self.skipTest("bwrap cannot run its sandbox here: %s" % probe.get("message"))
        r = self.run_tool("--verify")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        # The brute force variant returns False for everything; the solution
        # and the sorting variant pass.
        self.assertIn("gd:python:nc01_has_repeat (Brute force): failed hasRepeat([1, 1])", r.stderr)
        self.assertNotIn("Sorting", r.stderr)
        self.assertIn("1 of 3 runs failed", r.stderr)
        self.assertFalse(os.path.exists(self.out))

    def test_a_big_group_is_split_under_the_cap(self):
        many = [{"id": f"x{i}", "front": "f", "back": "b" * 4000} for i in range(80)]
        parts, cur = [], []
        for c in many:
            if cur and gd.size({"source": gd.SOURCE, "cards": cur + [c]}) > gd.DECK_BUDGET:
                parts.append(cur)
                cur = []
            cur.append(c)
        parts.append(cur)
        self.assertGreater(len(parts), 1)
        self.assertTrue(all(gd.size({"source": gd.SOURCE, "cards": p}) <= gd.DECK_BUDGET for p in parts))


if __name__ == "__main__":
    unittest.main(verbosity=1)
