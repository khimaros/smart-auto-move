# TESTING

## bootstrap

should be run after code changes

- build the extension on host
- install the extension on the guest
- guest logout and wait for autologin

## cleanup

should be run between each test

- disable the extension
- reset the dconf settings
- enable the extension

## orchestration

window orchestration is done by /srv/window-control/windowbot.py

test configs for windowbot are in /srv/window-control/testdata/

some configs have long delays with title changes/etc. tests should be resilient to those.

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
