"""
Story 13: settled window must not migrate workspace after a saved-windows reapply

Reproduces the spontaneous-move bug observed in the field: a Firefox window that
had been settled for hours suddenly jumped to another window's workspace.

Root cause: restoreFromState() (fired by the extension's saved-windows GSettings
"changed" handler, and on re-init) resets every slot's `occupied` to null WITHOUT
re-matching, while the per-window state machine entries stay TRACKING. The next
title change on a settled window is then handled as "new window detected",
re-matched against the saved pool, and -- for visually identical maximized
windows distinguished only by volatile titles -- lands on a DIFFERENT slot,
issuing a cross-workspace move.

The existing story 9 guard (a TRACKING window does not migrate on title change)
only protects windows that still occupy a slot. This test adds the missing
ingredient: an external saved-windows write that wipes occupancy first, so the
title change escapes the guard entirely.

This is the settled-windows invariant: a window the extension already considers
settled must never change workspace solely because its title changed.

Config timeline (settled_occupancy_wipe.conf):
- 0s:  create alpha (Zephyr Quarterly Budget Spreadsheet)
- 2s:  create bravo (Kubernetes Pod Networking Dashboard)
- 30s: close bravo (leaves an unoccupied bravo slot saved on workspace 2)
- 60s: change alpha's title to exactly bravo's title
"""

import json
import time

from vmtest import (
    wait_for_settle, poll_until, _dconf_read, _dconf_write,
)

TITLE_ALPHA = "Zephyr Quarterly Budget Spreadsheet"
TITLE_BRAVO = "Kubernetes Pod Networking Dashboard"

ALPHA_WORKSPACE = 1
BRAVO_WORKSPACE = 2


def _reapply_saved_windows_externally():
    """Simulate an external write to the saved-windows GSettings key.

    This is what the prefs dialog / external clients do; it fires the
    extension's "changed::saved-windows" handler, which calls
    restoreFromState() and (with preserveOccupied=false) wipes slot occupancy.
    We re-serialize the current state and bump every slot's `seen` so the value
    is guaranteed to differ (dconf only emits "changed" on an actual change).
    """
    raw = _dconf_read("saved-windows").strip()
    assert raw and raw != "''", "expected saved-windows to be populated before reapply"
    state = json.loads(raw.strip("'"))

    if isinstance(state, list):
        for slot in state:
            slot["seen"] = (slot.get("seen") or 0) + 1
    elif isinstance(state, dict):
        for slots in state.values():
            for slot in slots:
                slot["seen"] = (slot.get("seen") or 0) + 1

    _dconf_write("saved-windows", "'" + json.dumps(state) + "'")


class TestStory13:
    """Story 13: settled windows must not move workspace after occupancy wipe."""

    def test_settled_window_not_moved_after_saved_windows_reapply(
        self, wc_client, ext_state, windowbot_process
    ):
        ext_state.set_sync_mode("RESTORE")
        ext_state.set_override("com.example.WindowBot", "RESTORE", threshold=0.7)
        ext_state.enable_debug_logging(True)

        windowbot_process("settled_occupancy_wipe.conf", timeout=90)

        # PHASE 1: alpha appears; move it to its workspace and let it settle.
        alpha = poll_until(
            lambda: wc_client.find_window_by_title(TITLE_ALPHA),
            timeout=10.0, poll=0.5,
        )
        assert alpha is not None, f"{TITLE_ALPHA} did not appear"
        wc_client.move_to_workspace(alpha.id, ALPHA_WORKSPACE)
        wait_for_settle(3.0)

        # PHASE 2: bravo appears; move it to a DIFFERENT workspace and settle.
        bravo = poll_until(
            lambda: wc_client.find_window_by_title(TITLE_BRAVO),
            timeout=15.0, poll=0.5,
        )
        assert bravo is not None, f"{TITLE_BRAVO} did not appear"
        wc_client.move_to_workspace(bravo.id, BRAVO_WORKSPACE)
        wait_for_settle(3.0)

        # both should now be saved as TRACKING on their respective workspaces
        saved = poll_until(lambda: ext_state.get_saved_windows(), timeout=5.0, poll=0.5)
        assert saved, "extension did not save window state"

        alpha_before = wc_client.get_details(alpha.id)
        print(f"alpha settled on workspace {alpha_before.workspace}")
        assert alpha_before.workspace == ALPHA_WORKSPACE, (
            f"precondition failed: alpha expected on workspace {ALPHA_WORKSPACE}, "
            f"got {alpha_before.workspace}"
        )

        # PHASE 3: bravo closes (config @30s), leaving an unoccupied bravo slot.
        gone = poll_until(
            lambda: wc_client.find_window_by_title(TITLE_BRAVO) is None,
            timeout=35.0, poll=0.5,
        )
        assert gone, "bravo did not close"

        # PHASE 4: external saved-windows reapply -> wipes slot occupancy.
        _reapply_saved_windows_externally()
        wait_for_settle(1.0)

        # PHASE 5: alpha's title changes to exactly bravo's title (config @60s).
        migrated_title = poll_until(
            lambda: wc_client.find_window_by_title(TITLE_BRAVO),
            timeout=40.0, poll=0.5,
        )
        assert migrated_title is not None, "alpha title did not change to bravo's title"
        assert migrated_title.id == alpha.id, "unexpected window carries bravo's title"

        # let the extension process the title change
        wait_for_settle(3.0)

        # ASSERT (settled-windows invariant): alpha must NOT have been moved to
        # bravo's saved workspace because of the title change.
        final = wc_client.get_details(alpha.id)
        print(f"alpha workspace after title change: {final.workspace}")
        assert final.workspace == ALPHA_WORKSPACE, (
            f"settled window spontaneously migrated workspace on title change: "
            f"alpha moved from workspace {ALPHA_WORKSPACE} to {final.workspace} "
            f"(bravo's saved workspace was {BRAVO_WORKSPACE})"
        )
