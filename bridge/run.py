"""omengram-run: run a drill's solution against its tests, in a sandbox.

    echo '{"lang": "python", "solution": "...", "harness": "..."}' | omengram-run

Prints one line of JSON:

    {"status": "ran", "cases": [{"label", "expected", "actual", "pass"}], "stdout"}
    {"status": "error", "kind": "syntax"|"runtime"|"signature"|"memory"|"output",
     "message", "file", "line", "stdout"}
    {"status": "timeout", "stdout"}
    {"status": "unavailable", "message"}

A case passes when repr(expected) == repr(actual), GleamDrill's rule. Nothing
here grades: the results are something to look at before you grade yourself.

The code runs only inside bubblewrap: no network, no other processes, none
of your files (just a read-only /usr), an empty /tmp, a clean environment and
no capabilities, under limits on time, memory, file size, open files and
processes. If bwrap is missing or cannot make its namespaces, this refuses
with "unavailable". There is no way to run the code outside the sandbox.
"""

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile

# Wall-clock seconds before the sandbox is killed, and CPU seconds before the
# kernel stops the process; GleamDrill's 8-second budget for a run.
WALL_SECONDS = 8
CPU_SECONDS = 6
MEMORY_BYTES = 1 << 30
FILE_BYTES = 1 << 20
OPEN_FILES = 64
PROCESSES = 64
# What a run may send back, and what the solution's own printing may take of it.
OUTPUT_LIMIT = 1 << 20
STDOUT_LIMIT = 4000
REQUEST_LIMIT = 1 << 20

# Runs inside the sandbox. The solution and the harness are compiled apart, so
# a line number in an error is a line of your solution. Printing goes to a
# buffer, so the last line on stdout is always this script's verdict.
INNER = r'''
import io, json, sys, traceback

def emit(obj, out):
    obj["stdout"] = out.getvalue()[:%(stdout_limit)d]
    sys.__stdout__.write("\n" + json.dumps(obj) + "\n")
    sys.__stdout__.flush()

def where(tb, name):
    line = None
    for frame in traceback.extract_tb(tb):
        if frame.filename == name:
            line = frame.lineno
    return line

out = io.StringIO()
with open("/work/solution.py", encoding="utf-8") as f:
    solution = f.read()
with open("/work/harness.py", encoding="utf-8") as f:
    harness = f.read()
ns = {"__name__": "__main__", "__source__": solution}
try:
    code = compile(solution, "solution.py", "exec")
except SyntaxError as e:
    emit({"status": "error", "kind": "syntax", "message": "%%s: %%s" %% (type(e).__name__, e.msg),
          "file": "solution.py", "line": e.lineno}, out)
    sys.exit(0)
sys.stdout = out
try:
    exec(code, ns)
    exec(compile(harness, "harness.py", "exec"), ns)
except MemoryError:
    sys.stdout = sys.__stdout__
    emit({"status": "error", "kind": "memory", "message": "MemoryError: out of memory"}, out)
    sys.exit(0)
except RecursionError as e:
    sys.stdout = sys.__stdout__
    emit({"status": "error", "kind": "runtime", "message": "RecursionError: %%s" %% e,
          "file": "solution.py", "line": where(e.__traceback__, "solution.py")}, out)
    sys.exit(0)
except BaseException as e:
    sys.stdout = sys.__stdout__
    if str(e) == "__signature_mismatch__":
        emit({"status": "error", "kind": "signature",
              "message": "The solution does not define the function the tests call."}, out)
    else:
        line = where(e.__traceback__, "solution.py")
        emit({"status": "error", "kind": "runtime", "message": "%%s: %%s" %% (type(e).__name__, e),
              "file": "solution.py" if line else "harness.py",
              "line": line or where(e.__traceback__, "harness.py")}, out)
    sys.exit(0)
sys.stdout = sys.__stdout__
cases = [{"label": str(l), "expected": str(x), "actual": str(a), "pass": x == a}
         for l, x, a in ns.get("__results__", [])]
emit({"status": "ran", "cases": cases}, out)
''' % {"stdout_limit": STDOUT_LIMIT}


# Sandboxes running now, each in its own process group.
RUNNING = set()


def stop(signum, frame):
    """Stopped from outside (the card changed): take the sandboxes down too,
    rather than leave them running out their eight seconds."""
    for p in list(RUNNING):
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except OSError:
            pass
    sys.exit(1)


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def unavailable(message):
    return {"status": "unavailable", "message": message}


# The top-level directories programs are loaded from, laid out as the host has
# them: on Arch /lib64 is a link to usr/lib, on Debian and Ubuntu to usr/lib64,
# and on a system without the /usr merge they are directories of their own.
ROOT_DIRS = ("bin", "sbin", "lib", "lib32", "lib64", "libx32")


def root_layout():
    args = []
    for name in ROOT_DIRS:
        path = "/" + name
        if os.path.islink(path):
            args += ["--symlink", os.readlink(path), path]
        elif os.path.isdir(path):
            args += ["--ro-bind", path, path]
    return args


def sandbox_command(work):
    bwrap = shutil.which("bwrap")
    if not bwrap:
        return None
    return [
        "timeout", "-s", "KILL", str(WALL_SECONDS),
        bwrap,
        "--unshare-all", "--die-with-parent", "--new-session",
        "--clearenv", "--setenv", "PATH", "/usr/bin", "--setenv", "LANG", "C.UTF-8",
        "--ro-bind", "/usr", "/usr",
    ] + root_layout() + [
        "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
        "--ro-bind", work, "/work", "--chdir", "/tmp",
        "--cap-drop", "ALL",
        "--",
        "prlimit",
        "--as=%d" % MEMORY_BYTES, "--cpu=%d" % CPU_SECONDS, "--fsize=%d" % FILE_BYTES,
        "--nofile=%d" % OPEN_FILES, "--nproc=%d" % PROCESSES, "--core=0",
        "--",
        "python3", "-I", "-S", "-B", "/work/inner.py",
    ]


def private_dir():
    base = os.environ.get("XDG_RUNTIME_DIR")
    if not base or not os.path.isdir(base):
        base = None
    return tempfile.mkdtemp(prefix="omengram-run-", dir=base)


def write(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    # Readable inside the sandbox, which runs as you; nobody else gets past
    # the 0700 directory around it.
    os.chmod(path, 0o400)


def last_json(text):
    for line in reversed(text.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except ValueError:
                return None
    return None


def run(request):
    if not isinstance(request, dict):
        return unavailable("The request is not a JSON object.")
    lang = request.get("lang") or "python"
    if lang != "python":
        return unavailable("Only Python drills can run here.")
    solution, harness = request.get("solution"), request.get("harness")
    if not isinstance(solution, str) or not isinstance(harness, str) or not harness.strip():
        return unavailable("This card has no tests to run.")

    work = private_dir()
    try:
        write(os.path.join(work, "inner.py"), INNER)
        write(os.path.join(work, "solution.py"), solution)
        write(os.path.join(work, "harness.py"), harness)
        cmd = sandbox_command(work)
        if cmd is None:
            return unavailable("Running tests needs bubblewrap (bwrap), which is not installed. "
                               "Nothing runs without its sandbox.")
        p = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, start_new_session=True)
        RUNNING.add(p)
        try:
            stdout, stderr = p.communicate(timeout=WALL_SECONDS + 4)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)
            p.communicate()
            return {"status": "timeout", "stdout": ""}
        finally:
            RUNNING.discard(p)
        out = stdout[:OUTPUT_LIMIT].decode("utf-8", "replace")
        err = stderr[:OUTPUT_LIMIT].decode("utf-8", "replace")
        verdict = last_json(out)
        if verdict is not None and isinstance(verdict, dict) and "status" in verdict:
            return verdict
        # No verdict: the sandbox never started, or the run was killed.
        if err.startswith("bwrap:"):
            return unavailable("The sandbox could not start: " + err.strip().splitlines()[0])
        # timeout's 124 (sent SIGTERM) or 137 (SIGKILL); 152 is the kernel's
        # SIGXCPU at the CPU limit.
        if p.returncode in (124, 137, -9, 152) or p.returncode == 128 + 24:
            return {"status": "timeout", "stdout": ""}
        if len(stdout) >= OUTPUT_LIMIT:
            return {"status": "error", "kind": "output", "message": "The run printed too much.", "stdout": ""}
        tail = err.strip().splitlines()[-1:] or ["exit status %d" % p.returncode]
        return {"status": "error", "kind": "runtime", "message": tail[0][:500], "stdout": ""}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main():
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    raw = sys.stdin.buffer.read(REQUEST_LIMIT + 1)
    if len(raw) > REQUEST_LIMIT:
        emit(unavailable("The request is too large."))
        return
    try:
        request = json.loads(raw.decode("utf-8"))
    except ValueError:
        emit(unavailable("The request is not JSON."))
        return
    emit(run(request))


if __name__ == "__main__":
    main()
