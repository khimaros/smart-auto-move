"""
Story 14: the extension must not reload (restoreFromState) its OWN saved-windows writes.

_saveState() wraps set_string("saved-windows", ...) in
block_signal_handler/unblock_signal_handler to keep its own writes from
re-firing the "changed::saved-windows" handler. But with the dconf backend the
"changed" signal is delivered ASYNCHRONOUSLY, after unblock, so the block is
ineffective (confirmed: a minimal block->set->unblock->pump-mainloop repro fires
the handler once per write). The extension therefore reloads its own state on
nearly every tracked window modification -- a self-inflicted restoreFromState
that wipes slot occupancy (see story 13 for the consequence).

This test does only self-writes (move a tracked window) and asserts the
extension does not reload its own state. It fails before the trigger fix (the
handler reloads on every changed, including self-writes) and passes after the
handler skips writes whose value matches what _saveState last wrote.
"""

import subprocess
import time

from vmtest import launch_app, close_app, wait_for_settle

RELOAD_MARKER = "saved-windows changed: reloading tracker state"


def _count_reloads_since(since_ts: str) -> int:
    out = subprocess.run(
        ["journalctl", "--user", "-b", "--no-pager", "--since", since_ts],
        capture_output=True, text=True, timeout=10,
    ).stdout
    return sum(1 for line in out.splitlines() if RELOAD_MARKER in line)


class TestStory14:
    def test_self_write_does_not_reload(self, wc_client, ext_state):
        ext_state.set_sync_mode("RESTORE")
        ext_state.enable_debug_logging(True)

        win, proc = launch_app(wc_client, ["gnome-calculator"], "org.gnome.Calculator")
        try:
            # let the window settle and its initial saves quiesce
            wait_for_settle(3.0)

            # mark the start of the observation window strictly before any new save;
            # journalctl --since uses 1s granularity, so pause past the boundary
            since = time.strftime("%Y-%m-%d %H:%M:%S")
            time.sleep(1.2)

            # several self-writes: each move updates the slot config -> _saveState
            d = wc_client.get_details(win.id)
            for i in range(3):
                wc_client.move(win.id, d.x + 30 * (i + 1), d.y + 30 * (i + 1))
                wait_for_settle(1.0)

            # allow the async dconf "changed" notifications to be delivered
            wait_for_settle(3.0)

            reloads = _count_reloads_since(since)
            print(f"saved-windows self-write reloads observed: {reloads}")
            assert reloads == 0, (
                f"extension reloaded its own saved-windows write {reloads} time(s); "
                f"self-writes must not trigger restoreFromState "
                f"(block_signal_handler does not suppress async dconf 'changed')"
            )
        finally:
            close_app(wc_client, win.id, proc)
