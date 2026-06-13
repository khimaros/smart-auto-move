"""
Story 12: title change shortly after settling must not move the window

Same requirement as story 9 (TRACKING windows must never migrate to a
different slot on title change), but exercised shortly after settling.
Regression test for the removed post-settle migration path, whose
time-based guard only applied after 15s in TRACKING: story 9 times its
title change at 20s after TRACKING (outside that window), this story at
~7s (inside it), where windows used to be migrated and visibly moved.

Config timeline (title_migration_early.conf):
- 0s: create window with long title
- 15s: close window (creates unoccupied slot)
- 16s: create window with short title
- 24s: change short title to exact long title (~7s in TRACKING)
"""

from vmtest import (
    wait_for_settle, place_and_settle, poll_until, terminate_process,
)

TITLE_LONG = "Project Management Dashboard - Q4 Report"
TITLE_SHORT = "Project Manager"


class TestStory12:
    """Story 12: recently settled windows must not move on title change."""

    def test_title_migration_blocked_inside_grace_window(self, wc_client, ext_state, windowbot_process):
        ext_state.set_sync_mode("RESTORE")
        ext_state.set_override("com.example.WindowBot", "RESTORE")

        proc = windowbot_process("title_migration_early.conf", timeout=60)

        # PHASE 1: wait for window with long title and establish saved position
        win_alpha = poll_until(
            lambda: wc_client.find_window_by_title(TITLE_LONG),
            timeout=10.0, poll=0.5
        )
        assert win_alpha is not None, f"{TITLE_LONG} did not appear"

        wait_for_settle(3.0)

        # move window to a distinctive position (100, 100, 500x400)
        saved_pos = place_and_settle(wc_client, win_alpha.id, 100, 100, 500, 400)
        print(f"saved position: ({saved_pos.x}, {saved_pos.y}, {saved_pos.width}x{saved_pos.height})")

        wait_for_settle(2.0)

        saved_windows = ext_state.get_saved_windows()
        assert len(saved_windows) > 0, "no windows saved"

        # PHASE 2: wait for long-title window to close and short-title window
        # to appear (at 15-16s in config)
        win_beta = poll_until(
            lambda: wc_client.find_window_by_title(TITLE_SHORT),
            timeout=20.0, poll=0.5
        )
        assert win_beta is not None, f"{TITLE_SHORT} did not appear"

        initial = wc_client.get_details(win_beta.id)
        print(f"initial position: ({initial.x}, {initial.y}, {initial.width}x{initial.height})")

        # wait for the window to reach TRACKING state
        wait_for_settle(3.0)

        pre_title_change = wc_client.get_details(win_beta.id)
        print(f"pre-title-change position: ({pre_title_change.x}, {pre_title_change.y})")

        # PHASE 3: wait for title change to long title (at 24s in config,
        # only ~7s after the window settled into TRACKING)
        win_after = poll_until(
            lambda: wc_client.find_window_by_title(TITLE_LONG),
            timeout=15.0, poll=0.5
        )
        assert win_after is not None, f"title did not change to {TITLE_LONG}"

        # wait for extension to process title change
        wait_for_settle(3.0)

        # ASSERT: window must NOT have moved to the saved slot position
        final = wc_client.get_details(win_after.id)
        print(f"final position after title change: ({final.x}, {final.y}, {final.width}x{final.height})")

        moved_to_saved = (
            abs(final.x - saved_pos.x) < 20 and
            abs(final.y - saved_pos.y) < 20 and
            abs(final.width - saved_pos.width) < 20 and
            abs(final.height - saved_pos.height) < 20
        )
        assert not moved_to_saved, (
            f"recently settled TRACKING window incorrectly migrated to saved "
            f"slot position ({saved_pos.x}, {saved_pos.y}, "
            f"{saved_pos.width}x{saved_pos.height})"
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
