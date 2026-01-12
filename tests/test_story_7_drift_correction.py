"""
Integration Test: Drift correction for tiled windows

Tests verify:
1. Drift correction properly restores vertically-tiled windows to correct position
2. The bug where drift correction fails for tiled windows due to missing relative_rect

Bug scenario (from Evolution window logs):
1. Window has saved config with connector="eDP-1", relative_rect={x:901, y:32, ...}, maximized=2
2. Window is restored: Maximize(2) + Place(901, 32) operations execute
3. But GNOME places window at (450, 32) instead of (901, 32) - likely shell default behavior
4. Drift is detected: position (450,32) != (901,32)
5. Code says "correcting drift (attempt 1/3)" but then "settled successfully" without fixing
6. Root cause: _onSettleTimeout passes state.targetConfig (which has frame_rect but NOT
   relative_rect) to generateRestoreOperations, which calls getBestAvailableConfig that
   expects relative_rect to convert to frame_rect. Since relative_rect is missing,
   the returned config has no frame_rect, so no Place operation is generated.

Key timing from real Evolution logs:
- Window created with generic title "Mail"
- ~2.2 seconds later, title changes to "Inbox (10842 unread)"
- This delay causes GNOME to place window at default position before matching occurs
"""

import time
import datetime
import pytest
from vmtest import (
    WindowControlClient, ExtensionState, PositionAssertion, TilePosition,
    wait_for_settle, tile_window,
    start_windowbot, kill_windowbot, find_windowbot_window,
    get_all_monitor_details, dump_window_details,
    poll_until
)


def log(msg):
    print(f"[{datetime.datetime.now().strftime('%H:%M:%S.%f')}] {msg}")


def wait_for_title_change(client, win_id, target_title, timeout=10.0):
    """Wait for window title to change to target value."""
    def check():
        try:
            details = client.get_details(win_id)
            return target_title in details.title
        except:
            return False

    return poll_until(check, timeout=timeout, poll=0.2)


def test_drift_correction_evolution_like():
    """
    Test drift correction with Evolution-like timing (delayed title change).

    This reproduces the real Evolution window bug where:
    1. Window is created with generic title "Mail"
    2. ~2.2 seconds later, title changes to "Inbox (10842 unread)"
    3. Extension waits for specific title, then matches and restores
    4. Window may drift from target position, requiring drift correction
    5. BUG: Drift correction failed because relative_rect was lost

    After fix: Window should end up at correct RIGHT-tiled position.
    """
    log("=== Evolution-like Drift Correction Test ===")

    client = WindowControlClient()
    ext_state = ExtensionState()

    # 1. Clear all state
    log(">>> Step 1: Clear all extension state")
    ext_state.clear_all()

    ext_state.enable_debug_logging(True)
    ext_state.set_sync_mode("RESTORE")
    ext_state.set_override("com.example.WindowBot", "RESTORE")

    primary = client.get_primary_monitor_index()
    monitors = get_all_monitor_details(refresh=True)
    log(f">>> Primary monitor: {primary}")
    log(f">>> Monitors: {[(m.index, m.x, m.y, m.width, m.height) for m in monitors]}")

    # 2. Launch window with evolution_like.conf (generic title -> specific after 2.2s)
    log(">>> Step 2: Launch windowbot with evolution_like.conf")
    pid = start_windowbot("evolution_like.conf")
    try:
        win = find_windowbot_window(client)
        assert win is not None
        log(f">>> Window found: id={win.id}")

        # Wait for title to change to specific
        log(">>> Waiting for title to become specific (Inbox)...")
        title_changed = wait_for_title_change(client, win.id, "Inbox", timeout=5.0)
        assert title_changed, "Title did not change to specific value"

        win = client.get_details(win.id)
        log(f">>> Title is now: {win.title}")

        # 3. Tile window RIGHT
        log(f">>> Step 3: Tile window RIGHT on monitor {primary}")
        tile_window(client, win.id, TilePosition.RIGHT, primary)
        wait_for_settle(3.0)

        win = client.get_details(win.id)
        dump_window_details(client, win.id, "After tiling RIGHT")

        # Verify tiling
        PositionAssertion.assert_tiled(win, TilePosition.RIGHT, monitor=primary)

        # Record the correct position
        saved_x, saved_y = win.x, win.y
        saved_width, saved_height = win.width, win.height
        log(f">>> Saved position: ({saved_x}, {saved_y}) size: {saved_width}x{saved_height}")
        log(f">>> Maximized state: {win.maximized}")

        # 4. Kill and restart the window
        log(">>> Step 4: Kill and restart windowbot to trigger restore")
        kill_windowbot(pid)
        wait_for_settle(2.0)

        pid = start_windowbot("evolution_like.conf")
        win = find_windowbot_window(client)
        assert win is not None
        log(f">>> Window restarted: id={win.id}")

        # Wait for title to become specific (triggers matching)
        log(">>> Waiting for title to become specific again...")
        title_changed = wait_for_title_change(client, win.id, "Inbox", timeout=5.0)
        assert title_changed, "Title did not change to specific value on restart"

        # 5. Wait for restore and settling (drift correction may happen here)
        log(">>> Step 5: Wait for restore and settling")
        wait_for_settle(5.0)

        # 6. Verify final position
        log(">>> Step 6: Verify window restored to correct position")
        win = client.get_details(win.id)
        dump_window_details(client, win.id, "FINAL STATE after restore")

        # Check if position is correct
        final_x, final_y = win.x, win.y

        # The bug causes window to end up at wrong x position
        if final_x != saved_x:
            log(f">>> BUG DETECTED: Window at x={final_x}, expected x={saved_x}")
            log(f">>> This indicates drift correction failed!")

        # Assert correct position
        PositionAssertion.assert_tiled(win, TilePosition.RIGHT, monitor=primary)

        log(">>> TEST PASSED: Drift correction worked correctly")

    finally:
        if pid is not None:
            kill_windowbot(pid)


def test_drift_correction_multiple_restarts():
    """
    Test that drift correction works across multiple window restarts.

    This tests that the issue is consistent and not a one-time race condition.
    """
    log("=== Drift Correction Multiple Restarts Test ===")

    client = WindowControlClient()
    ext_state = ExtensionState()

    # Clear all state
    log(">>> Cleanup & Setup")
    ext_state.clear_all()
    ext_state.enable_debug_logging(True)
    ext_state.set_sync_mode("RESTORE")
    ext_state.set_override("com.example.WindowBot", "RESTORE")

    primary = client.get_primary_monitor_index()

    # Launch and tile window
    log(">>> Launch and tile windowbot RIGHT")
    pid = start_windowbot("single.conf")
    try:
        win = find_windowbot_window(client)
        assert win is not None

        tile_window(client, win.id, TilePosition.RIGHT, primary)
        wait_for_settle(3.0)

        win = client.get_details(win.id)
        saved_x, saved_y = win.x, win.y
        PositionAssertion.assert_tiled(win, TilePosition.RIGHT, monitor=primary)

        # Restart 3 times
        for i in range(3):
            log(f">>> Restart {i+1}/3")
            kill_windowbot(pid)
            wait_for_settle(1.5)

            pid = start_windowbot("single.conf")
            win = find_windowbot_window(client)
            assert win is not None

            wait_for_settle(4.0)

            win = client.get_details(win.id)
            dump_window_details(client, win.id, f"After restart {i+1}")

            # Verify position is correct
            assert win.x == saved_x, (
                f"Restart {i+1}: Window x={win.x}, expected {saved_x}. "
                "Drift correction may have failed."
            )
            PositionAssertion.assert_tiled(win, TilePosition.RIGHT, monitor=primary)

        log(">>> TEST PASSED: All restarts restored correctly")

    finally:
        if 'pid' in locals():
            kill_windowbot(pid)


def test_drift_correction_left_tile():
    """
    Test drift correction for LEFT-tiled windows as well.

    Ensures the issue is specific to drift correction logic, not tiling direction.
    """
    log("=== Drift Correction LEFT Tile Test ===")

    client = WindowControlClient()
    ext_state = ExtensionState()

    # Clear all state
    log(">>> Cleanup & Setup")
    ext_state.clear_all()
    ext_state.enable_debug_logging(True)
    ext_state.set_sync_mode("RESTORE")
    ext_state.set_override("com.example.WindowBot", "RESTORE")

    primary = client.get_primary_monitor_index()

    # Launch and tile LEFT
    log(">>> Launch and tile windowbot LEFT")
    pid = start_windowbot("single.conf")
    try:
        win = find_windowbot_window(client)
        assert win is not None

        tile_window(client, win.id, TilePosition.LEFT, primary)
        wait_for_settle(3.0)

        win = client.get_details(win.id)
        dump_window_details(client, win.id, "After tiling LEFT")
        saved_x, saved_y = win.x, win.y
        PositionAssertion.assert_tiled(win, TilePosition.LEFT, monitor=primary)

        # Restart
        log(">>> Restart windowbot")
        kill_windowbot(pid)
        wait_for_settle(1.5)

        pid = start_windowbot("single.conf")
        win = find_windowbot_window(client)
        assert win is not None

        wait_for_settle(4.0)

        win = client.get_details(win.id)
        dump_window_details(client, win.id, "FINAL STATE after restart")

        PositionAssertion.assert_tiled(win, TilePosition.LEFT, monitor=primary)

        log(">>> TEST PASSED: LEFT tile restored correctly")

    finally:
        if 'pid' in locals():
            kill_windowbot(pid)


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
