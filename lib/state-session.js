import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import { WindowStateMatcher } from './state-matcher.js'
import { debug, TimeoutManager } from './utils.js'

/**
 * StateSession manages the lifecycle of WindowStateMatcher with pluggable state persistence.
 *
 * Consolidates common logic for:
 * - Creating and managing WindowStateMatcher instance
 * - Loading/saving state via pluggable callbacks
 * - Processing tracker results through OperationHandler
 * - Config management
 *
 * Used by both WindowManager (for in-process extensions) and external clients (like wcc.js).
 */
export class StateSession {
    /**
     * @param {Object} options.trackerHandler - Optional custom OperationHandler instance
     * @param {Function} options.actorQueryCallback - Optional callback to query current actors: () => [{winid, details}]
     * @param {boolean} options.preserveOccupiedState - If true, preserve occupied status from saved state instead of resetting to null
     * @param {boolean} options.readOnly - If true, prevent state saving
     * @param {Function} options.operationFilter - Optional filter for operations: (op) => boolean
     * @param {Function} options.policyCallback - Optional policy callback for tracker: (winid, details) => boolean
     * @param {Function} options.getMonitorCountCallback - Optional callback to get current monitor count: () => number
     * @param {Function} options.getMonitorGeometryCallback - Optional callback to get monitor geometry: (index) => {x, y, width, height}
     * @param {Function} options.getConnectorForMonitorCallback - Optional callback to get connector name for monitor: (index) => string|null
     * @param {Function} options.getMonitorForConnectorCallback - Optional callback to get monitor index for connector: (name) => number
     * @param {Function} options.getAvailableConnectorsCallback - Optional callback to get list of connected connectors: () => string[]
     */
    constructor(executor, { config = {}, stateLoader = null, stateSaver = null, trackerHandler = null, actorQueryCallback = null, preserveOccupiedState = false, readOnly = false, operationFilter = null, policyCallback = null, getMonitorCountCallback = null, getMonitorGeometryCallback = null, getConnectorForMonitorCallback = null, getMonitorForConnectorCallback = null, getAvailableConnectorsCallback = null } = {}) {
        this._executor = executor
        this._config = config
        this._stateLoader = stateLoader
        this._stateSaver = stateSaver
        this._readOnly = readOnly

        // Generate default actor query callback if not provided
        this._actorQueryCallback = actorQueryCallback || (() => {
            if (!this._executor) return []

            try {
                // Prefer batch retrieval if available
                if (typeof this._executor.getAllWindowDetails === 'function') {
                    return this._executor.getAllWindowDetails()
                        .filter(w => w.details && !w.error)
                        .map(w => ({ winid: w.id, details: w.details }))
                }

                // Fallback to individual retrieval
                if (typeof this._executor.list === 'function' && typeof this._executor.getDetails === 'function') {
                    return this._executor.list().map(w => {
                        try {
                            return { winid: w.id, details: this._executor.getDetails(w.id) }
                        } catch (e) { return null }
                    }).filter(w => w !== null)
                }
            } catch (e) {
                debug('session', `error querying actors: ${e.message}`, true)
            }
            return []
        })

        // Track match/new statistics
        this._matchedCount = 0
        this._newCount = 0

        // Create tracker handler (pass config for workspace settle strategy)
        this._trackerHandler = trackerHandler || new OperationHandler(this._executor, operationFilter, this._config)

        // Load initial state
        let initialState = null
        if (this._stateLoader) {
            try {
                initialState = this._stateLoader()
                if (initialState) {
                    debug('session', 'loaded initial state')
                }
            } catch (e) {
                debug('session', `error loading initial state: ${e.message}`, true)
            }
        }

        // Create tracker with callbacks
        this._tracker = new WindowStateMatcher({
            onProcessing: this._onAsyncProcessing.bind(this),
            onStateChange: (state) => {
                if (this._readOnly) {
                    debug('session', 'skipping save (read-only mode)')
                    return
                }
                if (this._stateSaver) {
                    this._stateSaver(state)
                }
            },
            config: this._config,
            initialState,
            actorQuery: this._actorQueryCallback,
            preserveOccupied: preserveOccupiedState,
            policy: policyCallback,
            getMonitorCount: getMonitorCountCallback,
            getMonitorGeometry: getMonitorGeometryCallback,
            getConnectorForMonitor: getConnectorForMonitorCallback,
            getMonitorForConnector: getMonitorForConnectorCallback,
            getAvailableConnectors: getAvailableConnectorsCallback,
        })

        // Give the operation handler a reference to the tracker for callbacks
        this._trackerHandler._tracker = this._tracker

        // Process initial actors now that all references are set up
        if (this._actorQueryCallback) {
            const result = this._tracker.updateFromCurrentActors()
            if (result && (result.operations.length > 0 || result.events.length > 0)) {
                this._onAsyncProcessing(result)
            }
        }

        debug('session', 'StateSession initialized')
    }

    /**
     * Process a window modification event.
     *
     * @param {number} winid - Window ID
     * @param {string} eventType - Event type (e.g., 'window-created', 'notify::title')
     * @param {Object} windowDetails - Window details object
     * @returns {Object|null} Tracker result or null
     */
    onWindowModified(winid, eventType, windowDetails) {
        if (!this._tracker) {
            debug('session', 'tracker not initialized', true)
            return null
        }

        try {
            const result = this._tracker.onWindowModified(winid, eventType, windowDetails)
            if (result && this._trackerHandler) {
                this._trackerHandler.processTrackerResult(result)
            }
            return result
        } catch (error) {
            debug('session', `error processing window event ${eventType}: ${error.message}`, true)
            return null
        }
    }

    /**
     * Handle async processing results from tracker.
     * @private
     */
    _onAsyncProcessing(result) {
        // Track matches and new windows
        if (result.events) {
            for (const event of result.events) {
                if (event.type === 'known.match') {
                    this._matchedCount++
                } else if (event.type === 'known.new') {
                    this._newCount++
                }
            }
        }

        if (this._trackerHandler) {
            this._trackerHandler.processTrackerResult(result)
        }
    }

    /**
     * Clean up tracker resources.
     */
    destroy() {
        if (this._tracker) {
            this._tracker.destroy()
            this._tracker = null
        }
        if (this._trackerHandler) {
            this._trackerHandler.destroy()
            this._trackerHandler = null
        }
        this._executor = null
        debug('session', 'StateSession destroyed')
    }

    // Accessors

    getTracker() {
        return this._tracker
    }

    getExecutor() {
        return this._executor
    }

    getTrackerHandler() {
        return this._trackerHandler
    }

    getStats() {
        const trackerStats = this._tracker ? this._tracker.getStats() : null
        if (trackerStats) {
            return {
                ...trackerStats,
                matchedCount: this._matchedCount,
                newCount: this._newCount,
            }
        }
        return null
    }

    getConfig() {
        return this._tracker ? { ...this._tracker._config } : { ...this._config }
    }

    updateConfig(newConfig) {
        if (this._tracker) {
            Object.assign(this._tracker._config, newConfig)
        }
        Object.assign(this._config, newConfig)
        debug('session', `config updated: ${JSON.stringify(newConfig)}`)
    }

    refreshWindowState() {
        return this._tracker ? this._tracker.refreshFromCurrentActors() : { operations: [], events: [] }
    }

    /**
     * List stale entries in the current tracker state.
     *
     * @param {number} maxAgeHours - Maximum age in hours before considering entry stale (default: 24)
     * @returns {Array} Array of stale entries with details
     */
    listStaleEntries(maxAgeHours = 24) {
        if (!this._tracker || !this._executor) {
            return []
        }

        const staleEntries = []
        const currentWindows = this._executor.list()
        const currentWinIds = new Set(currentWindows.map(w => w.id.toString()))
        const cutoffTime = Date.now() - (maxAgeHours * 60 * 60 * 1000)

        this._tracker.knownWindows.forEach((slot, index) => {
            const winid = slot.occupied
            const seen = slot.seen || 0
            const isOccupied = winid !== null && winid !== undefined

            if (isOccupied) {
                // For occupied slots, only mark stale if window no longer exists
                const exists = currentWinIds.has(winid.toString())
                if (!exists) {
                    staleEntries.push({
                        slotIndex: index,
                        winid: winid,
                        wm_class: slot.props?.wm_class || 'unknown',
                        title: slot.props?.title || 'untitled',
                        seen: seen,
                        reason: 'window-no-longer-exists',
                        ageHours: ((Date.now() - seen) / (60 * 60 * 1000)).toFixed(1)
                    })
                }
            } else {
                // For unoccupied slots, mark stale if old
                const isOld = seen < cutoffTime
                if (isOld) {
                    staleEntries.push({
                        slotIndex: index,
                        winid: null,
                        wm_class: slot.props?.wm_class || 'unknown',
                        title: slot.props?.title || 'untitled',
                        seen: seen,
                        reason: 'not-seen-recently',
                        ageHours: ((Date.now() - seen) / (60 * 60 * 1000)).toFixed(1)
                    })
                }
            }
        })

        return staleEntries
    }

    /**
     * Clean up stale entries from the tracker state.
     *
     * @param {number} maxAgeHours - Maximum age in hours before considering entry stale (default: 24)
     * @returns {Object} Stats about cleanup: { removedSlots, staleEntries }
     */
    cleanupStaleEntries(maxAgeHours = 24) {
        const staleEntries = this.listStaleEntries(maxAgeHours)

        if (staleEntries.length === 0) {
            return { removedSlots: 0, staleEntries: [] }
        }

        // Create a set of stale slot indices
        const staleIndices = new Set(staleEntries.map(e => e.slotIndex))

        // Filter out stale slots from knownWindows
        this._tracker.knownWindows = this._tracker.knownWindows.filter((slot, index) => {
            if (staleIndices.has(index)) {
                debug('session', `removing stale slot ${index}: winid=${slot.occupied}`)
                return false
            }
            return true
        })

        // Trigger save via state change callback
        this._tracker.notifyStateChange()

        debug('session', `cleaned up ${staleEntries.length} stale slot(s)`)

        return {
            removedSlots: staleEntries.length,
            staleEntries: staleEntries
        }
    }

    /**
     * Remove a specific slot from the tracker state.
     *
     * @param {number} slotIndex - Index of the slot to remove
     * @returns {Object} Result: { success: boolean, message: string, wm_class: string, title: string }
     */
    removeSlot(slotIndex) {
        if (!this._tracker) {
            return { success: false, message: 'Tracker not initialized' }
        }

        if (slotIndex < 0 || slotIndex >= this._tracker.knownWindows.length) {
            return {
                success: false,
                message: `Invalid slot index: ${slotIndex} (valid range: 0-${this._tracker.knownWindows.length - 1})`
            }
        }

        const slot = this._tracker.knownWindows[slotIndex]
        const wm_class = slot.props?.wm_class || 'unknown'
        const title = slot.props?.title || 'untitled'

        // Remove the slot
        this._tracker.knownWindows.splice(slotIndex, 1)

        // Trigger save via state change callback
        this._tracker.notifyStateChange()

        debug('session', `removed slot ${slotIndex}: ${wm_class}:"${title}"`)

        return {
            success: true,
            wm_class: wm_class,
            title: title
        }
    }

}

/**
 * Create file-based state storage callbacks.
 *
 * @param {string} filePath - Absolute path to state file
 * @returns {Object} Object with stateLoader and stateSaver functions
 */
export function createFileStorage(filePath) {
    return {
        stateLoader: () => {
            try {
                const file = Gio.File.new_for_path(filePath)
                if (file.query_exists(null)) {
                    const [success, contents] = file.load_contents(null)
                    if (success) {
                        const state = JSON.parse(new TextDecoder().decode(contents))
                        debug('state', `loaded state from ${filePath}`)
                        return state
                    }
                }
            } catch (e) {
                debug('state', `error loading state from ${filePath}: ${e.message}`, true)
            }
            return null
        },
        stateSaver: (state) => {
            try {
                const file = Gio.File.new_for_path(filePath)
                const contents = JSON.stringify(state, null, 2)
                file.replace_contents(contents, null, false, Gio.FileCreateFlags.NONE, null)
                debug('state', `saved state to ${filePath}`)
            } catch (e) {
                debug('state', `error saving state to ${filePath}: ${e.message}`, true)
            }
        },
    }
}

/**
 * Create GSettings-based state storage callbacks.
 *
 * @param {Gio.Settings} settings - GSettings instance
 * @param {string} key - Settings key to store state (default: 'window-state')
 * @returns {Object} Object with stateLoader and stateSaver functions
 */
export function createGSettingsStorage(settings, key = 'window-state') {
    return {
        stateLoader: () => {
            try {
                const json = settings.get_string(key)
                if (json) {
                    const state = JSON.parse(json)
                    debug('state', `loaded state from GSettings key '${key}'`)
                    return state
                }
            } catch (e) {
                debug('state', `error loading state from GSettings: ${e.message}`, true)
            }
            return null
        },
        stateSaver: (state) => {
            try {
                settings.set_string(key, JSON.stringify(state))
                debug('state', `saved state to GSettings key '${key}'`)
            } catch (e) {
                debug('state', `error saving state to GSettings: ${e.message}`, true)
            }
        },
    }
}

export class OperationHandler {
    constructor(executor, operationFilter = null, config = {}) {
        this._executor = executor
        this._operationFilter = operationFilter
        this._config = config
        this._timeoutManager = new TimeoutManager()
        // Track pending workspace/monitor moves: winid -> { operations: [], timeoutId: null, targetWorkspace/Monitor: value }
        this._pendingMoves = new Map()
    }

    destroy() {
        this._timeoutManager.removeAll()
        this._pendingMoves.clear()
    }

    processTrackerResult(result) {
        // Print tracker events
        if (result.events && result.events.length > 0) {
            for (const event of result.events) {
                this._printTrackerEvent(event)
                // Check for workspace/monitor change completion
                this._checkMoveCompletion(event)
            }
        }

        // Execute proposed operations
        if (result.operations && result.operations.length > 0) {
            this._executeOperations(result.operations)
        }
    }

    _checkMoveCompletion(event) {
        // Check if this event indicates a workspace move completed
        if (event.type !== 'window.modified') return

        const winid = event.winid
        if (!this._pendingMoves.has(winid)) return

        const pending = this._pendingMoves.get(winid)
        const details = event.details

        // Check if workspace changed to target value
        if (pending.targetWorkspace !== undefined && details.workspace === pending.targetWorkspace) {
            debug('executor', `workspace-changed detected for window ${winid}, scheduling queued operations`)

            if (pending.timeoutId) {
                this._timeoutManager.remove(pending.timeoutId)
                pending.timeoutId = null
            }

            // Add a short delay to allow animation/layout to settle
            // GNOME Shell needs a moment after workspace property change before geometry updates (like Place)
            // stick correctly, especially if activation/animation is involved.
            pending.timeoutId = this._timeoutManager.add(
                GLib.PRIORITY_DEFAULT,
                this._config.OPERATION_SETTLE_DELAY_MS || 200,
                () => {
                    debug('executor', `executing queued operations for window ${winid} after settle delay`)
                    this._executePendingOperations(winid)
                    return GLib.SOURCE_REMOVE
                }
            )
        }
    }

    _executePendingOperations(winid) {
        if (!this._pendingMoves.has(winid)) return

        const pending = this._pendingMoves.get(winid)

        if (pending.timeoutId) {
            this._timeoutManager.remove(pending.timeoutId)
        }

        // Ensure target workspace is active before executing Place operations.
        // This is necessary because other windows may have activated different workspaces
        // since we deferred these operations, and move_resize_frame() doesn't work
        // reliably on non-visible workspaces.
        if (pending.targetWorkspace !== undefined && this._executor?.activateWorkspace) {
            this._executor.activateWorkspace(pending.targetWorkspace)
        }

        // Execute queued operations
        for (const op of pending.operations) {
            debug('tracker', 'executing deferred operation ' + op.description)
            this._executeOperation(op)
        }

        this._pendingMoves.delete(winid)

        // Notify matcher that all operations are complete for this window
        if (this._tracker) {
            this._tracker.onOperationsComplete(winid)
        }
    }

    _executeOperations(operations) {
        let i = 0
        const windowsWithOps = new Set() // Track which windows had operations

        while (i < operations.length) {
            const op = operations[i]

            if (this._operationFilter && !this._operationFilter(op)) {
                debug('tracker', 'skipping operation (filtered): ' + op.description)
                i++
                continue
            }

            windowsWithOps.add(op.winid) // Track this window

            // Check if this is a workspace move (defer subsequent ops)
            // Note: MoveToMonitor no longer defers - execute all ops immediately
            // and let drift detection handle any issues
            if (op.type === 'MoveToWorkspace') {
                const winid = op.winid
                const targetValue = op.args[0]

                // Execute the move operation immediately
                debug('tracker', 'executing operation ' + op.description)
                this._executeOperation(op)

                // Collect subsequent operations for this window
                const queuedOps = []
                i++
                while (i < operations.length && operations[i].winid === winid) {
                    queuedOps.push(operations[i])
                    i++
                }

                // Defer operations until workspace change event arrives
                if (queuedOps.length > 0) {
                    const pending = {
                        operations: queuedOps,
                        timeoutId: null,
                        targetWorkspace: targetValue
                    }

                    pending.timeoutId = this._timeoutManager.add(
                        GLib.PRIORITY_DEFAULT,
                        this._config.WORKSPACE_SETTLE_TIMEOUT || 500,
                        () => {
                            debug('executor', `workspace change timeout for window ${winid}, executing queued operations anyway`)
                            this._executePendingOperations(winid)
                            return GLib.SOURCE_REMOVE
                        }
                    )

                    this._pendingMoves.set(winid, pending)
                    debug('tracker', `deferring ${queuedOps.length} operation(s) for window ${winid} until workspace change completes`)
                }
            } else {
                // Regular operation - execute immediately
                debug('tracker', 'executing operation ' + op.description)
                this._executeOperation(op)
                i++
            }
        }

        // Notify matcher that operations are complete for windows without pending moves
        for (const winid of windowsWithOps) {
            if (!this._pendingMoves.has(winid) && this._tracker) {
                this._tracker.onOperationsComplete(winid)
            }
        }
    }

    _printTrackerEvent(event) {
        let message = event.type + ': ' + event.winid

        switch (event.type) {
            case 'window.destroyed':
                // No additional data needed
                break
            case 'window.modified':
                message += ' (' + event.eventName + ') ' + JSON.stringify(event.details)
                break
            case 'window.title_became_specific':
                message += " '" + event.oldTitle + "' -> '" + event.newTitle + "'"
                break
            case 'window.pending_decision':
                const d = event.debug
                message +=
                    ' waiting: idle=' +
                    d.isIdle +
                    ' timeout=' +
                    d.isTimedOut +
                    ' timeSince=' +
                    d.timeSinceLastUpdate +
                    'ms title=' +
                    d.title
                break
            case 'known.match':
                message +=
                    ' *known* ' + JSON.stringify(event.knownProps) + ' *active* ' + JSON.stringify(event.activeDetails)
                break
            case 'known.new':
                message += ' ' + JSON.stringify(event.details)
                break
        }

        debug('tracker', message)
    }

    _executeOperation(operation) {
        if (!this._executor) {
            debug('executor', 'cannot execute operation: no executor configured', true)
            return
        }

        try {
            const { type, winid, args } = operation

            switch (type) {
                case 'MoveToWorkspace':
                    this._executor.moveToWorkspace(winid, args[0])
                    break
                case 'MoveToMonitor':
                    this._executor.moveToMonitor(winid, args[0])
                    break
                case 'Place':
                    // Activate the window's workspace before placing, as move_resize_frame()
                    // doesn't work reliably on non-visible workspaces
                    if (this._executor.activateWorkspace && this._executor.getDetails) {
                        try {
                            const details = this._executor.getDetails(winid)
                            if (details && details.workspace !== undefined) {
                                this._executor.activateWorkspace(details.workspace)
                            }
                        } catch (e) {
                            // Window may have been destroyed, continue anyway
                        }
                    }
                    this._executor.place(winid, args[0], args[1], args[2], args[3])
                    break
                case 'Move':
                    this._executor.move(winid, args[0], args[1])
                    break
                case 'Maximize':
                    this._executor.maximize(winid, args[0])
                    break
                case 'Minimize':
                    this._executor.minimize(winid)
                    break
                case 'Unmaximize':
                    this._executor.unmaximize(winid)
                    break
                case 'Close':
                    const isForced = args.length > 0 ? args[0] : false
                    this._executor.close(winid, isForced)
                    break
                case 'SetFullscreen':
                    this._executor.setFullscreen(winid, args[0])
                    break
                case 'ToggleFullscreen':
                    this._executor.toggleFullscreen(winid)
                    break
                case 'SetOnAllWorkspaces':
                    this._executor.setOnAllWorkspaces(winid, args[0])
                    break
                case 'SetAbove':
                    this._executor.setAbove(winid, args[0])
                    break
                default:
                    debug('executor', 'unknown operation type: ' + type, true)
                    return
            }
            debug('executor', 'operation completed: ' + operation.description)
        } catch (error) {
            debug('executor', 'failed to execute operation: ' + error.message, true)
            debug('executor', 'operation was: ' + operation.description, true)
        }
    }
}
