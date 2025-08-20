import GLib from 'gi://GLib'
import Mtk from 'gi://Mtk'
import Meta from 'gi://Meta'
import Shell from 'gi://Shell'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import { debug, debounce, TimeoutManager } from './utils.js'
import {
    MAXIMIZED_NONE,
    MAXIMIZED_HORIZONTAL,
    MAXIMIZED_VERTICAL,
    MAXIMIZED_BOTH,
    EXTRACTION_PROPS,
    shouldDebounceEvent
} from './window-state.js'

/**
 * Extract detailed properties from a MetaWindow.
 * Uses property lists from tracker configuration for consistency.
 *
 * @param {Meta.Window} win - The window to inspect
 * @param {Object} extractionProps - Optional property extraction config (uses EXTRACTION_PROPS if not provided)
 * @returns {Object} Serialized window details
 */
export function getWindowState(win, extractionProps = EXTRACTION_PROPS) {
    const details = {}

    for (const propName of extractionProps.direct) {
        if (win[propName] !== undefined) {
            details[propName] = win[propName]
        }
    }

    for (const getter of extractionProps.getters) {
        const methodName = `get_${getter}`
        if (typeof win[methodName] === 'function') {
            const value = win[methodName]()
            if (value instanceof Mtk.Rectangle) {
                details[getter] = {
                    x: value.x,
                    y: value.y,
                    width: value.width,
                    height: value.height,
                }
            } else {
                details[getter] = value
            }
        }
    }

    for (const booleanProp of extractionProps.booleans) {
        if (typeof win[booleanProp] === 'function') {
            details[booleanProp] = win[booleanProp]()
        }
    }

    // Specific properties
    details.workspace = win.get_workspace()?.index() ?? -1
    details.on_all_workspaces = win.is_on_all_workspaces()
    details.fullscreen = win.is_fullscreen()
    details.above = win.is_above()

    // GNOME Shell 49+: get_maximized() was removed
    // Use is_maximized() for full maximize, get_maximize_flags() for partial (tiled)
    // See: https://gjs.guide/extensions/upgrading/gnome-shell-49.html
    if (win.is_maximized?.()) {
        // Fully maximized (both horizontal and vertical)
        details.maximized = MAXIMIZED_BOTH
    } else {
        // Check for partial maximize (tiled left/right/top/bottom)
        details.maximized = win.get_maximize_flags?.() ?? 0
    }
    details.maximized_horizontally = (details.maximized & MAXIMIZED_HORIZONTAL) !== 0
    details.maximized_vertically = (details.maximized & MAXIMIZED_VERTICAL) !== 0

    return details
}

/**
 * ShellWindowMonitor handles connecting to GNOME Shell window signals
 * and normalizing events for consumption.
 */
export class ShellWindowMonitor {
    /**
     * @param {Function} onEventCallback - (winid, eventType, details) => void
     */
    constructor(onEventCallback) {
        this._onEventCallback = onEventCallback
        this._windowConnections = new Map()
        this._pendingEvents = new Map()
        this._timeoutManager = new TimeoutManager()
        this._windowCreatedId = null
        this._monitorsChangedId = null
    }

    enable() {
        // Connect to all existing windows
        global.get_window_actors().forEach((actor) => {
            this._addWindow(actor.meta_window)
        })

        // Connect to window-created signal
        this._windowCreatedId = global.display.connect('window-created', (d, win) => {
            this._addWindow(win)
        })

        // Connect to monitors-changed signal via Main.layoutManager
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            debug('monitor', 'monitors changed, triggering window relocation check')
            // Notify all windows about monitor change
            for (const win of this._windowConnections.keys()) {
                try {
                    const winid = win.get_id()
                    const details = getWindowState(win)
                    this._onEventCallback(winid, 'monitors-changed', details)
                } catch (error) {
                    debug('monitor', `error notifying window ${win.get_id()} of monitor change: ${error.message}`, true)
                }
            }
        })
    }

    disable() {
        if (this._windowCreatedId) {
            global.display.disconnect(this._windowCreatedId)
            this._windowCreatedId = null
        }

        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId)
            this._monitorsChangedId = null
        }

        for (const [win, connections] of this._windowConnections) {
            for (const conn of connections) {
                conn.obj.disconnect(conn.id)
            }
        }
        this._windowConnections.clear()

        this._timeoutManager.removeAll()
        this._pendingEvents.clear()
    }

    _addWindow(win) {
        if (!win || this._windowConnections.has(win)) {
            return
        }

        let actor = global.get_window_actors().find((a) => a.get_meta_window() === win)
        // Note: actor might not be ready immediately, but we need to track the window anyway

        const details = getWindowState(win)
        this._processWindowEvent(win, 'window-created', details)

        const connections = [
            { obj: win, id: win.connect('notify::title', () => this._onWindowModified(win, 'notify::title')) },
            { obj: win, id: win.connect('notify::wm-class', () => this._onWindowModified(win, 'notify::wm-class')) },
            { obj: win, id: win.connect('notify::minimized', () => this._onWindowModified(win, 'notify::minimized')) },
            { obj: win, id: win.connect('notify::above', () => this._onWindowModified(win, 'notify::above')) },
            { obj: win, id: win.connect('notify::fullscreen', () => this._onWindowModified(win, 'notify::fullscreen')) },
            { obj: win, id: win.connect('notify::maximized-horizontally', () => this._onWindowModified(win, 'notify::maximized-horizontally')) },
            { obj: win, id: win.connect('notify::maximized-vertically', () => this._onWindowModified(win, 'notify::maximized-vertically')) },
            { obj: win, id: win.connect('size-changed', () => this._onWindowModified(win, 'size-changed')) },
            { obj: win, id: win.connect('position-changed', () => this._onWindowModified(win, 'position-changed')) },
            { obj: win, id: win.connect('workspace-changed', () => this._onWindowModified(win, 'workspace-changed')) },
        ]

        // Only subscribe to destroy for normal windows (not tooltips, menus, etc.)
        if (actor && win.get_window_type() === Meta.WindowType.NORMAL) {
            connections.push({ obj: actor, id: actor.connect('destroy', () => this._onWindowModified(win, 'destroy')) })
        }

        this._windowConnections.set(win, connections)
    }

    _removeWindow(win) {
        this._processWindowEvent(win, 'destroy')

        if (this._pendingEvents.has(win)) {
            for (const [eventType, timeoutId] of this._pendingEvents.get(win)) {
                this._timeoutManager.remove(timeoutId)
            }
            this._pendingEvents.delete(win)
        }

        if (!this._windowConnections.has(win)) {
            return
        }

        const connections = this._windowConnections.get(win)
        for (const conn of connections) {
            conn.obj.disconnect(conn.id)
        }
        this._windowConnections.delete(win)
    }

    _onWindowModified(win, eventType) {
        if (eventType === 'destroy') {
            this._removeWindow(win)
            return
        }
        // Use tracker policy for debouncing decisions
        if (!shouldDebounceEvent(eventType)) {
            this._processWindowEvent(win, eventType)
            return
        }
        debounce(win, eventType, this._pendingEvents, this._processWindowEvent.bind(this), this._timeoutManager)
    }

    _processWindowEvent(win, eventType, existingDetails = null) {
        if (!win) return

        if (!this._windowConnections.has(win) && eventType !== 'destroy') {
            // Untracked window event
            return
        }

        try {
            const winid = win.get_id()
            if (eventType === 'destroy') {
                this._onEventCallback(winid, eventType, { destroyed: true })
                return
            }

            const details = existingDetails || getWindowState(win)
            this._onEventCallback(winid, eventType, details)
        } catch (error) {
            debug('monitor', `error processing window event ${eventType}: ${error.message}`, true)
        }
    }
}

export class ShellWindowExecutor {
    constructor(config = {}) {
        this._config = {
            activate_on_move: true,
            ...config
        }
        this._global = global
        this._display = global.display
        this._workspaceManager = global.workspace_manager
    }

    _getWindowById(winid) {
        const windows = global.get_window_actors()
        const actor = windows.find((win) => win.meta_window.get_id() == winid)
        return actor ? actor.meta_window : null
    }

    /**
     * Execute an operation on a window with standardized error handling.
     * @param {number} winid - Window ID
     * @param {string} opName - Operation name for logging
     * @param {Function} fn - Function to execute with the window
     * @returns {*} Result of fn, or undefined on error
     */
    _withWindow(winid, opName, fn) {
        const win = this._getWindowById(winid)
        if (!win) {
            debug('shell', `${opName}: Window ${winid} not found`, true)
            return
        }
        try {
            return fn(win)
        } catch (error) {
            debug('shell', `failed to ${opName.toLowerCase()} window ${winid}: ${error.message}`, true)
        }
    }

    /* --- Read Operations --- */

    list() {
        const windows = global.get_window_actors()
        return windows.map((w) => {
            const win = w.meta_window
            return {
                id: win.get_id(),
                title: win.get_title(),
                wm_class: win.get_wm_class(),
            }
        })
    }

    listNormalWindows() {
        const windows = global.get_window_actors()
        const normalWindows = []
        const windowTracker = Shell.WindowTracker.get_default()

        for (const actor of windows) {
            const win = actor.meta_window
            if (!win) continue

            const title = win.get_title()
            const wm_class = win.get_wm_class()

            if (!title || !wm_class) continue
            if (win.is_skip_taskbar()) continue
            if (win.get_window_type() !== Meta.WindowType.NORMAL) continue

            let icon_string = ''
            const app = windowTracker.get_window_app(win)
            if (app) {
                const icon = app.get_icon()
                if (icon) {
                    icon_string = icon.to_string()
                }
            }

            normalWindows.push({
                wsh: wm_class,
                title: title,
                app_icon: icon_string,
            })
        }
        return normalWindows
    }

    getDetails(winid) {
        const win = this._getWindowById(winid)
        if (!win) {
            throw new Error(`GetDetails: Window ${winid} not found`)
        }
        return getWindowState(win)
    }

    getFrameRect(winid) {
        const win = this._getWindowById(winid)
        if (!win) {
            throw new Error(`GetFrameRect: Window ${winid} not found`)
        }
        const { x, y, width, height } = win.get_frame_rect()
        return { x, y, width, height }
    }

    getBufferRect(winid) {
        const win = this._getWindowById(winid)
        if (!win) {
            throw new Error(`GetBufferRect: Window ${winid} not found`)
        }
        const { x, y, width, height } = win.get_buffer_rect()
        return { x, y, width, height }
    }

    getTitle(winid) {
        const win = this._getWindowById(winid)
        if (!win) {
            throw new Error(`GetTitle: Window ${winid} not found`)
        }
        return win.get_title()
    }

    getFocusedMonitorDetails() {
        const id = global.display.get_current_monitor()
        const monitorGeometryMtkRect = global.display.get_monitor_geometry(id)
        return {
            id,
            geometry: {
                x: monitorGeometryMtkRect.x,
                y: monitorGeometryMtkRect.y,
                width: monitorGeometryMtkRect.width,
                height: monitorGeometryMtkRect.height,
            },
        }
    }

    getAllWindowDetails() {
        const actors = global.get_window_actors()
        return actors.map(actor => {
             const win = actor.meta_window
             return {
                 id: win.get_id(),
                 details: getWindowState(win)
             }
        })
    }

    /* --- Write Operations --- */

    moveToWorkspace(winid, wsid) {
        this._withWindow(winid, 'MoveToWorkspace', (win) => {
            const workspace = this._workspaceManager.get_workspace_by_index(wsid)
            if (!workspace) {
                debug('shell', `MoveToWorkspace: Workspace ${wsid} not found`, true)
                return
            }
            win.change_workspace(workspace)
            if (this._config.activate_on_move) {
                workspace.activate_with_focus(win, this._global.get_current_time())
            }
            debug('shell', `moved window ${winid} to workspace ${wsid}`)
        })
    }

    moveToMonitor(winid, mid) {
        const nMonitors = global.display.get_n_monitors()
        if (mid < 0 || mid >= nMonitors) {
            debug('shell', `MoveToMonitor: Monitor ${mid} not found (available: 0-${nMonitors - 1})`, true)
            return
        }
        this._withWindow(winid, 'MoveToMonitor', (win) => {
            win.move_to_monitor(mid)
            debug('shell', `moved window ${winid} to monitor ${mid}`)
        })
    }

    place(winid, x, y, width, height) {
        this._withWindow(winid, 'Place', (win) => {
            win.move_resize_frame(true, x, y, width, height)
            debug('shell', `placed window ${winid} at (${x}, ${y}) with size ${width}x${height}`)
        })
    }

    move(winid, x, y) {
        this._withWindow(winid, 'Move', (win) => {
            win.move_frame(true, x, y)
            debug('shell', `moved window ${winid} to (${x}, ${y})`)
        })
    }

    maximize(winid, state) {
        this._withWindow(winid, 'Maximize', (win) => {
            if (state === MAXIMIZED_HORIZONTAL) {
                win.set_maximize_flags(Meta.MaximizeFlags.HORIZONTAL)
                debug('shell', `maximized window ${winid} horizontally`)
            } else if (state === MAXIMIZED_VERTICAL) {
                win.set_maximize_flags(Meta.MaximizeFlags.VERTICAL)
                debug('shell', `maximized window ${winid} vertically`)
            } else if (state === MAXIMIZED_BOTH) {
                win.maximize()
                debug('shell', `maximized window ${winid} fully`)
            } else {
                debug('shell', `Maximize called with invalid state ${state}`, true)
            }
        })
    }

    minimize(winid) {
        this._withWindow(winid, 'Minimize', (win) => {
            win.minimize()
            debug('shell', `minimized window ${winid}`)
        })
    }

    unmaximize(winid) {
        this._withWindow(winid, 'Unmaximize', (win) => {
            win.unmaximize()
            debug('shell', `unmaximized window ${winid}`)
        })
    }

    close(winid, isForced = false) {
        this._withWindow(winid, 'Close', (win) => {
            if (isForced) {
                win.kill()
                debug('shell', `forcefully killed window ${winid}`)
            } else {
                win.delete(this._global.get_current_time())
                debug('shell', `closed window ${winid}`)
            }
        })
    }

    setFullscreen(winid, state) {
        this._withWindow(winid, 'SetFullscreen', (win) => {
            if (state) {
                win.make_fullscreen()
                debug('shell', `set fullscreen for window ${winid}`)
            } else {
                win.unmake_fullscreen()
                debug('shell', `removed fullscreen for window ${winid}`)
            }
        })
    }

    toggleFullscreen(winid) {
        this._withWindow(winid, 'ToggleFullscreen', (win) => {
            if (win.is_fullscreen()) {
                win.unmake_fullscreen()
                debug('shell', `exited fullscreen for window ${winid}`)
            } else {
                win.make_fullscreen()
                debug('shell', `entered fullscreen for window ${winid}`)
            }
        })
    }

    setOnAllWorkspaces(winid, state) {
        this._withWindow(winid, 'SetOnAllWorkspaces', (win) => {
            if (state) {
                win.stick()
                debug('shell', `set window ${winid} on all workspaces`)
            } else {
                win.unstick()
                debug('shell', `removed window ${winid} from all workspaces`)
            }
        })
    }

    setAbove(winid, state) {
        this._withWindow(winid, 'SetAbove', (win) => {
            if (state) {
                win.make_above()
                debug('shell', `set window ${winid} above others`)
            } else {
                win.unmake_above()
                debug('shell', `removed window ${winid} from above others`)
            }
        })
    }
}
