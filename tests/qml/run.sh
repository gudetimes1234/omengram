#!/bin/sh
# Runs a QML test of the plugin in an off-screen Quickshell, against a
# throwaway home with a made-up drill deck.
#
#   tests/qml/run.sh drill-keys
#
# Needs quickshell, Omarchy's shell modules (Commons, Ui) under
# /usr/share/omarchy/shell, and a Wayland session to start in (the window
# itself is off-screen). Local only, like tests/soak.sh. Key presses are real
# key events (QtTest's TestEvent), delivered to the off-screen window.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
plugin=$(cd "$here/../.." && pwd)
name=${1:-drill-keys}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/config" "$work/home/.local/share/omengram/Drills" "$work/home/.local/state/omarchy"
ln -s /usr/share/omarchy/shell/Commons "$work/config/Commons"
ln -s /usr/share/omarchy/shell/Ui "$work/config/Ui"
ln -s "$plugin" "$work/config/plugin"
cp "$here/$name.qml" "$work/config/shell.qml"
cp "$here/fixture-drills.json" "$work/home/.local/share/omengram/Drills/sample.json"
out=$(HOME="$work/home" WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-1}" \
  QT_QUICK_BACKEND=software QT_QPA_PLATFORM=offscreen \
  timeout 90 quickshell -p "$work/config" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' || true)
printf '%s\n' "$out" | grep -E 'OK  |FAIL|DONE|TIMEOUT|ERROR' || printf '%s\n' "$out"
printf '%s\n' "$out" | grep -q 'DONE fails=0'
