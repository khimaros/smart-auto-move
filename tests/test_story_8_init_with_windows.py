"""
Story 8: Extension initialization with existing windows

Regression test for the bug where enabling the extension with existing windows
caused a crash because WindowStateMatcher's onProcessingCallback fired during
construction, before OperationHandler._tracker was assigned.

The fix ensures initial actor processing is deferred until after all references
are set up in StateSession.
"""

import pytest
import time
from vmtest import (
    WindowControlClient, ExtensionState, launch_app, close_app,
    wait_for_settle, poll_until
)


class TestStory8:
    """Story 8: Extension initialization with existing windows."""

    @pytest.fixture(autouse=True)
    def skip_clean_state(self, request):
        """Override autouse clean_state fixture for this test module."""
        # We need to control extension enable/disable ourselves
        pass

    def test_enable_with_existing_windows_and_saved_state(self, wc_client, ext_state):
        """Test that extension can be enabled when windows exist AND there's saved state.

        This is a regression test for the bug where WindowStateMatcher's
        constructor synchronously called onProcessingCallback before
        OperationHandler._tracker was assigned, causing:

        TypeError: can't access property "onOperationsComplete", this._tracker is undefined

        The bug triggers when:
        1. Extension enables with existing windows
        2. There's saved state that matches those windows
        3. Window position DIFFERS from saved state (so operations are generated)
        """
        # 1. Start with extension enabled and clean state
        ext_state.disable_extension()
        ext_state.reset_settings()
        ext_state.enable_extension()
        ext_state.enable_debug_logging(True)

        # 2. Open a calculator window and move it so extension saves state
        win, proc = launch_app(wc_client, ["gnome-calculator"], "org.gnome.Calculator")
        wait_for_settle(1.0)

        try:
            # 3. Move the window to create saved state at position A
            initial_details = wc_client.get_details(win.id)
            saved_x = initial_details.x + 100
            saved_y = initial_details.y + 100
            wc_client.move(win.id, saved_x, saved_y)
            wait_for_settle(2.0)

            # Wait for state to be saved (poll until dconf has data)
            def check_saved():
                return ext_state.get_saved_windows()
            saved = poll_until(check_saved, timeout=5.0, poll=0.5)
            assert saved, "Extension should have saved window state"

            # 4. Disable extension but KEEP the saved state
            ext_state.disable_extension()
            wait_for_settle(0.5)

            # 5. Move window to position B while extension is disabled
            # This creates the drift that will trigger restore operations on enable
            drifted_x, drifted_y = saved_x + 200, saved_y + 200
            wc_client.move(win.id, drifted_x, drifted_y)
            wait_for_settle(1.0)

            # Verify the move actually happened
            moved_details = wc_client.get_details(win.id)
            assert moved_details.x == drifted_x, f"Window should have moved to x={drifted_x}, got {moved_details.x}"
            assert moved_details.y == drifted_y, f"Window should have moved to y={drifted_y}, got {moved_details.y}"

            # 6. Re-enable extension - this is where the bug would crash
            # The extension sees window at B, saved state says A,
            # generates operations to restore to A during construction
            ext_state.enable_extension()
            wait_for_settle(1.0)

            # 7. Verify extension is still working by moving the window
            # If the extension crashed during init, this would fail
            details = wc_client.get_details(win.id)
            wc_client.move(win.id, details.x + 25, details.y + 25)
            wait_for_settle(1.0)

        finally:
            close_app(wc_client, win.id, proc)

    def test_enable_with_drifted_window_position(self, wc_client, ext_state):
        """Test enabling extension when window position differs from saved state.

        This specifically tests the scenario where restore operations are generated
        during initialization because the window has moved from its saved position.
        """
        # 1. Start with extension enabled and clean state
        ext_state.disable_extension()
        ext_state.reset_settings()
        ext_state.enable_extension()
        ext_state.enable_debug_logging(True)

        # 2. Open a window
        win, proc = launch_app(wc_client, ["gnome-calculator"], "org.gnome.Calculator")
        wait_for_settle(1.0)

        try:
            # 3. Move window to create saved state at position A
            initial = wc_client.get_details(win.id)
            saved_x, saved_y = initial.x + 50, initial.y + 50
            wc_client.move(win.id, saved_x, saved_y)
            wait_for_settle(2.0)

            # Wait for state to be saved (poll until dconf has data)
            def check_saved():
                return ext_state.get_saved_windows()
            saved = poll_until(check_saved, timeout=5.0, poll=0.5)
            assert saved, "Extension should have saved window state"

            # 4. Disable extension
            ext_state.disable_extension()
            wait_for_settle(0.5)

            # 5. Move window to different position while disabled
            drifted_x, drifted_y = saved_x + 150, saved_y + 150
            wc_client.move(win.id, drifted_x, drifted_y)
            wait_for_settle(1.0)

            # Verify the move actually happened
            moved_details = wc_client.get_details(win.id)
            assert moved_details.x == drifted_x, f"Window should have moved to x={drifted_x}, got {moved_details.x}"
            assert moved_details.y == drifted_y, f"Window should have moved to y={drifted_y}, got {moved_details.y}"

            # 6. Re-enable - this triggers restore operations during init
            ext_state.enable_extension()
            wait_for_settle(1.0)

            # 7. Verify extension is working by moving the window
            # If the extension crashed during init, this would fail
            details = wc_client.get_details(win.id)
            wc_client.move(win.id, details.x + 25, details.y + 25)
            wait_for_settle(1.0)

        finally:
            close_app(wc_client, win.id, proc)
