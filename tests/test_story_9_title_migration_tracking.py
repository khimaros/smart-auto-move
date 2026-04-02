"""
Story 9: TRACKING window must not migrate to different slot on title change

Windows in TRACKING state should never be migrated to a different slot,
even when the title changes to exactly match an unoccupied slot. Title
migration is only valid during the initial matching phase (PENDING or
recently-matched windows).

This test differs from story 4 in that it uses IDENTICAL titles (exact match,
score 1.0) to specifically trigger the title migration code path. Story 4
avoids triggering migration by using different character distributions.

Config timeline (title_migration_tracking.conf):
- 0s: Create window with long title
- 15s: Close window (creates unoccupied slot)
- 16s: Create window with short title
- 26s: Change short title to exact long title
"""

import time
from vmtest import (
    wait_for_settle, place_and_settle, poll_until,
)

TITLE_LONG = "Project Management Dashboard - Q4 Report"
TITLE_SHORT = "Project Manager"


def terminate_process(proc, timeout=5):
    """Safely terminate a process."""
    proc.terminate()
    try:
        proc.wait(timeout=timeout)
    except Exception:
        proc.kill()
    time.sleep(1.0)


class TestStory9:
    """Story 9: TRACKING windows must not migrate on title change."""

    def test_title_migration_blocked_for_tracking(self, wc_client, ext_state, windowbot_process):
        ext_state.set_sync_mode("RESTORE")
        ext_state.set_override("com.example.WindowBot", "RESTORE")

        proc = windowbot_process("title_migration_tracking.conf", timeout=60)

        # PHASE 1: wait for window with long title and establish saved position
        win_alpha = poll_until(
            lambda: wc_client.find_window_by_title(TITLE_LONG),
            timeout=10.0, poll=0.5
        )
        assert win_alpha is not None, f"{TITLE_LONG} did not appear"

        wait_for_settle(3.0)

        # move window to a distinctive position (100, 100, 500x400)
        saved_pos = place_and_settle(wc_client, win_alpha.id, 100, 100, 500, 400)
        print(f"saved Alpha position: ({saved_pos.x}, {saved_pos.y}, {saved_pos.width}x{saved_pos.height})")

        wait_for_settle(2.0)

        # verify position was saved
        saved_windows = ext_state.get_saved_windows()
        assert len(saved_windows) > 0, "no windows saved"

        # PHASE 2: wait for Alpha to close and Beta to appear (at 15-16s in config)
        win_beta = poll_until(
            lambda: wc_client.find_window_by_title(TITLE_SHORT),
            timeout=20.0, poll=0.5
        )
        assert win_beta is not None, f"{TITLE_SHORT} did not appear"

        # record Beta's initial position (where GNOME placed it)
        initial = wc_client.get_details(win_beta.id)
        print(f"Beta initial position: ({initial.x}, {initial.y}, {initial.width}x{initial.height})")

        # wait for Beta to reach TRACKING state
        wait_for_settle(3.0)

        # record Beta's position after settling (may differ from initial due to matching)
        pre_title_change = wc_client.get_details(win_beta.id)
        print(f"Beta pre-title-change position: ({pre_title_change.x}, {pre_title_change.y})")

        # PHASE 3: wait for title change to long title (at 36s in config)
        win_after = poll_until(
            lambda: wc_client.find_window_by_title(TITLE_LONG),
            timeout=25.0, poll=0.5
        )
        assert win_after is not None, f"title did not change to {TITLE_LONG}"

        # wait for extension to process title change
        wait_for_settle(3.0)

        # ASSERT: window should NOT have moved to saved Alpha position
        final = wc_client.get_details(win_after.id)
        print(f"final position after title change: ({final.x}, {final.y}, {final.width}x{final.height})")

        moved_to_saved = (
            abs(final.x - saved_pos.x) < 20 and
            abs(final.y - saved_pos.y) < 20 and
            abs(final.width - saved_pos.width) < 20 and
            abs(final.height - saved_pos.height) < 20
        )
        assert not moved_to_saved, (
            f"TRACKING window incorrectly migrated to saved slot position "
            f"({saved_pos.x}, {saved_pos.y}, {saved_pos.width}x{saved_pos.height})"
        )

        # verify window stayed near its pre-title-change position
        stayed_in_place = (
            abs(final.x - pre_title_change.x) < 20 and
            abs(final.y - pre_title_change.y) < 20
        )
        assert stayed_in_place, (
            f"window moved from ({pre_title_change.x}, {pre_title_change.y}) "
            f"to ({final.x}, {final.y}) on title change"
        )

        terminate_process(proc)
