"""
Integration Test: Secondary monitor hotplug scenarios

Full test sequence:
1. launch the "single" windowbot config
2. tile the window to the right on the primary monitor
3. enable the secondary monitor
4. move the window to the secondary monitor and tile to the left
5. disable the secondary monitor (should move to primary and tile right)
6. enable the secondary monitor (should move to secondary and tile left)
7. quit and restart the windowbot session with "single" (should restore to secondary, tile left)
8. quit the windowbot session
9. disable the secondary monitor
10. start the windowbot session with "single" (should restore to primary, tile right)
"""

import time
import datetime
import pytest
from vmtest import (
    WindowControlClient, ExtensionState, PositionAssertion, TilePosition,
    wait_for_settle, move_to_monitor_and_tile,
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

def test_monitors_hotplug():
    log("=== Monitor Hotplug Integration Test ===")
    
    client = WindowControlClient()
    ext_state = ExtensionState()

    # Ensure clean state
    log(">>> Cleanup & Setup")
    ext_state.clear_all()
    # Disable all secondary monitors to start with single monitor
    client.set_monitor_enabled("Virtual-2", False)
    client.set_monitor_enabled("Virtual-3", False)
    wait_for_monitor_count(client, 1)
    
    ext_state.enable_debug_logging(True)
    ext_state.set_sync_mode("RESTORE")
    ext_state.set_override("com.example.WindowBot", "RESTORE")

    # Determine Primary (should be 0 or 1, likely 0 if only 1 exists)
    primary = client.get_primary_monitor_index()
    log(f">>> Primary Monitor Index: {primary}")

    # 1. Launch windowbot
    log(">>> Launching windowbot")
    pid = start_windowbot("single.conf")
    try:
        win = find_windowbot_window(client)
        assert win is not None
        
        # 2. Tile right on primary
        log(f">>> Tiling on Primary ({primary})")
        move_to_monitor_and_tile(client, win.id, primary, TilePosition.RIGHT)
        
        win = client.get_details(win.id)
        PositionAssertion.assert_tiled(win, TilePosition.RIGHT, monitor=primary)
        
        # 3. Enable secondary monitor (Virtual-2)
        log(">>> Enabling Secondary Monitor (Virtual-2)")
        client.set_monitor_enabled("Virtual-2", True)
        wait_for_monitor_count(client, 2)
        
        # Re-evaluate primary/secondary indices after enable
        primary = client.get_primary_monitor_index()
        # Assume other is secondary
        monitors = get_all_monitor_details(refresh=True)
        secondary = [m.index for m in monitors if m.index != primary][0]
        log(f">>> Updated Indices - Primary: {primary}, Secondary: {secondary}")
        
        # Verify it didn't jump (check for 5 seconds stability)
        log(">>> Verifying Stability (Window should stay on Primary)")
        end_time = time.time() + 5.0
        while time.time() < end_time:
            win = client.get_details(win.id)
            log(f"    Window state: monitor={win.monitor} x={win.x} y={win.y} w={win.width} h={win.height}")
            try:
                # Expect on Primary
                PositionAssertion.assert_tiled(win, TilePosition.RIGHT, monitor=primary)
            except AssertionError:
                dump_window_details(client, win.id, "FAILURE STATE")
                raise
            time.sleep(0.5)
            
        # 4. Move to secondary and tile left
        log(f">>> Moving to Secondary ({secondary})")
        move_to_monitor_and_tile(client, win.id, secondary, TilePosition.LEFT)
        win = client.get_details(win.id)
        PositionAssertion.assert_tiled(win, TilePosition.LEFT, monitor=secondary)
        
        # 5. Disable secondary monitor (Virtual-2)
        log(">>> Disabling Secondary Monitor (Virtual-2)")
        client.set_monitor_enabled("Virtual-2", False)
        wait_for_monitor_count(client, 1)
        wait_for_settle(2.0)
        
        # Re-eval Primary
        primary = client.get_primary_monitor_index()
        
        # Should move to Primary, Tile Right
        win = client.get_details(win.id)
        PositionAssertion.assert_tiled(win, TilePosition.RIGHT, monitor=primary)
        
        # 6. Enable secondary monitor (Virtual-2)
        log(">>> Enabling Secondary Monitor (Virtual-2) (Restore Check)")
        client.set_monitor_enabled("Virtual-2", True)
        wait_for_monitor_count(client, 2)
        wait_for_settle(2.0)
        
        # Re-eval
        primary = client.get_primary_monitor_index()
        monitors = get_all_monitor_details(refresh=True)
        secondary_now = [m.index for m in monitors if m.index != primary][0]
        # Should match previous secondary index unless swapped?
        
        # Should move back to Secondary, Tile Left
        win = client.get_details(win.id)
        PositionAssertion.assert_tiled(win, TilePosition.LEFT, monitor=secondary_now)
        
        # 7. Restart windowbot
        log(">>> Restarting WindowBot")
        kill_windowbot(pid)
        wait_for_settle(1.0)
        
        pid = start_windowbot("single.conf")
        win = find_windowbot_window(client)
        assert win is not None
        
        # Should restore to Secondary, Tile Left
        wait_for_settle(2.0)
        win = client.get_details(win.id)
        PositionAssertion.assert_tiled(win, TilePosition.LEFT, monitor=secondary_now)
        
        # 8/9. Quit and Disable
        log(">>> Cleanup for final check")
        kill_windowbot(pid)
        client.set_monitor_enabled("Virtual-2", False)
        wait_for_monitor_count(client, 1)
        
        # 10. Start without secondary
        log(">>> Start without Secondary")
        pid = start_windowbot("single.conf")
        win = find_windowbot_window(client)
        assert win is not None
        
        # Should restore to Primary, Tile Right
        primary = client.get_primary_monitor_index()
        wait_for_settle(2.0)
        win = client.get_details(win.id)
        PositionAssertion.assert_tiled(win, TilePosition.RIGHT, monitor=primary)
        
    finally:
        if 'pid' in locals():
            kill_windowbot(pid)
