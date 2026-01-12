"""
Story 1: Default settings, calculator restore

- open calculator, move, resize, close, reopen (should restore)
"""

import pytest
from vmtest import (
    PositionAssertion, launch_app, place_and_settle, close_app,
    wait_for_settle
)


class TestStory1:
    """Story 1: Default settings, calculator restore."""

    def test_calculator_restore(self, wc_client, ext_state):
        """Test basic restore with default settings (using gnome-calculator)."""
        ext_state.set_sync_mode("RESTORE")

        # 1. Open calculator, place it (relative to current monitor)
        win, proc = launch_app(wc_client, ["gnome-calculator"], "org.gnome.Calculator")
        details = place_and_settle(wc_client, win.id, 50, 50, 800, 600)

        # 2. Close
        close_app(wc_client, win.id, proc)

        # 3. Reopen
        win2, proc2 = launch_app(wc_client, ["gnome-calculator"], "org.gnome.Calculator")
        wait_for_settle(3.0)

        # 4. Verify restore
        details2 = wc_client.get_details(win2.id)
        PositionAssertion.assert_details(details2, details)

        close_app(wc_client, win2.id, proc2)
