"""
Story 11: Transient dialog should not be tracked by the extension

Simulates a Firefox-like scenario where a transient dialog (e.g. "Opening rss")
was previously tracked on the default workspace. When the same dialog title
later appears transient to a parent that has been moved to a different workspace,
it matches the freed slot and gets restored to the original workspace, dragging
the parent along.

Two separate windowbot processes (via NON_UNIQUE flag) are used so phase 2
windows are independent of phase 1.

Phase 1 (transient_dialog_phase1.conf):
- Create Alpha, open dialog transient to it, close dialog (slot freed on ws 2)

Phase 2 (transient_dialog_phase2.conf):
- Create Beta (appears on ws 2), test moves it to ws 1, dialog opens on ws 1
- Extension restores dialog to ws 2, dragging Beta from ws 1 to ws 2

Titles are >= 15 chars to pass specificity threshold.
"""

import time
import json
from vmtest import (
    wait_for_settle, place_and_settle, poll_until,
    _gdbus_call, _parse_gdbus_string,
)

TITLE_ALPHA = "Alpha Document Editor Session"
TITLE_BETA = "ZXQKJW 9087654321 PLMVBN"
TITLE_DIALOG = "Opening Document Editor Session"

POS_ALPHA = (100, 100, 500, 400)
POS_BETA = (300, 300, 500, 400)

WS_DEFAULT = 1  # workspace where windows initially appear
WS_BETA_TARGET = 0  # workspace to move Beta to (different from default)


def terminate_process(proc, timeout=5):
    """Safely terminate a process."""
    proc.terminate()
    try:
        proc.wait(timeout=timeout)
    except Exception:
        proc.kill()
    time.sleep(1.0)


def get_window_details(window_id):
    """Get full window details from window-control extension."""
    raw = _gdbus_call("GetDetails", window_id)
    return json.loads(_parse_gdbus_string(raw))


class TestStory11:
    """Story 11: Transient dialog should not be tracked."""

    def test_transient_dialog_not_tracked(self, wc_client, ext_state, windowbot_process):
        ext_state.set_sync_mode("RESTORE")
        ext_state.set_override("com.example.WindowBot", "RESTORE")

        # PHASE 1: create dialog slot on default workspace
        proc1 = windowbot_process("transient_dialog_phase1.conf", timeout=40)

        win_alpha = poll_until(
            lambda: wc_client.find_window_by_title(TITLE_ALPHA),
            timeout=10.0, poll=0.5
        )
        assert win_alpha is not None, f"{TITLE_ALPHA} did not appear"

        # place alpha on default workspace
        wait_for_settle(2.0)
        place_and_settle(wc_client, win_alpha.id, *POS_ALPHA)
        print(f"Default workspace: {WS_DEFAULT}, Beta target: {WS_BETA_TARGET}")

        # wait for dialog to appear (at 3s)
        win_dialog1 = poll_until(
            lambda: wc_client.find_window_by_title(TITLE_DIALOG),
            timeout=10.0, poll=0.5
        )
        assert win_dialog1 is not None, "Phase 1 dialog did not appear"

        d1 = get_window_details(win_dialog1.id)
        print(f"Dialog 1: ws={d1.get('workspace')} type={d1.get('window_type')}")

        # let dialog settle and get tracked
        wait_for_settle(5.0)

        dialog1_tracked = any(
            TITLE_DIALOG in str(entry) for entry in ext_state.get_saved_windows()
        )
        print(f"Dialog 1 tracked: {dialog1_tracked}")

        # wait for dialog to close (at 18s)
        poll_until(
            lambda: wc_client.find_window_by_title(TITLE_DIALOG) is None,
            timeout=25.0, poll=0.5
        )
        print(f"Dialog 1 closed, slot freed on workspace {WS_DEFAULT}")

        # PHASE 2: separate windowbot process (NON_UNIQUE flag allows this)
        proc2 = windowbot_process("transient_dialog_phase2.conf", timeout=60)

        win_beta = poll_until(
            lambda: wc_client.find_window_by_title(TITLE_BETA),
            timeout=10.0, poll=0.5
        )
        assert win_beta is not None, f"{TITLE_BETA} did not appear"

        # let beta settle on default workspace first
        wait_for_settle(2.0)
        place_and_settle(wc_client, win_beta.id, *POS_BETA)
        wait_for_settle(3.0)

        # move beta to workspace 1 (different from dialog slot's default workspace)
        wc_client.move_to_workspace(win_beta.id, WS_BETA_TARGET)
        wait_for_settle(5.0)

        beta_before = wc_client.get_details(win_beta.id)
        print(f"Beta before dialog: ws={beta_before.workspace} pos=({beta_before.x}, {beta_before.y})")
        assert beta_before.workspace == WS_BETA_TARGET, (
            f"Failed to move Beta to workspace {WS_BETA_TARGET}, got {beta_before.workspace}"
        )

        # wait for dialog to appear (at 20s in phase2 config)
        win_dialog3 = poll_until(
            lambda: wc_client.find_window_by_title(TITLE_DIALOG),
            timeout=20.0, poll=0.5
        )
        assert win_dialog3 is not None, "Phase 2 dialog did not appear"

        d3 = get_window_details(win_dialog3.id)
        print(f"Dialog 3 initial: ws={d3.get('workspace')}")

        # wait for extension to process and restore
        wait_for_settle(5.0)

        d3_after = get_window_details(win_dialog3.id)
        beta_after = wc_client.get_details(win_beta.id)
        print(f"Dialog 3 after: ws={d3_after.get('workspace')}")
        print(f"Beta after: ws={beta_after.workspace} pos=({beta_after.x}, {beta_after.y})")

        # ASSERT: parent (Beta) should stay on workspace 1
        # Before the fix: dialog matches freed slot on default workspace,
        # gets restored there, dragging Beta from workspace 1 to default.
        assert beta_after.workspace == WS_BETA_TARGET, (
            f"Parent window was dragged from workspace {WS_BETA_TARGET} "
            f"to workspace {beta_after.workspace}. "
            f"Transient dialog matched a stale slot and dragged the parent."
        )

        terminate_process(proc1)
        terminate_process(proc2)
