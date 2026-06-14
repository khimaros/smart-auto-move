# TESTING

## unit tests

the matcher state machine and override parsing are host-testable without the VM:

```
$ gjs -m tests/matcher_test.js
$ gjs -m tests/common_test.js
```

## preflight

before committing to a full ~8 minute suite, run the fast environment check:

```
$ scripts/vm-test.sh preflight
```

it verifies the window-control instrument responds, the test monitors are
settable to the single-monitor baseline at a real advertised mode, and the
extension comes up. the same check runs automatically as a session-scoped
fixture (`verify_environment`), so a broken environment aborts the run in
seconds with an unmistakable `ENVIRONMENT NOT READY` message instead of
surfacing minutes later as a cluster of failures that look like regressions.

## reliability

the harness separates environment/harness breakage from product regressions
so an environment glitch never stalls development:

- monitor/display operations raise `HarnessError`; pytest labels these
  `HARNESS/ENVIRONMENT PROBLEM`, distinct from an assertion (a real
  regression). `scripts/vm-test.sh preflight` diagnoses them.
- `set_monitors` selects a real advertised mode per connector (refresh rates
  differ between the virtual outputs) rather than assuming one global mode.
- each test restores the single-monitor baseline during setup, so a monitor
  test that fails mid-reconfiguration cannot cascade into the next test.

## bootstrap

should be run after extension code changes

- `scripts/vm-test.sh uninstall`
- `scripts/vm-test.sh reboot`
- `scripts/vm-test.sh install`
- `scripts/vm-test.sh logout` (fresh installs are not discovered until the session restarts)

test-only changes need no bootstrap: the tests directory is mounted into
the guest at /srv/smart-auto-move and conftest verifies the installed
extension matches the source by hash.

the VM is started automatically when needed (`scripts/vm-test.sh start`).

## cleanup

should be run between each test

- disable the extension
- reset the dconf settings
- restore the single-monitor baseline (only if a prior test left it changed)
- enable the extension

## orchestration

window orchestration is done by /srv/window-control/windowbot.py

test configs for windowbot are in /srv/window-control/testdata/

some configs have long delays with title changes/etc. tests should be resilient to those.

## running stories

```
$ scripts/vm-test.sh pytest                                    # full suite
$ scripts/vm-test.sh pytest test_story_12_title_migration_early.py
```

## stories

## default settings, calculator restore

- open calculator, move, resize, close, reopen (should restore)

## sync mode ignore, override calculator restore

- set default sync mode to IGNORE
- open calculator, move, close, reopen (should NOT restore)
- add an app override for calculator (mode RESTORE, 0.7 threshold)
- open calculator, move, close, reopen (should restore)
- open nautilus, move, close, reopen (should NOT restore)

## workspace and tiling

- launch the "fasttitle" windowbot config
- wait for the window titles to settle
- move the windows to the workspace and tile as described by their titles
- quit and restart the windowbot session with "fasttitle" (should restore)
- quit and restart the windowbot session with "slowtitle" (should restore, with long delays)

## secondary monitors

- launch the "single" windowbot config
- tile the window to the right on the primary monitor
- enable the secondary monitor
- move the window to the secondary monitor and tile to the left
- disable the secondary monitor (should move to primary and tile right)
- enable the secondary monitor (should move to secondary and tile left)
- quit and restart the windowbot session with "single" (should restore to secondary, tile left)
- quit the windowbot session
- disable the secondary monitor
- start the windowbot session with "single" (should restore to primary, tile right)
