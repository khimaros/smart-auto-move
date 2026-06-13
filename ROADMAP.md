# ROADMAP

```
[@] reusable core shared with window-control extension
[x] fix TRACKING windows still migrated/moved on title change within 15s of settling
[x] fix hasExactMatch operator precedence bug causing premature window matching
[x] document the window state machine (see DESIGN.md)
[x] make the e2e test run reliable so environment breakage cannot masquerade
    as a code regression and stall development
    [x] fast session preflight gate (fail in seconds, not minutes)
    [x] distinct harness-error taxonomy (environment vs regression)
    [x] robust per-connector monitor mode selection (no hardcoded refresh rate)
    [x] monitor-baseline isolation so a failed monitor test cannot cascade
[ ] incorporate useful features and fixes from popular fork
    https://github.com/ChrisLauinger77/gnome-shell-extension-SmartAutoMoveNG

[x] fix issue with infinitely bouncing windows
[x] automated testing in a virtual machine or container
    eg. https://schneegans.github.io/tutorials/2022/03/02/gnome-shell-extensions-ci-03
[x] multi-monitor support
[x] fix TRACKING windows incorrectly migrated to different slot on title change
[x] fix TRACKING windows swapping positions on monitors-changed (lock/unlock)
[x] skip tracking transient/dialog windows to prevent parent window snapping
```
