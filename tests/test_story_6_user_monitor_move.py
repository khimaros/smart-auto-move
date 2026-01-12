"""
Integration Test: User monitor move and LIFO connector preference

Tests verify:
1. When user explicitly moves a window to a monitor, it stays there (no bounce-back)
2. LIFO connector preference: most recent user choice has highest priority
3. When a preferred monitor reconnects, window moves back to it
4. Extension fallbacks (monitor disconnect) don't update preference list

Bug scenario (original):
1. Window has saved configs for both monitor 0 (external) and monitor 1 (built-in)
2. User moves window from monitor 1 to monitor 0
3. Extension correctly detects "user monitor change" and starts restoring to monitor 0
4. During drift correction (small position difference), extension incorrectly uses
   getBestAvailableConfig which prefers highest monitor index
5. Window gets moved back to monitor 1, ignoring user's explicit choice

LIFO connector preference example:
1. Window starts on A        → prefs: [A]           → on A
2. Attach B, user moves to B → prefs: [B, A]        → on B (USER)
3. B disconnects             → prefs: [B, A]        → on A (FALLBACK)
4. C connects                → prefs: [B, A]        → stays on A (B unavailable, C not in prefs)
5. User moves to C           → prefs: [C, B, A]     → on C (USER)
6. B connects                → prefs: [C, B, A]     → stays on C (C is top pref)
7. C disconnects             → prefs: [C, B, A]     → on B (FALLBACK)
8. B disconnects             → prefs: [C, B, A]     → on A (FALLBACK)
9. C connects                → prefs: [C, B, A]     → MOVES TO C (top pref now available!)
"""

import time
import datetime
import pytest
from vmtest import (
    WindowControlClient, ExtensionState, PositionAssertion, TilePosition,
    wait_for_settle, move_to_monitor_and_tile, tile_window,
    start_windowbot, kill_windowbot, find_windowbot_window,
    get_all_monitor_details, dump_window_details,
    poll_until
)


def log(msg):
    print(f"[{datetime.datetime.now().strftime('%H:%M:%S.%f')}] {msg}")


def wait_for_monitor_count(client, count, timeout=10):
    """Wait until monitor count equals expected count."""
    def check():
        monitors = get_all_monitor_details(refresh=True)
        return len(monitors) == count

    if not poll_until(check, timeout=timeout):
        monitors = get_all_monitor_details(refresh=True)
        raise RuntimeError(f"Timeout waiting for monitor count {count}. Current: {len(monitors)}")


def test_user_monitor_move_respects_choice():
    """
    Test that when user explicitly moves a window to a different monitor via
    "Move to monitor" context menu, the extension doesn't bounce it back.

    Scenario (replicates production bug):
    1. Clear saved windows/extension state
    2. Start with BOTH monitors enabled
    3. Launch window, tile RIGHT on monitor 0 (lower index) - saves config for monitor 0
    4. Move to monitor 1, tile RIGHT - saves config for monitor 1
    5. Now we have configs for BOTH monitors (like production Signal case)
    6. User action: "Move to monitor" from monitor 1 TO monitor 0 (lower index)
    7. Assert window stays on monitor 0

    BUG: During drift correction, the extension calls getBestAvailableConfig() which
    prefers HIGHER monitor indices. When the user explicitly moved to monitor 0,
    drift correction should use the saved config for monitor 0 (state.targetConfig),
    not pick the "best" one (monitor 1).

    Production case: Signal had configs for both monitors. User moved from monitor 1
    to monitor 0. Extension detected small position drift (901,0 vs 901,32) and
    called drift correction, which used getBestAvailableConfig() returning monitor 1,
    bouncing the window back.
    """
    log("=== User Monitor Move Respects Choice Test ===")

    client = WindowControlClient()
    ext_state = ExtensionState()

    # 1. Clear all state
    log(">>> Step 1: Clear all extension state")
    ext_state.clear_all()

    # 2. Ensure exactly two monitors are enabled (Virtual-1 and Virtual-2)
    log(">>> Step 2: Set up exactly 2 monitors (Virtual-1, Virtual-2)")
    client.set_monitor_enabled("Virtual-3", False)  # Disable 3rd monitor if present
    client.set_monitor_enabled("Virtual-2", True)   # Ensure 2nd monitor is enabled
    wait_for_monitor_count(client, 2)

    ext_state.enable_debug_logging(True)
    ext_state.set_sync_mode("RESTORE")
    ext_state.set_override("com.example.WindowBot", "RESTORE")

    monitors = get_all_monitor_details(refresh=True)
    log(f">>> Monitors: {[(m.index, m.x, m.y, m.width, m.height) for m in monitors]}")
    assert len(monitors) == 2, f"Expected 2 monitors, got {len(monitors)}"

    # Use explicit connectors: Virtual-1 = primary, Virtual-2 = secondary
    # The bug prefers higher index, so we test moving TO Virtual-1
    lower_monitor = 0  # Virtual-1
    higher_monitor = 1  # Virtual-2
    log(f">>> Target connector: Virtual-1 (monitor {lower_monitor})")

    # 3. Launch window and tile on lower monitor (monitor 0)
    # This creates a saved config for monitor 0
    log(f">>> Step 3: Launch windowbot and tile RIGHT on monitor {lower_monitor}")
    pid = start_windowbot("single.conf")
    try:
        win = find_windowbot_window(client)
        assert win is not None
        log(f">>> Window found: id={win.id}")

        # Move to lower monitor and tile RIGHT
        move_to_monitor_and_tile(client, win.id, lower_monitor, TilePosition.RIGHT)
        wait_for_settle(3.0)

        win = client.get_details(win.id)
        dump_window_details(client, win.id, f"After tiling RIGHT on monitor {lower_monitor}")
        PositionAssertion.assert_tiled(win, TilePosition.RIGHT, monitor=lower_monitor)
        log(f">>> Config saved for monitor {lower_monitor}")

        # 4. Move to higher monitor and tile RIGHT
        # This creates a saved config for the higher monitor
        log(f">>> Step 4: Move to monitor {higher_monitor} and tile RIGHT")
        move_to_monitor_and_tile(client, win.id, higher_monitor, TilePosition.RIGHT)
        wait_for_settle(3.0)

        win = client.get_details(win.id)
        dump_window_details(client, win.id, f"After tiling RIGHT on monitor {higher_monitor}")
        PositionAssertion.assert_tiled(win, TilePosition.RIGHT, monitor=higher_monitor)
        log(f">>> Config saved for monitor {higher_monitor}")
        log(">>> Now we have configs for BOTH monitors (like production Signal case)")

        # 5. USER ACTION: Move from higher monitor (1) TO lower monitor (0)
        # This is the key step - user explicitly chooses to go to lower index
        # Get the target connector name for assertion
        target_connector = client.get_connector_for_logical(lower_monitor)
        log(f">>> Step 5: USER ACTION - Move window from monitor {higher_monitor} TO monitor {lower_monitor} ({target_connector})")
        log(">>> (Simulating user moving and tiling window)")
        # Note: Using move_to_monitor_and_tile because GNOME's bare move_to_monitor
        # on tiled windows can leave the window at the monitor boundary, which
        # GNOME considers to be on the wrong monitor. This matches user behavior
        # where they move AND position the window on the target monitor.
        move_to_monitor_and_tile(client, win.id, lower_monitor, TilePosition.RIGHT)

        # Wait for extension to process - this is where the bug manifests
        # The extension should update preference to put Virtual-1 first
        log(">>> Waiting for extension to process move and update preference...")
        wait_for_settle(3.0)

        # 6. VERIFY: Window should stay on the target connector
        log(f">>> Step 6: Verify window stays on connector {target_connector}")

        # Poll for stability - check multiple times
        stable_on_target = 0
        bounced_away = False
        for i in range(8):
            win = client.get_details(win.id)
            current_connector = client.get_window_connector(win)
            log(f"    Check {i+1}: connector={current_connector} monitor={win.monitor} x={win.x} y={win.y}")

            if current_connector == target_connector:
                stable_on_target += 1
            else:
                bounced_away = True
                log(f"    BUG DETECTED: Window bounced to {current_connector}!")

            time.sleep(0.5)

        # Final state
        win = client.get_details(win.id)
        final_connector = client.get_window_connector(win)
        dump_window_details(client, win.id, "FINAL STATE")

        # Assert based on connector name, not monitor index
        assert final_connector == target_connector, (
            f"BUG: Window should stay on connector {target_connector} "
            f"(user's explicit 'Move to monitor' action), "
            f"but ended up on connector {final_connector}. "
            f"Stable on target: {stable_on_target}/8 checks. "
            f"Bounced away: {bounced_away}. "
            "The extension's LIFO preference should honor user's explicit choice."
        )

        log(">>> TEST PASSED: Window stayed on user's chosen monitor")

    finally:
        if pid is not None:
            kill_windowbot(pid)


def test_drift_correction_on_same_monitor():
    """
    Test that drift correction works correctly when staying on the same monitor.

    This is a sanity check to ensure drift correction still functions properly
    for position adjustments within a single monitor.
    """
    log("=== Drift Correction Same Monitor Test ===")

    client = WindowControlClient()
    ext_state = ExtensionState()

    # Ensure clean state
    log(">>> Cleanup & Setup")
    ext_state.clear_all()
    ext_state.enable_debug_logging(True)
    ext_state.set_sync_mode("RESTORE")
    ext_state.set_override("com.example.WindowBot", "RESTORE")

    primary = client.get_primary_monitor_index()
    log(f">>> Primary Monitor: {primary}")

    # 1. Launch windowbot
    log(">>> Launching windowbot")
    pid = start_windowbot("single.conf")
    try:
        win = find_windowbot_window(client)
        assert win is not None

        # 2. Tile RIGHT on primary monitor
        log(f">>> Tiling RIGHT on Monitor {primary}")
        move_to_monitor_and_tile(client, win.id, primary, TilePosition.RIGHT)

        win = client.get_details(win.id)
        initial_x, initial_y = win.x, win.y
        dump_window_details(client, win.id, "Initial state")

        wait_for_settle(2.0)

        # 3. Close and reopen windowbot (to trigger restore)
        log(">>> Restarting windowbot to trigger restore")
        kill_windowbot(pid)
        wait_for_settle(1.0)

        pid = start_windowbot("single.conf")
        win = find_windowbot_window(client)
        assert win is not None

        # Wait for restore and settling
        wait_for_settle(3.0)

        # 4. Verify window is restored to correct position
        win = client.get_details(win.id)
        dump_window_details(client, win.id, "After restore")

        # Should be tiled RIGHT on primary
        PositionAssertion.assert_tiled(win, TilePosition.RIGHT, monitor=primary)

        log(">>> TEST PASSED: Drift correction works correctly on same monitor")

    finally:
        if 'pid' in locals():
            kill_windowbot(pid)


def test_lifo_preference_reconnect_moves_to_preferred():
    """
    Test LIFO connector preference: when preferred monitor reconnects, window moves to it.

    Scenario:
    1. Window starts on monitor 0 (A)              → prefs: [A]
    2. Enable monitor 1 (B), user moves to B       → prefs: [B, A]
    3. Disable monitor 1 (B)                       → window falls back to A, prefs unchanged
    4. Re-enable monitor 1 (B)                     → window should move BACK to B (top pref)

    This tests that when a user's preferred monitor reconnects, the window
    automatically moves back to it.
    """
    log("=== LIFO Preference: Reconnect Moves to Preferred ===")

    client = WindowControlClient()
    ext_state = ExtensionState()

    # 1. Setup - start with single monitor
    log(">>> Step 1: Setup with single monitor")
    ext_state.clear_all()
    client.set_monitor_enabled("Virtual-2", False)  # Disable Virtual-2
    wait_for_monitor_count(client, 1)

    ext_state.enable_debug_logging(True)
    ext_state.set_sync_mode("RESTORE")
    ext_state.set_override("com.example.WindowBot", "RESTORE")

    monitors = get_all_monitor_details(refresh=True)
    log(f">>> Single monitor setup: {[(m.index, m.x, m.y, m.width, m.height) for m in monitors]}")
    assert len(monitors) == 1, f"Expected 1 monitor, got {len(monitors)}"

    # 2. Launch window on monitor 0
    log(">>> Step 2: Launch windowbot on monitor 0")
    pid = start_windowbot("single.conf")
    try:
        win = find_windowbot_window(client)
        assert win is not None
        log(f">>> Window found: id={win.id}")

        # Tile to establish saved config
        tile_window(client, win.id, TilePosition.RIGHT)
        wait_for_settle(2.0)

        win = client.get_details(win.id)
        assert win.monitor == 0, f"Window should be on monitor 0, got {win.monitor}"
        log(f">>> Window on monitor 0 - prefs should be: [monitor0_connector]")

        # 3. Enable monitor 1 and move window there (USER ACTION)
        log(">>> Step 3: Enable monitor 1 and USER moves window there")
        client.set_monitor_enabled("Virtual-2", True)
        wait_for_monitor_count(client, 2)
        wait_for_settle(2.0)

        # User action: move to monitor 1 and tile (use combined function for reliability)
        move_to_monitor_and_tile(client, win.id, 1, TilePosition.RIGHT)
        wait_for_settle(3.0)

        win = client.get_details(win.id)
        target_connector = "Virtual-2"
        actual_connector = client.get_window_connector(win)
        dump_window_details(client, win.id, "After user move to Virtual-2")
        assert actual_connector == target_connector, f"Window should be on {target_connector} after user move, got {actual_connector}"
        log(f">>> Window on {target_connector} - prefs should be: [Virtual-2, Virtual-1]")

        # 4. Disable monitor 1 - window should fall back to monitor 0
        log(">>> Step 4: Disable Virtual-2 (B disconnects)")
        client.set_monitor_enabled("Virtual-2", False)
        wait_for_monitor_count(client, 1)
        wait_for_settle(3.0)

        win = client.get_details(win.id)
        fallback_connector = client.get_window_connector(win)
        dump_window_details(client, win.id, "After Virtual-2 disconnect")
        assert fallback_connector == "Virtual-1", f"Window should fall back to Virtual-1, got {fallback_connector}"
        log(f">>> Window fell back to Virtual-1 - prefs should still be: [Virtual-2, Virtual-1]")

        # 5. Re-enable monitor 1 - window should move BACK to it (top preference)
        log(">>> Step 5: Re-enable Virtual-2 (B reconnects)")
        client.set_monitor_enabled("Virtual-2", True)
        wait_for_monitor_count(client, 2)
        wait_for_settle(3.0)

        # Poll to check window moves back to Virtual-2
        moved_back = False
        for i in range(10):
            win = client.get_details(win.id)
            current_connector = client.get_window_connector(win)
            log(f"    Check {i+1}: connector={current_connector}")
            if current_connector == "Virtual-2":
                moved_back = True
                break
            time.sleep(0.5)

        win = client.get_details(win.id)
        final_connector = client.get_window_connector(win)
        dump_window_details(client, win.id, "FINAL STATE after reconnect")

        assert final_connector == "Virtual-2", (
            f"Window should move back to Virtual-2 (preferred) when it reconnects, "
            f"but stayed on {final_connector}. "
            "LIFO preference should restore to highest-priority available connector."
        )

        log(">>> TEST PASSED: Window moved back to preferred connector on reconnect")

    finally:
        if pid is not None:
            kill_windowbot(pid)
        # Restore 2 monitors for other tests
        client.set_monitor_enabled("Virtual-2", True)


def test_lifo_preference_user_override():
    """
    Test that user can override LIFO preference by explicitly moving to a different monitor.

    Scenario:
    1. Window starts on monitor 0, user moves to monitor 1  → prefs: [B, A]
    2. User explicitly moves back to monitor 0              → prefs: [A, B]
    3. Monitor 1 disconnects and reconnects                 → window stays on 0 (now top pref)

    This tests that user's most recent explicit choice always wins.
    """
    log("=== LIFO Preference: User Override ===")

    client = WindowControlClient()
    ext_state = ExtensionState()

    # Setup
    log(">>> Setup")
    ext_state.clear_all()
    client.set_monitor_enabled("Virtual-2", True)
    wait_for_monitor_count(client, 2)

    ext_state.enable_debug_logging(True)
    ext_state.set_sync_mode("RESTORE")
    ext_state.set_override("com.example.WindowBot", "RESTORE")

    # Launch window
    log(">>> Launch windowbot")
    pid = start_windowbot("single.conf")
    try:
        win = find_windowbot_window(client)
        assert win is not None

        # 1. Tile on Virtual-1, then move to Virtual-2
        log(">>> Step 1: Tile on Virtual-1, then user moves to Virtual-2")
        move_to_monitor_and_tile(client, win.id, 0, TilePosition.RIGHT)
        wait_for_settle(2.0)

        move_to_monitor_and_tile(client, win.id, 1, TilePosition.RIGHT)
        wait_for_settle(2.0)

        win = client.get_details(win.id)
        actual_connector = client.get_window_connector(win)
        assert actual_connector == "Virtual-2", f"Window should be on Virtual-2, got {actual_connector}"
        log(f">>> Window on Virtual-2 - prefs: [Virtual-2, Virtual-1]")

        # 2. User explicitly moves BACK to Virtual-1
        log(">>> Step 2: User explicitly moves back to Virtual-1")
        move_to_monitor_and_tile(client, win.id, 0, TilePosition.RIGHT)
        wait_for_settle(3.0)

        win = client.get_details(win.id)
        actual_connector = client.get_window_connector(win)
        assert actual_connector == "Virtual-1", f"Window should be on Virtual-1, got {actual_connector}"
        log(f">>> Window on Virtual-1 - prefs should now be: [Virtual-1, Virtual-2]")

        # 3. Disconnect and reconnect Virtual-2
        log(">>> Step 3: Disconnect and reconnect Virtual-2")
        client.set_monitor_enabled("Virtual-2", False)
        wait_for_monitor_count(client, 1)
        wait_for_settle(2.0)

        client.set_monitor_enabled("Virtual-2", True)
        wait_for_monitor_count(client, 2)
        wait_for_settle(3.0)

        # Window should STAY on Virtual-1 (now top preference after user override)
        win = client.get_details(win.id)
        final_connector = client.get_window_connector(win)
        dump_window_details(client, win.id, "FINAL STATE")

        assert final_connector == "Virtual-1", (
            f"Window should stay on Virtual-1 (user's most recent choice), "
            f"but moved to {final_connector}. "
            "User's explicit move to Virtual-1 should have made it top preference."
        )

        log(">>> TEST PASSED: User override updated LIFO preference correctly")

    finally:
        if pid is not None:
            kill_windowbot(pid)


def test_lifo_three_monitor_full_scenario():
    """
    Test the full LIFO connector preference scenario with 3 monitors.

    This tests the complete example from the docstring:
    1. Window starts on A (Virtual-1)    → prefs: [A]           → on A
    2. Attach B, user moves to B         → prefs: [B, A]        → on B (USER)
    3. B disconnects                     → prefs: [B, A]        → on A (FALLBACK)
    4. C connects                        → prefs: [B, A]        → stays on A (B unavail, C not in prefs)
    5. User moves to C                   → prefs: [C, B, A]     → on C (USER)
    6. B connects                        → prefs: [C, B, A]     → stays on C (C is top pref)
    7. C disconnects                     → prefs: [C, B, A]     → on B (FALLBACK)
    8. B disconnects                     → prefs: [C, B, A]     → on A (FALLBACK)
    9. C connects                        → prefs: [C, B, A]     → MOVES TO C (top pref now available!)
    """
    log("=== LIFO Three Monitor Full Scenario ===")

    client = WindowControlClient()
    ext_state = ExtensionState()

    # A = Virtual-1, B = Virtual-2, C = Virtual-3

    # Setup: Start with only Virtual-1 (A)
    log(">>> Setup: Start with single monitor (Virtual-1)")
    ext_state.clear_all()
    client.set_monitor_enabled("Virtual-2", False)
    client.set_monitor_enabled("Virtual-3", False)
    wait_for_monitor_count(client, 1)

    ext_state.enable_debug_logging(True)
    ext_state.set_sync_mode("RESTORE")
    ext_state.set_override("com.example.WindowBot", "RESTORE")

    monitors = get_all_monitor_details(refresh=True)
    log(f">>> Initial monitors: {[client.get_connector_for_logical(m.index) for m in monitors]}")
    assert len(monitors) == 1

    # Step 1: Window starts on A (Virtual-1)
    log(">>> Step 1: Launch window on Virtual-1 (A)")
    pid = start_windowbot("single.conf")
    try:
        win = find_windowbot_window(client)
        assert win is not None
        log(f">>> Window found: id={win.id}")

        # Use move_to_monitor_and_tile to ensure config is saved for monitor 0
        move_to_monitor_and_tile(client, win.id, 0, TilePosition.RIGHT)
        wait_for_settle(2.0)

        win = client.get_details(win.id)
        connector_a = client.get_window_connector(win)
        assert connector_a == "Virtual-1", f"Expected Virtual-1, got {connector_a}"
        log(f">>> Window on {connector_a} - prefs: [{connector_a}]")

        # Step 2: Attach B (Virtual-2), user moves to B
        log(">>> Step 2: Attach Virtual-2 (B), user moves window there")
        client.set_monitor_enabled("Virtual-2", True)
        wait_for_monitor_count(client, 2)
        wait_for_settle(2.0)

        move_to_monitor_and_tile(client, win.id, 1, TilePosition.RIGHT)
        wait_for_settle(3.0)

        win = client.get_details(win.id)
        connector = client.get_window_connector(win)
        assert connector == "Virtual-2", f"Expected Virtual-2, got {connector}"
        log(f">>> Window on Virtual-2 - prefs: [Virtual-2, Virtual-1]")

        # Step 3: B disconnects, window falls back to A
        log(">>> Step 3: Disconnect Virtual-2 (B), fallback to Virtual-1 (A)")
        client.set_monitor_enabled("Virtual-2", False)
        wait_for_monitor_count(client, 1)
        wait_for_settle(3.0)

        win = client.get_details(win.id)
        connector = client.get_window_connector(win)
        assert connector == "Virtual-1", f"Expected Virtual-1 fallback, got {connector}"
        log(f">>> Window on Virtual-1 (fallback) - prefs unchanged: [Virtual-2, Virtual-1]")

        # Step 4: C connects, window stays on A (B unavail, C not in prefs)
        log(">>> Step 4: Connect Virtual-3 (C), window should stay on Virtual-1 (A)")
        client.set_monitor_enabled("Virtual-3", True)
        wait_for_monitor_count(client, 2)
        wait_for_settle(3.0)

        win = client.get_details(win.id)
        connector = client.get_window_connector(win)
        assert connector == "Virtual-1", (
            f"Window should stay on Virtual-1 (Virtual-2 unavailable, Virtual-3 not in prefs), "
            f"but moved to {connector}"
        )
        log(f">>> Window stayed on Virtual-1 - Virtual-3 not in prefs yet")

        # Step 5: User moves to C
        log(">>> Step 5: USER moves window to Virtual-3 (C)")
        # Find monitor index for Virtual-3
        monitors = get_all_monitor_details(refresh=True)
        virtual3_idx = next(m.index for m in monitors if client.get_connector_for_logical(m.index) == "Virtual-3")
        move_to_monitor_and_tile(client, win.id, virtual3_idx, TilePosition.RIGHT)
        wait_for_settle(3.0)

        win = client.get_details(win.id)
        connector = client.get_window_connector(win)
        assert connector == "Virtual-3", f"Expected Virtual-3, got {connector}"
        log(f">>> Window on Virtual-3 - prefs: [Virtual-3, Virtual-2, Virtual-1]")

        # Step 6: B connects, window stays on C (C is top pref)
        log(">>> Step 6: Connect Virtual-2 (B), window should stay on Virtual-3 (C)")
        available = client.get_available_connectors()
        enabled_before = client.get_enabled_connectors()
        log(f">>>   Available connectors: {available}")
        log(f">>>   Currently enabled connectors: {enabled_before}")
        client.set_monitor_enabled("Virtual-2", True)
        enabled_after = client.get_enabled_connectors()
        log(f">>>   After enabling Virtual-2: {enabled_after}")
        wait_for_monitor_count(client, 3)
        wait_for_settle(3.0)

        win = client.get_details(win.id)
        connector = client.get_window_connector(win)
        assert connector == "Virtual-3", (
            f"Window should stay on Virtual-3 (top preference), "
            f"but moved to {connector}"
        )
        log(f">>> Window stayed on Virtual-3 - it's top preference")

        # Step 7: C disconnects, window falls back to B
        log(">>> Step 7: Disconnect Virtual-3 (C), fallback to Virtual-2 (B)")
        client.set_monitor_enabled("Virtual-3", False)
        wait_for_monitor_count(client, 2)
        wait_for_settle(3.0)

        win = client.get_details(win.id)
        connector = client.get_window_connector(win)
        assert connector == "Virtual-2", (
            f"Window should fall back to Virtual-2 (next in prefs), "
            f"but ended on {connector}"
        )
        log(f">>> Window on Virtual-2 (fallback) - prefs unchanged: [Virtual-3, Virtual-2, Virtual-1]")

        # Step 8: B disconnects, window falls back to A
        log(">>> Step 8: Disconnect Virtual-2 (B), fallback to Virtual-1 (A)")
        client.set_monitor_enabled("Virtual-2", False)
        wait_for_monitor_count(client, 1)
        wait_for_settle(3.0)

        win = client.get_details(win.id)
        connector = client.get_window_connector(win)
        assert connector == "Virtual-1", (
            f"Window should fall back to Virtual-1 (last in prefs), "
            f"but ended on {connector}"
        )
        log(f">>> Window on Virtual-1 (fallback) - prefs unchanged: [Virtual-3, Virtual-2, Virtual-1]")

        # Step 9: C connects, window MOVES TO C (top pref now available!)
        log(">>> Step 9: Connect Virtual-3 (C), window should MOVE BACK to it")
        client.set_monitor_enabled("Virtual-3", True)
        wait_for_monitor_count(client, 2)
        wait_for_settle(3.0)

        # Poll to verify window moves to Virtual-3
        moved_back = False
        for i in range(10):
            win = client.get_details(win.id)
            connector = client.get_window_connector(win)
            log(f"    Check {i+1}: connector={connector}")
            if connector == "Virtual-3":
                moved_back = True
                break
            time.sleep(0.5)

        win = client.get_details(win.id)
        final_connector = client.get_window_connector(win)
        dump_window_details(client, win.id, "FINAL STATE")

        assert final_connector == "Virtual-3", (
            f"Window should move back to Virtual-3 (top preference now available), "
            f"but stayed on {final_connector}. "
            "The LIFO preference list should move window to highest-priority available connector."
        )

        log(">>> TEST PASSED: Full 3-monitor LIFO scenario completed successfully")

    finally:
        if pid is not None:
            kill_windowbot(pid)
        # Restore 2-monitor state for other tests
        client.set_monitor_enabled("Virtual-3", False)
        client.set_monitor_enabled("Virtual-2", True)


def test_fallback_does_not_update_preference():
    """
    Test that extension fallback (due to monitor disconnect) does NOT update preference.

    Scenario:
    1. User moves window to monitor 1                       → prefs: [B, A]
    2. Monitor 1 disconnects, window falls back to 0        → prefs: [B, A] (unchanged!)
    3. Monitor 1 reconnects                                 → window moves to 1 (still top pref)

    Key: The fallback to monitor 0 should NOT add monitor 0 to front of prefs.
    """
    log("=== Fallback Does Not Update Preference ===")

    client = WindowControlClient()
    ext_state = ExtensionState()

    # Setup with 2 monitors
    log(">>> Setup with 2 monitors")
    ext_state.clear_all()
    client.set_monitor_enabled("Virtual-2", True)
    wait_for_monitor_count(client, 2)

    ext_state.enable_debug_logging(True)
    ext_state.set_sync_mode("RESTORE")
    ext_state.set_override("com.example.WindowBot", "RESTORE")

    # Launch window
    log(">>> Launch windowbot")
    pid = start_windowbot("single.conf")
    try:
        win = find_windowbot_window(client)
        assert win is not None

        # 1. Tile on Virtual-1, then move to Virtual-2
        log(">>> Step 1: Establish configs on both monitors, end on Virtual-2")
        move_to_monitor_and_tile(client, win.id, 0, TilePosition.RIGHT)
        wait_for_settle(2.0)

        move_to_monitor_and_tile(client, win.id, 1, TilePosition.RIGHT)
        wait_for_settle(2.0)

        win = client.get_details(win.id)
        actual_connector = client.get_window_connector(win)
        assert actual_connector == "Virtual-2", f"Window should be on Virtual-2, got {actual_connector}"
        log(f">>> Window on Virtual-2 - prefs: [Virtual-2, Virtual-1]")

        # 2. Disconnect Virtual-2 - fallback to Virtual-1
        log(">>> Step 2: Disconnect Virtual-2 (fallback to Virtual-1, but prefs unchanged)")
        client.set_monitor_enabled("Virtual-2", False)
        wait_for_monitor_count(client, 1)
        wait_for_settle(3.0)

        win = client.get_details(win.id)
        fallback_connector = client.get_window_connector(win)
        assert fallback_connector == "Virtual-1", f"Window should fall back to Virtual-1, got {fallback_connector}"
        log(f">>> Window on Virtual-1 (fallback) - prefs should STILL be: [Virtual-2, Virtual-1]")

        # 3. Reconnect Virtual-2 - should move back since Virtual-2 is still top pref
        log(">>> Step 3: Reconnect Virtual-2 - window should return to it")
        client.set_monitor_enabled("Virtual-2", True)
        wait_for_monitor_count(client, 2)
        wait_for_settle(3.0)

        win = client.get_details(win.id)
        final_connector = client.get_window_connector(win)
        dump_window_details(client, win.id, "FINAL STATE")

        assert final_connector == "Virtual-2", (
            f"Window should return to Virtual-2 (still top preference), "
            f"but stayed on {final_connector}. "
            "The fallback to Virtual-1 should NOT have updated the preference list."
        )

        log(">>> TEST PASSED: Fallback did not update preference, window returned to preferred connector")

    finally:
        if pid is not None:
            kill_windowbot(pid)


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
