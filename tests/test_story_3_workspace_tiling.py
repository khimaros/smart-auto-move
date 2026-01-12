"""
Story 3: Workspace and tiling

- launch the "fasttitle" windowbot config
- wait for the window titles to settle
- move the windows to the workspace and tile as described by their titles
- quit and restart the windowbot session with "fasttitle" (should restore)
- quit and restart the windowbot session with "slowtitle" (should restore, with long delays)
"""

import pytest
import time
from vmtest import (
    PositionAssertion, TilePosition, wait_for_settle, wait_for_details, tile_window,
    terminate_process, get_primary_monitor_index,
)


def parse_window_title(title):
    """Parse window title to get workspace and tile position.

    Returns:
        Tuple of (workspace_index, TilePosition) or (None, None) if title doesn't match.
    """
    workspace = None
    if "Workspace One" in title:
        workspace = 0
    elif "Workspace Two" in title:
        workspace = 1
    elif "Workspace Three" in title:
        workspace = 2

    position = None
    if "Right Side" in title:
        position = TilePosition.RIGHT
    elif "Left Side" in title:
        position = TilePosition.LEFT

    return workspace, position


class TestStory3:
    """Story 3: Workspace and tiling restoration with title delays."""

    def test_workspace_tiling(self, wc_client, ext_state, windowbot_process):
        # Setup
        ext_state.set_sync_mode("RESTORE")
        ext_state.set_override("com.example.WindowBot", "RESTORE")

        # 1. Launch "fasttitle"
        proc = windowbot_process("fasttitle.conf", timeout=30)

        # 2. Wait for titles to settle
        time.sleep(10)

        # 3. Move to workspace and tile based on title
        windows = wc_client.list_windows()
        wb_windows = [w for w in windows
                      if 'Window Bot' in wc_client.get_details(w['id']).title]

        assert len(wb_windows) >= 5, "Not enough windows found for fasttitle"

        saved_positions = {}

        # Get the primary monitor dynamically (may not be index 0)
        primary_monitor = get_primary_monitor_index()

        for win in wb_windows:
            wid = win['id']
            d = wc_client.get_details(wid)
            title = d.title

            workspace, position = parse_window_title(title)
            if workspace is None or position is None:
                continue

            # Apply layout - move to primary monitor first, then workspace, then tile
            wc_client.move_to_monitor(wid, primary_monitor)
            wait_for_settle(0.3)
            wc_client.move_to_workspace(wid, workspace)
            wait_for_settle(0.3)
            tile_window(wc_client, wid, position, monitor=primary_monitor)

            wait_for_settle(1.0)
            d = wc_client.get_details(wid)

            # Verify tiling actually worked before saving
            try:
                PositionAssertion.assert_tiled(d, position, monitor=primary_monitor)
            except AssertionError as e:
                print(f"WARNING: Tiling failed for {title}: {e}")
                continue  # Skip windows that didn't tile correctly

            saved_positions[title] = d

        wait_for_settle(2.0)

        assert len(saved_positions) == 5, f"Tiling failed: only {len(saved_positions)} windows tiled successfully"

        # 4. Quit and restart "fasttitle"
        # fasttitle.conf: all titles set within 250ms
        terminate_process(proc)

        proc2 = windowbot_process("fasttitle.conf", timeout=30)

        # Verify restore - wait for each saved title to appear and reach expected position
        for title, expected in saved_positions.items():
            win = wc_client.wait_for_window(title=title, timeout=10.0)
            assert win is not None, f"Window with title '{title}' not found"
            d = wait_for_details(wc_client, win.id, expected, timeout=10.0)
            PositionAssertion.assert_details(d, expected)

        terminate_process(proc2)

        # 5. Quit and restart "slowtitle"
        # slowtitle.conf: titles change at 500ms, 2s, 3s, 7s, 9s
        proc3 = windowbot_process("slowtitle.conf", timeout=45)

        # Verify restore - wait for each saved title to appear and reach expected position
        # Total timeout accounts for: last title at 9s + restore time + drift correction
        for title, expected in saved_positions.items():
            win = wc_client.wait_for_window(title=title, timeout=15.0)
            assert win is not None, f"Window with title '{title}' not found"
            # Longer timeout for slowtitle - titles appear late, extension needs time to restore
            d = wait_for_details(wc_client, win.id, expected, timeout=15.0)
            PositionAssertion.assert_details(d, expected)

        terminate_process(proc3)
