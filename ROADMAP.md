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
[ ] support gnome-shell 50 (declare shell-version 50; audit for removed APIs:
    keyboardManager hold/releaseKeyboard, global.display restart signals,
    RunDialog._restart; see gjs.guide/extensions/upgrading/gnome-shell-50)
    [x] declare shell-version 50 in both extensions; audit found no removed
        APIs in use, so no code changes required
    [x] verify e2e suite passes on gnome-shell 50 (run 1: 20/20 green)
[x] harden flaky story 12 (title_migration_early): under suite load beta could
    miss the new-window max-wait timeout before the title change and resolve in
    PENDING, tripping the migration assertion. make beta deterministically reach
    TRACKING first (dissimilar short title so it settles as new; title change
    moved after the max-wait timeout) and gate the assertion on an explicit
    TRACKING precondition with a clear harness diagnostic
[ ] make extension-readiness waits fail fast and label as harness/environment
    errors: story 6/10 intermittently hit the 30s wait_for_ready D-Bus timeout
    after extension reinit under accumulated suite load. it raises a plain
    RuntimeError so it reads as a regression instead of an environment problem.
    raise HarnessError (and consider retrying the enable) so it cannot
    masquerade as a code regression
[x] fix prefs dialog crash (wshos.forEach) when an override value is a single
    rule object rather than an array; normalize in parseOverrides

[x] fix issue with infinitely bouncing windows
[x] automated testing in a virtual machine or container
    eg. https://schneegans.github.io/tutorials/2022/03/02/gnome-shell-extensions-ci-03
[x] multi-monitor support
[x] fix TRACKING windows incorrectly migrated to different slot on title change
[x] fix TRACKING windows swapping positions on monitors-changed (lock/unlock)
[x] skip tracking transient/dialog windows to prevent parent window snapping
```
