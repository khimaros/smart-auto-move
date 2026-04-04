"""
Integration Test: TRACKING windows should not swap on extension re-init

When the extension is disabled and re-enabled (as happens on lock/unlock),
windows with the same title should maintain their slot assignments via
preserved occupied state, rather than being re-matched ambiguously.

Test sequence:
1. launch two windows with same title on different workspaces
2. let them settle into TRACKING
3. reverse the saved slot order in GSettings (so natural matching order is wrong)
4. disable and re-enable the extension (simulating lock/unlock)
5. verify both windows maintained their workspace assignments (no swap)
"""

import json
import time
import datetime
import pytest
from vmtest import (
    WindowControlClient, ExtensionState, PositionAssertion, TilePosition,
    wait_for_settle, _dconf_read, _dconf_write,
    start_windowbot, kill_windowbot,
    get_all_monitor_details,
    poll_until
)

WINDOWBOT_WM_CLASS = "com.example.WindowBot"
TITLE = "Terminal"

def log(msg):
    print(f"[{datetime.datetime.now().strftime('%H:%M:%S.%f')}] {msg}")


def find_windowbot_windows(client, expected_count=2, timeout=10.0):
    """Find all windowbot windows, waiting until expected count is reached."""
    last_found = [0]
    def check():
        windows = []
        for win in client.list_windows():
            details = client.get_details(win['id'])
            if details.wm_class == WINDOWBOT_WM_CLASS:
                windows.append(details)
        if len(windows) != last_found[0]:
            log(f"    found {len(windows)} windowbot windows")
            last_found[0] = len(windows)
        if len(windows) >= expected_count:
            return windows
        return None

    result = poll_until(check, timeout=timeout)
    assert result is not None, f"expected {expected_count} windowbot windows, found {last_found[0]}, timed out"
    return result


def test_extension_reinit_no_swap():
    log("=== Story 10: TRACKING windows should not swap on extension re-init ===")

    client = WindowControlClient()
    ext_state = ExtensionState()

    # setup: single monitor
    log(">>> setup: clean state, single monitor")
    ext_state.clear_all()
    client.set_monitor_enabled("Virtual-3", False)
    client.set_monitor_enabled("Virtual-2", False)
    wait_for_settle(1.0)

    ext_state.enable_debug_logging(True)
    ext_state.set_sync_mode("RESTORE")
    ext_state.set_override(WINDOWBOT_WM_CLASS, "RESTORE")

    primary = client.get_primary_monitor_index()
    log(f">>> primary monitor: {primary}")

    wait_for_settle(1.0)

    # launch two windows with same title
    log(">>> launching windowbot with two same-titled windows")
    pid = start_windowbot("same_title_pair.conf")
    try:
        windows = find_windowbot_windows(client, expected_count=2, timeout=15.0)
        log(f">>> found {len(windows)} windows: {[(w.id, w.title) for w in windows]}")

        win_a = windows[0]
        win_b = windows[1]

        # tile both LEFT but on different workspaces (same position, only
        # workspace differs - maximally ambiguous for title-based matching)
        log(f">>> tiling window {win_a.id} LEFT on ws 0, window {win_b.id} LEFT on ws 1")
        wait_for_settle(1.0)
        client.move_to_workspace(win_a.id, 0)
        wait_for_settle(0.5)
        client.tile(win_a.id, 1, primary)  # left on ws 0
        wait_for_settle(0.5)
        client.move_to_workspace(win_b.id, 1)
        wait_for_settle(0.5)
        client.tile(win_b.id, 1, primary)  # left on ws 1
        wait_for_settle(3.0)  # let both settle into TRACKING

        # record assignments
        win_a = client.get_details(win_a.id)
        win_b = client.get_details(win_b.id)
        log(f">>> window A ({win_a.id}): ws={win_a.workspace} x={win_a.x} y={win_a.y}")
        log(f">>> window B ({win_b.id}): ws={win_b.workspace} x={win_b.x} y={win_b.y}")

        assert win_a.workspace == 0, f"window A should be on ws 0, got {win_a.workspace}"
        assert win_b.workspace == 1, f"window B should be on ws 1, got {win_b.workspace}"

        # reverse the slot order in saved-windows so that the first slot has
        # the config for ws 1 and the second has ws 0. this simulates what
        # happens when actor ordering differs from slot ordering (e.g. during
        # lock/unlock when GNOME may enumerate windows in a different order).
        # without positional tiebreaking, the first window processed would
        # match to the first unoccupied slot (wrong one), causing a swap.
        log(">>> reversing slot order in saved-windows")
        raw = _dconf_read("saved-windows")
        saved = json.loads(raw.strip("'"))
        log(f">>> saved-windows before: {len(saved)} slots")
        for i, slot in enumerate(saved):
            log(f"    slot {i}: occupied={slot.get('occupied')} ws={slot['props'].get('configs', [{}])[0].get('workspace', '?')}")

        saved.reverse()
        log(f">>> saved-windows after reverse:")
        for i, slot in enumerate(saved):
            log(f"    slot {i}: occupied={slot.get('occupied')} ws={slot['props'].get('configs', [{}])[0].get('workspace', '?')}")

        # disable extension before writing to avoid triggering a reload
        log(">>> disabling extension (simulating lock)")
        ext_state.disable_extension()
        wait_for_settle(0.5)

        # write the reversed state
        _dconf_write("saved-windows", f"'{json.dumps(saved)}'")

        log(">>> re-enabling extension (simulating unlock)")
        ext_state.enable_extension()
        ext_state.enable_debug_logging(True)
        wait_for_settle(3.0)

        # verify windows maintained their workspace assignments
        win_a_after = client.get_details(win_a.id)
        win_b_after = client.get_details(win_b.id)
        log(f">>> window A after ({win_a_after.id}): ws={win_a_after.workspace} x={win_a_after.x} y={win_a_after.y}")
        log(f">>> window B after ({win_b_after.id}): ws={win_b_after.workspace} x={win_b_after.x} y={win_b_after.y}")

        # key assertion: workspaces should not have swapped
        assert win_a_after.workspace == 0, (
            f"window A ({win_a.id}) workspace changed! was 0, now {win_a_after.workspace}"
        )
        assert win_b_after.workspace == 1, (
            f"window B ({win_b.id}) workspace changed! was 1, now {win_b_after.workspace}"
        )

        log(">>> PASS: windows maintained their assignments after extension re-init")

    finally:
        kill_windowbot(pid)
