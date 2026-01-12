"""
Story 2: Sync mode ignore, override calculator restore

- set default sync mode to IGNORE
- open calculator, move, close, reopen (should NOT restore)
- add an app override for calculator (mode RESTORE, 0.7 threshold)
- open calculator, move, close, reopen (should restore)
- open nautilus, move, close, reopen (should NOT restore)
"""

import pytest
import subprocess
from vmtest import (
    PositionAssertion, launch_app, place_and_settle, close_app,
    reset_app_state, wait_for_settle, wait_for_valid_geometry
)


class TestStory2:
    """Story 2: Sync mode and overrides."""

    def test_sync_mode_override(self, wc_client, ext_state):
        # 1. Set default sync mode to IGNORE
        ext_state.set_sync_mode("IGNORE")

        # 2. Open calculator (should NOT restore)
        win, proc = launch_app(wc_client, ["gnome-calculator"], "org.gnome.Calculator")
        details_before = place_and_settle(wc_client, win.id, 50, 50, 800, 600)
        close_app(wc_client, win.id, proc)

        # Reset calculator state to prevent self-restore
        reset_app_state("/org/gnome/calculator/")

        # Reopen - should NOT restore
        win2, proc2 = launch_app(wc_client, ["gnome-calculator"], "org.gnome.Calculator")
        wait_for_settle(3.0)
        details_after = wc_client.get_details(win2.id)

        # Verify NOT restored
        assert details_after.x != details_before.x or details_after.y != details_before.y, \
            f"Window restored (unexpectedly) to {details_after.x},{details_after.y}"

        close_app(wc_client, win2.id, proc2)

        # 3. Add app override for calculator -> RESTORE
        ext_state.set_override("org.gnome.Calculator", "RESTORE", threshold=0.7)
        ext_state.clear_saved_windows()

        # 4. Open calculator, place it, close to establish saved position
        win3, proc3 = launch_app(wc_client, ["gnome-calculator"], "org.gnome.Calculator")
        wait_for_settle(2.0)  # Wait for TRACKING state
        details_before_rest = place_and_settle(wc_client, win3.id, 100, 100, 700, 500)
        close_app(wc_client, win3.id, proc3)

        reset_app_state("/org/gnome/calculator/")

        # 5. Reopen - should restore to saved position
        win4, proc4 = launch_app(wc_client, ["gnome-calculator"], "org.gnome.Calculator")
        wait_for_settle(3.0)
        details_after_rest = wc_client.get_details(win4.id)

        PositionAssertion.assert_details(details_after_rest, details_before_rest)
        close_app(wc_client, win4.id, proc4)

        # 6. Open nautilus (should NOT restore)
        check = subprocess.run(["which", "nautilus"], stdout=subprocess.DEVNULL)
        if check.returncode != 0:
            print("Nautilus not found, skipping")
            return

        nautilus_proc = None
        nautilus_proc2 = None
        n_win = None
        n_win2 = None

        try:
            n_win, nautilus_proc = launch_app(wc_client, ["nautilus"], "org.gnome.Nautilus", timeout=10.0)
            details_n_before = place_and_settle(wc_client, n_win.id, 150, 150, 600, 400, settle_time=1.0)

            wc_client.close(n_win.id, force=True)
            n_win = None
            nautilus_proc.terminate()
            nautilus_proc = None
            wait_for_settle(1.0)

            # Reopen
            n_win2, nautilus_proc2 = launch_app(wc_client, ["nautilus"], "org.gnome.Nautilus", timeout=10.0)
            wait_for_settle(2.0)
            details_n_after = wc_client.get_details(n_win2.id)

            # Should NOT be restored (IGNORE is default, no override)
            assert details_n_after.x != details_n_before.x or details_n_after.y != details_n_before.y, \
                f"Nautilus restored (unexpectedly) to {details_n_after.x},{details_n_after.y}"

        finally:
            # Clean up
            if n_win2:
                try:
                    wc_client.close(n_win2.id, force=True)
                except Exception:
                    pass
            if n_win:
                try:
                    wc_client.close(n_win.id, force=True)
                except Exception:
                    pass
            if nautilus_proc2:
                nautilus_proc2.terminate()
            if nautilus_proc:
                nautilus_proc.terminate()
            wait_for_settle(0.5)
