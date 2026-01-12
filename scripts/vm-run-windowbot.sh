#!/bin/bash
# Helper script to run windowbot in the VM with proper environment
# This script runs inside the VM

CONFIG="${1:-/srv/window-control/testdata/simple.conf}"
TIMEOUT="${2:-30}"

export XDG_RUNTIME_DIR=/run/user/1000
export WAYLAND_DISPLAY=wayland-0
export DISPLAY=:0
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus

echo "Running windowbot with config: $CONFIG"
echo "Timeout: ${TIMEOUT}s"

# Run windowbot with timeout
timeout "$TIMEOUT" /usr/bin/python3 /srv/window-control/windowbot.py -v "$CONFIG"
exit_code=$?

if [ $exit_code -eq 124 ]; then
    echo "Test completed (timeout reached)"
    exit 0
else
    echo "windowbot exited with code: $exit_code"
    exit $exit_code
fi
