# DESIGN

architecture notes for smart-auto-move. the core idea: resolve a window's
identity exactly once, while it is PENDING, and never move a window that
has already settled.

## components

- `extension.js` — settings glue, D-Bus service, migration; owns a WindowManager
- `lib/window-manager.js` — composes the monitor, session, and executor for gnome-shell
- `lib/gnome-shell.js` — ShellWindowMonitor (mutter signals to normalized events),
  ShellWindowExecutor (operations to mutter calls), monitor/connector helpers
- `lib/state-session.js` — StateSession (lifecycle + pluggable persistence),
  OperationHandler (executes operations, defers around workspace moves)
- `lib/state-matcher.js` — WindowStateMatcher: the state machine, identity
  matching, and operation generation; pure logic, host-testable via gjs
- `lib/window-state.js` — property lists and window tracking policy helpers

## window state machine

each window id has a WindowStateInfo in one of four states:

```
                            +------- drift detected -------+
                            v                              |
window event --> PENDING --decide--> RESTORING --ops--> SETTLING --ok--> TRACKING
                    |                                                       ^
                    +---------- added as new (no operations) ---------------+
```

### PENDING

the window exists but its identity is unresolved. no operations are ever
generated in this state. decision rules (`shouldDecideOnWindow`, evaluated
by `processPendingWindows` on a 200ms timer):

- exact match (non-empty title and wm_class equal to an unoccupied slot):
  decide immediately. this is the fast path for apps with stable generic
  titles like Calculator.
- specific title (length >= MIN_SPECIFIC_TITLE_LENGTH): decide after
  SETTLE_IDLE_TIMEOUT of event silence, or after SETTLE_MAX_WAIT with a
  shorter idle requirement.
- generic title while unoccupied same-class slots exist: wait for the title
  to become specific or for GENERIC_TITLE_EXTENDED_WAIT to expire. deciding
  early on a weak identity is what previously forced corrective moves after
  windows had already settled.
- generic title with no candidate slots: decide after idle; there is
  nothing to mismatch against.
- multiple similar pending windows of one wm_class are ambiguous and defer
  until timeout, unless exactly matched.

decision outcome: best score >= the policy threshold occupies that slot and
generates restore operations (-> RESTORING); otherwise the window is added
as a new slot (-> TRACKING).

### RESTORING

operations are executing. events update the observed details only; saved
configs are never written here so intermediate states from our own
operations (e.g. the unmaximize before a move) cannot corrupt stored state.
OperationHandler reports completion via `onOperationsComplete` (-> SETTLING).

### SETTLING

a quiet period (DRIFT_DETECTION_WINDOW) after operations. any event resets
the timer. on timeout the final state is compared against targetConfig:
mismatch transitions back to RESTORING for correction (bounded by
MAX_DRIFT_RETRIES), match transitions to TRACKING.

### TRACKING

user changes update the occupied slot's per-connector config.

invariant: a window that occupies a slot is never re-matched or moved
because its title changed. title changes only update the slot's stored
identity. operations originate from exactly two sources in this state:

- monitors-changed relocation (`_handleMonitorsChanged`), which re-applies
  the best available config when displays appear or disappear
- a user-initiated monitor move (`_handleUserMonitorChange`), which records
  the connector preference and restores that connector's saved config

## identity matching

- slots (`knownWindows`): `{ occupied: winid|null, props: { wm_class, title,
  configs[], connectorPreference[] }, seen }`. a slot is the remembered
  identity and layout of one logical window across sessions.
- scoring: wm_class must match exactly; titles are compared by normalized
  character histogram distance, penalized when the pending title is much
  shorter than the known title and boosted for specific-to-specific matches.
- confidence: the best score must beat the second best by MIN_SCORE_SPREAD
  unless the decision timed out or the match is exact.
- configs are stored per connector name (stable across monitor hotplug,
  unlike indices) with a monitor-relative rect; connectorPreference is a
  LIFO list of the user's explicit monitor choices.

## operation generation and execution

- `generateRestoreOperations` orders operations as: monitor, workspace,
  maximize, place, minimized/fullscreen. `expandOperations` inserts
  unmaximize preconditions where mutter requires them.
- OperationHandler executes operations immediately except those queued
  behind a MoveToWorkspace, which wait for the workspace change event (or
  WORKSPACE_SETTLE_TIMEOUT) plus OPERATION_SETTLE_DELAY_MS, because
  move_resize_frame is unreliable on non-visible workspaces.

## persistence

every state change serializes `knownWindows` through the onStateChange
callback; the extension writes it to the `saved-windows` gsettings key with
its own change signal blocked to avoid feedback loops. freeze-saves flips
the session read-only.
