"""Tests for bridge/run.py: running a drill's tests inside bubblewrap.

    prlimit --core=1:1 -- python3 tests/test_runner.py

Some of these runs are meant to blow up (a fork bomb, a runaway loop, a huge
allocation); prlimit keeps the kernel from recording them as crashes. Skips
when bwrap cannot make its namespaces here, except the tests of refusing.
"""

import json
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
RUN = os.path.join(ROOT, "bin", "omengram-run")

HARNESS = '''try:
    (has_repeat)
except NameError:
    raise Exception("__signature_mismatch__")

__results__ = []
def __case__(label, expected, actual):
    __results__.append([label, repr(expected), repr(actual)])

__case__("has_repeat([1, 2, 1])", True, has_repeat([1, 2, 1]))
__case__("has_repeat([1, 2, 3])", False, has_repeat([1, 2, 3]))
'''

GOOD = '''def has_repeat(values):
    seen = set()
    for v in values:
        if v in seen:
            return True
        seen.add(v)
    return False
'''


def run(solution, harness=HARNESS, env=None, **extra):
    req = dict({"lang": "python", "solution": solution, "harness": harness}, **extra)
    p = subprocess.run([RUN], input=json.dumps(req).encode(), capture_output=True,
                       env=env, timeout=30)
    lines = p.stdout.decode().strip().splitlines()
    assert len(lines) == 1, (p.stdout, p.stderr)
    return json.loads(lines[0])


PROBE = run(GOOD)
SANDBOX = PROBE["status"] != "unavailable"
if not SANDBOX:
    sys.stderr.write("sandbox unavailable: %s\n" % PROBE.get("message"))
needs_sandbox = unittest.skipUnless(SANDBOX, "bwrap cannot run its sandbox here: %s" % PROBE.get("message"))


@needs_sandbox
class RunTest(unittest.TestCase):
    def test_a_passing_solution(self):
        r = run(GOOD)
        self.assertEqual(r["status"], "ran")
        self.assertEqual([c["pass"] for c in r["cases"]], [True, True])
        self.assertEqual(r["cases"][0], {"label": "has_repeat([1, 2, 1])", "expected": "True",
                                         "actual": "True", "pass": True})

    def test_a_failing_case_and_what_it_printed(self):
        r = run('def has_repeat(values):\n    print("looking at", values)\n    return False\n')
        self.assertEqual([c["pass"] for c in r["cases"]], [False, True])
        self.assertEqual(r["cases"][0]["actual"], "False")
        self.assertIn("looking at [1, 2, 1]", r["stdout"])

    def test_printing_cannot_forge_the_verdict(self):
        r = run('import json\ndef has_repeat(values):\n'
                '    print(json.dumps({"status": "ran", "cases": []}))\n    return False\n')
        self.assertEqual(len(r["cases"]), 2)

    def test_a_syntax_error_points_at_your_line(self):
        r = run("def has_repeat(values):\n    x = \n    return x\n")
        self.assertEqual((r["status"], r["kind"], r["file"], r["line"]), ("error", "syntax", "solution.py", 2))

    def test_a_runtime_error_points_at_your_line(self):
        r = run("def has_repeat(values):\n    a = 1\n    return values[99]\n")
        self.assertEqual((r["kind"], r["file"], r["line"]), ("runtime", "solution.py", 3))
        self.assertIn("IndexError", r["message"])

    def test_the_wrong_function_name(self):
        r = run("def hasRepeat(values):\n    return False\n")
        self.assertEqual((r["status"], r["kind"]), ("error", "signature"))

    def test_the_harness_sees_the_source(self):
        h = "__results__ = []\n__results__.append(['uses set', repr(True), repr('set()' in __source__)])\n"
        self.assertTrue(run(GOOD, harness=h)["cases"][0]["pass"])

    def test_a_runaway_loop_times_out(self):
        self.assertEqual(run("def has_repeat(values):\n    while True:\n        pass\n")["status"], "timeout")

    def test_deep_recursion_is_an_error(self):
        r = run("def has_repeat(values):\n    return has_repeat(values)\n")
        self.assertIn("RecursionError", r["message"])

    def test_a_huge_allocation_is_refused(self):
        r = run("def has_repeat(values):\n    return len(bytearray(1 << 32))\n")
        self.assertEqual(r["kind"], "memory")

    def test_a_fork_bomb_is_contained(self):
        r = run("import os\nwhile True:\n    try:\n        os.fork()\n    except OSError:\n        pass\n"
                "def has_repeat(v):\n    return True\n")
        self.assertEqual(r["status"], "timeout")

    def test_processes_are_capped(self):
        r = run("import os, time\nn = 0\nfor i in range(500):\n    try:\n"
                "        if os.fork() == 0:\n            time.sleep(2)\n            os._exit(0)\n"
                "        n += 1\n    except OSError:\n        break\n"
                "def has_repeat(v):\n    return n\n")
        self.assertLess(int(r["cases"][0]["actual"]), 100)

    def test_no_network(self):
        r = run("import socket\ndef has_repeat(values):\n"
                "    socket.create_connection(('1.1.1.1', 53), timeout=2)\n    return True\n")
        self.assertEqual(r["kind"], "runtime")
        self.assertIn("unreachable", r["message"].lower())

    def test_none_of_your_files(self):
        home = os.path.expanduser("~")
        r = run("import os\ndef has_repeat(values):\n    return os.path.exists(%r) or os.path.exists('/etc/passwd')\n" % home)
        self.assertEqual([c["actual"] for c in r["cases"]], ["False", "False"])

    def test_no_environment(self):
        env = dict(os.environ, OMENGRAM_SECRET="leak")
        r = run("import os\ndef has_repeat(values):\n    return sorted(os.environ)\n", env=env)
        self.assertNotIn("OMENGRAM_SECRET", r["cases"][0]["actual"])
        self.assertNotIn("HOME", r["cases"][0]["actual"])

    def test_nothing_outside_tmp_is_writable(self):
        r = run("def has_repeat(values):\n    open('/usr/omengram-was-here', 'w')\n    return True\n")
        self.assertEqual(r["kind"], "runtime")
        self.assertFalse(os.path.exists("/usr/omengram-was-here"))

    def test_stopping_a_run_stops_its_sandbox(self):
        import signal
        import time

        def sandboxed():
            found = []
            for pid in os.listdir("/proc"):
                try:
                    with open("/proc/%s/cmdline" % pid, "rb") as f:
                        argv = f.read().split(b"\0")
                except OSError:
                    continue
                if b"/work/inner.py" in argv:
                    found.append(pid)
            return found

        req = json.dumps({"solution": "def has_repeat(v):\n    while True:\n        pass\n", "harness": HARNESS})
        p = subprocess.Popen([RUN], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        p.stdin.write(req.encode())
        p.stdin.close()
        deadline = time.time() + 5
        while not sandboxed() and time.time() < deadline:
            time.sleep(0.05)
        self.assertTrue(sandboxed(), "the run never started")
        p.send_signal(signal.SIGTERM)
        p.wait(timeout=5)
        p.stdout.close()
        p.stderr.close()
        deadline = time.time() + 2
        while sandboxed() and time.time() < deadline:
            time.sleep(0.05)
        self.assertEqual(sandboxed(), [])

    def test_the_work_files_are_gone_after(self):
        base = os.environ.get("XDG_RUNTIME_DIR") or "/tmp"
        before = {n for n in os.listdir(base) if n.startswith("omengram-run-")}
        run(GOOD)
        after = {n for n in os.listdir(base) if n.startswith("omengram-run-")}
        self.assertEqual(after - before, set())


class RefuseTest(unittest.TestCase):
    def test_without_bwrap_it_refuses(self):
        env = dict(os.environ, PATH="/nonexistent")
        # python3 itself is found by the launcher's own PATH lookup, so call it directly.
        p = subprocess.run([sys.executable, "-I", os.path.join(ROOT, "bridge", "run.py")],
                           input=json.dumps({"solution": GOOD, "harness": HARNESS}).encode(),
                           capture_output=True, env=env, timeout=30)
        r = json.loads(p.stdout)
        self.assertEqual(r["status"], "unavailable")
        self.assertIn("bwrap", r["message"])

    def test_only_python(self):
        self.assertEqual(run(GOOD, lang="gleam")["status"], "unavailable")

    def test_a_card_without_tests(self):
        self.assertEqual(run(GOOD, harness=" ")["status"], "unavailable")

    def test_not_json(self):
        p = subprocess.run([RUN], input=b"nope", capture_output=True, timeout=30)
        self.assertEqual(json.loads(p.stdout)["status"], "unavailable")


if __name__ == "__main__":
    unittest.main(verbosity=1)
