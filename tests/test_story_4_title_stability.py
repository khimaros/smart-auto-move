"""
Story 4: Title change should not trigger restore for TRACKING window

Windows should never be moved after entering TRACKING state except when
a new monitor is added.

Test uses titles >= 15 chars to pass specificity threshold (MIN_SPECIFIC_TITLE_LENGTH).
Titles are intentionally different (character distribution) to avoid similarity matching.

Config timeline (title_change.conf):
- 0s: Create window with Alpha title
- 15s: Close Alpha window
- 16s: Create window with Beta title
- 26s: Change Beta title to Alpha
"""

import time
from vmtest import (
    wait_for_settle, place_and_settle, poll_until,
)

TITLE_ALPHA = "AAAA Document Editor Alpha"
TITLE_BETA = "ZZZZ Image Viewer Beta"


def terminate_process(proc, timeout=5):
    """Safely terminate a process."""
    proc.terminate()
    try:
        proc.wait(timeout=timeout)
    except Exception:
        proc.kill()
    time.sleep(1.0)


class TestStory4:
    """Story 4: Title stability - title change should not trigger restore."""

    def test_title_change_no_restore(self, wc_client, ext_state, windowbot_process):
        # Setup
        ext_state.set_sync_mode("RESTORE")
        ext_state.set_override("com.example.WindowBot", "RESTORE")

        # Launch windowbot - config handles full flow with timings
        # 0s: Alpha window created
        # 15s: Alpha closed
        # 16s: Beta created
        # 26s: Beta title changes to Alpha
        proc = windowbot_process("title_change.conf", timeout=60)

        # PHASE 1: Wait for Alpha window and establish saved position
        win_alpha = poll_until(
            lambda: wc_client.find_window_by_title(TITLE_ALPHA),
            timeout=10.0, poll=0.5
        )
        assert win_alpha is not None, f"{TITLE_ALPHA} did not appear"

        # Wait for TRACKING state
        wait_for_settle(3.0)

        # Move window to specific position (100, 100, 500x400)
        saved_pos = place_and_settle(wc_client, win_alpha.id, 100, 100, 500, 400)
        print(f"Saved Alpha position: ({saved_pos.x}, {saved_pos.y})")

        # Wait for position to be saved
        wait_for_settle(2.0)

        # Verify position was saved
        saved_windows = ext_state.get_saved_windows()
        assert len(saved_windows) > 0, "No windows saved"

        # PHASE 2: Wait for Alpha to close and Beta to appear (at 15-16s in config)
        # Config closes Alpha at 15s and creates Beta at 16s
        win_beta = poll_until(
            lambda: wc_client.find_window_by_title(TITLE_BETA),
            timeout=20.0, poll=0.5
        )
        assert win_beta is not None, f"{TITLE_BETA} did not appear"

        # Record Beta's initial position (where GNOME placed it)
        initial = wc_client.get_details(win_beta.id)
        print(f"Beta initial position: ({initial.x}, {initial.y})")

        # Wait for Beta to reach TRACKING state
        # Windows typically reach TRACKING within ~1s of appearing
        # (like story 3, we use time-based wait rather than checking saved-windows
        # because saved-windows title gets updated when title changes)
        wait_for_settle(3.0)

        # PHASE 3: Wait for title change to Alpha (at 26s in config)
        # Find the window that now has Alpha title (same window, different title)
        win_after = poll_until(
            lambda: wc_client.find_window_by_title(TITLE_ALPHA),
            timeout=15.0, poll=0.5
        )
        assert win_after is not None, f"Title did not change to {TITLE_ALPHA}"

        # Wait for extension to process title change
        wait_for_settle(3.0)

        # ASSERT: Window should NOT have moved to saved Alpha position
        final = wc_client.get_details(win_after.id)
        print(f"Final position after title change: ({final.x}, {final.y})")

        # Position should NOT match saved_pos (allow 20px tolerance)
        moved_to_saved = (
            abs(final.x - saved_pos.x) < 20 and
            abs(final.y - saved_pos.y) < 20 and
            abs(final.width - saved_pos.width) < 20 and
            abs(final.height - saved_pos.height) < 20
        )
        assert not moved_to_saved, (
            f"Window incorrectly moved to saved position "
            f"({saved_pos.x}, {saved_pos.y}, {saved_pos.width}x{saved_pos.height})"
        )

        terminate_process(proc)
