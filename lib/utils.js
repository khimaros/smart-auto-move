import GLib from 'gi://GLib'

let _debugEnabled = true

/**
 * Tracks GLib timeout sources for centralized cleanup on extension disable.
 * See: https://gjs.guide/extensions/review-guidelines/review-guidelines.html#remove-main-loop-sources
 */
export class TimeoutManager {
    constructor() {
        this._timeouts = new Set()
    }

    add(priority, interval, callback) {
        const id = GLib.timeout_add(priority, interval, () => {
            const result = callback()
            if (result === GLib.SOURCE_REMOVE) {
                this._timeouts.delete(id)
            }
            return result
        })
        this._timeouts.add(id)
        return id
    }

    remove(id) {
        if (id && this._timeouts.has(id)) {
            GLib.source_remove(id)
            this._timeouts.delete(id)
        }
    }

    removeAll() {
        for (const id of this._timeouts) {
            GLib.source_remove(id)
        }
        this._timeouts.clear()
    }
}

function setDebugEnabled(enabled) {
    _debugEnabled = enabled
}

/**
 * Format current time as HH:MM:SS.mmm
 */
function formatTimestamp() {
    const now = new Date()
    const time = now.toTimeString().split(' ')[0]
    const ms = now.getMilliseconds().toString().padStart(3, '0')
    return `${time}.${ms}`
}

function debug(category, message, isError = false) {
    if (!_debugEnabled && !isError) return

    const output = `[${formatTimestamp()}] [${category}] ${message}`
    if (isError) {
        printerr(output)
    } else {
        print(output)
    }
}

export { debug, setDebugEnabled, formatTimestamp }

export function formatEventDetails(eventType, details) {
    const logArgs = []

    if (eventType === 'window-created') {
        logArgs.push(JSON.stringify(details))
    } else if (eventType === 'notify::title') {
        logArgs.push(details.title || '')
    } else if (eventType === 'notify::wm-class') {
        logArgs.push(details.wm_class || '')
    } else if (eventType === 'size-changed' || eventType === 'position-changed') {
        if (details.frame_rect) {
            logArgs.push(JSON.stringify(details.frame_rect))
        }
        if (eventType === 'size-changed' && details.hasOwnProperty('maximized')) {
            logArgs.push('maximize=' + details.maximized)
        }
    } else if (eventType === 'workspace-changed') {
        logArgs.push(
            JSON.stringify({
                workspace: details.workspace,
                on_all_workspaces: details.on_all_workspaces,
            })
        )
    } else if (eventType === 'notify::minimized') {
        logArgs.push(details.minimized)
    } else if (eventType === 'notify::above') {
        logArgs.push(details.above)
    } else if (eventType === 'notify::fullscreen') {
        logArgs.push(details.fullscreen)
    }

    return logArgs.join(' ')
}

export const DEBOUNCE_MS = 500

export function debounce(win, eventType, pendingEvents, handleEvent, timeoutManager, ...args) {
    if (DEBOUNCE_MS === 0) {
        handleEvent(win, eventType, ...args)
        return
    }

    if (!pendingEvents.has(win)) {
        pendingEvents.set(win, new Map())
    }
    const windowEvents = pendingEvents.get(win)

    if (windowEvents.has(eventType)) {
        const existingTimeout = windowEvents.get(eventType)
        timeoutManager.remove(existingTimeout)
    }

    const timeoutId = timeoutManager.add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
        handleEvent(win, eventType, ...args)
        windowEvents.delete(eventType)
        if (windowEvents.size === 0) {
            pendingEvents.delete(win)
        }
        return GLib.SOURCE_REMOVE
    })

    windowEvents.set(eventType, timeoutId)
}
