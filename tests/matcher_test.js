// matcher unit tests, run on host or guest with: gjs -m tests/matcher_test.js
//
// covers state-matcher behavior that is hard to time reliably in the
// e2e harness: exact-match detection and the guarantee that windows
// in TRACKING state are never moved by title changes.

import { WindowStateMatcher } from '../lib/state-matcher.js'
import { setDebugEnabled } from '../lib/utils.js'

setDebugEnabled(false)

let failures = 0

function check(label, condition, detail = '') {
    if (condition) {
        console.log(`PASS: ${label}`)
    } else {
        failures++
        console.log(`FAIL: ${label}${detail ? ' -- ' + detail : ''}`)
    }
}

const TITLE_LONG = 'Project Management Dashboard - Q4 Report'
const TITLE_SHORT = 'Project Manager'

function makeMatcher(initialState = null) {
    return new WindowStateMatcher({
        initialState,
        getMonitorCount: () => 1,
        getMonitorGeometry: () => ({ x: 0, y: 0, width: 1280, height: 1024 }),
        getConnectorForMonitor: () => 'Virtual-1',
        getMonitorForConnector: (name) => (name === 'Virtual-1' ? 0 : -1),
        getAvailableConnectors: () => ['Virtual-1'],
    })
}

function makeSlot(title, x = 100, y = 100) {
    return {
        occupied: null,
        seen: Date.now(),
        props: {
            wm_class: 'com.example.WindowBot',
            title,
            connectorPreference: ['Virtual-1'],
            configs: [{
                connector: 'Virtual-1', workspace: 0, minimized: false, maximized: 0,
                relative_rect: { x, y, width: 500, height: 400 },
            }],
        },
    }
}

function makeDetails(title, x = 400, y = 300) {
    return {
        wm_class: 'com.example.WindowBot', title,
        monitor: 0, workspace: 0, minimized: false, maximized: 0, fullscreen: false,
        on_all_workspaces: false, above: false, window_type: 0, skip_taskbar: false,
        frame_rect: { x, y, width: 600, height: 500 },
    }
}

// hasExactMatch must only fire on a true title + wm_class match
{
    const m = makeMatcher([makeSlot(TITLE_LONG)])

    check('hasExactMatch true for identical title and class',
        m.hasExactMatch(makeDetails(TITLE_LONG)) === true)

    check('hasExactMatch false for same class but different title',
        m.hasExactMatch(makeDetails('xyz')) === false)

    m.destroy()
}

{
    const m = makeMatcher([makeSlot('')])
    const details = { ...makeDetails('xyz'), wm_class: 'org.other.App' }

    check('hasExactMatch false for different class when a slot title is empty',
        m.hasExactMatch(details) === false)

    m.destroy()
}

// a window in TRACKING state must never be moved by a title change,
// no matter how recently it settled (stories 4 and 9 requirement)
{
    const m = makeMatcher([makeSlot(TITLE_LONG)])
    const winid = 42

    m.onWindowModified(winid, 'window-created', makeDetails(TITLE_SHORT))

    // simulate idle long enough for the pending decision to fire
    const ws = m._windowStates.get(winid)
    ws.lastEventTime = Date.now() - 1000
    m.processPendingWindows()

    check('window settled into TRACKING with its own slot',
        ws.state === 'TRACKING' &&
        m.knownWindows.some((w) => w.occupied === winid),
        `state=${ws.state}`)

    // only 6s in TRACKING (inside the 15s grace window), then the title
    // changes to exactly match the unoccupied slot from a previous session
    ws.transitionTime = Date.now() - 6000
    const result = m.onWindowModified(winid, 'notify::title', makeDetails(TITLE_LONG))

    check('no operations generated for TRACKING window on title change',
        result.operations.length === 0,
        JSON.stringify(result.operations))

    m.destroy()
}

// generic-titled windows with potential matches must wait in PENDING rather
// than being decided early and corrected with a visible move later
{
    const m = makeMatcher([makeSlot(TITLE_LONG)])
    m.onWindowModified(7, 'window-created', makeDetails('Untitled'))
    const ws = m._windowStates.get(7)
    ws.lastEventTime = Date.now() - 1000
    m.processPendingWindows()

    check('generic-titled window with candidate slots stays PENDING',
        ws.state === 'PENDING', `state=${ws.state}`)

    m.destroy()
}

// generic-titled windows with no candidate slots are added without delay
{
    const m = makeMatcher()
    m.onWindowModified(8, 'window-created', makeDetails('Untitled'))
    const ws = m._windowStates.get(8)
    ws.lastEventTime = Date.now() - 1000
    m.processPendingWindows()

    check('generic-titled window with no candidates is added as new',
        ws.state === 'TRACKING' && m.knownWindows.some((w) => w.occupied === 8),
        `state=${ws.state}`)

    m.destroy()
}

// stable generic titles (e.g. Calculator) still restore instantly through the
// exact-match fast path, with no idle wait
{
    const m = makeMatcher([makeSlot('Calculator')])
    const result = m.onWindowModified(9, 'window-created', makeDetails('Calculator'))
    const ws = m._windowStates.get(9)

    check('exact generic title decides immediately',
        ws.state !== 'PENDING', `state=${ws.state}`)

    check('exact match generates restore operations',
        result.operations.some((op) => op.type === 'Place'),
        JSON.stringify(result.operations))

    m.destroy()
}

if (failures > 0) {
    console.log(`${failures} check(s) failed`)
    // imports.system.exit is the portable way to set exit status in gjs
    imports.system.exit(1)
}
console.log('all checks passed')
