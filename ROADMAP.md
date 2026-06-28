# ROADMAP

```
[x] fix settled (TRACKING) windows spontaneously moved to another window's
    workspace after a saved-windows reapply. restoreFromState() (fired by the
    saved-windows GSettings changed handler, and on re-init) resets every
    slot's `occupied` to null WITHOUT re-matching, while the per-window state
    machine stays TRACKING. the next title change on a settled window is then
    handled as "new window detected", re-matched against the saved pool, and
    for visually identical maximized windows (eg several firefox windows
    distinguished only by volatile titles) lands on the wrong slot and issues
    a cross-workspace move. violates the settled-windows invariant.
    [x] failing e2e test (story 13) reproducing the spontaneous move (RED: alpha
        migrates ws1 -> ws2 on title change after a saved-windows reapply)
    [x] source fix: restoreFromState carries live-window occupancy across a
        reload, keyed by identity, so a runtime reapply can't strand a window
    [x] invariant guard: onWindowModified never demotes an already-tracked
        window to PENDING; re-binds it by prior identity (_rebindKnownWindow)
    [x] matcher unit tests for both paths (fail against pre-fix matcher)
    [x] trigger hardening: _saveState records its last write; the saved-windows
        handler ignores a value equal to it, so the extension never reloads its
        own writes even where block_signal_handler leaks. story 14 guards it
        (passes; self-writes are deduped in-process anyway, so it is belt-and-
        suspenders). real-world trigger still under investigation -- no periodic
        cleanup timer exists; only external different-value writes reload. see
        [[occupancy-wipe-spontaneous-move]].
    [x] verify in VM: full suite green (22/22) with the hardened build. single-
        monitor stories all pass; multi-monitor stories 5,6,10 pass with Virtual-2/3
        attached via virt-viewer. headless head provisioning is not feasible here
        -- see [[multimonitor-head-provisioning]].
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
