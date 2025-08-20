// Window state tracking and matching module

import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import { debug, TimeoutManager } from './utils.js'
import {
    MAXIMIZED_NONE,
    MAXIMIZED_HORIZONTAL,
    MAXIMIZED_VERTICAL,
    MAXIMIZED_BOTH,
    EXTRACTION_PROPS,
    isValidGeometry,
    shouldTrackWindow,
    isNormalWindow,
    shouldDebounceEvent
} from './window-state.js'

const DEFAULT_CONFIG = {
    // Timing
    SETTLE_IDLE_TIMEOUT: 500, // ms
    SETTLE_MAX_WAIT: 2500, // ms
    MIN_IDLE_TIME_BEFORE_MATCH: 300, // ms
    GENERIC_TITLE_EXTENDED_WAIT: 15000, // ms
    WORKSPACE_SETTLE_TIMEOUT: 250, // ms - max time to wait for workspace/monitor change event
    DRIFT_DETECTION_WINDOW: 500, // ms - only detect drift within this window after monitors-changed
    SERIALIZE_INTERVAL_MS: 1000,

    // Score calculation
    MIN_SCORE_SPREAD: 0.6,
    AMBIGUOUS_SIMILARITY_THRESHOLD: 0.95,
    TITLE_SIMILARITY_MAX_DIST: 2.0, // Max histogram distance for normalization
    SPECIFIC_MATCH_BOOST: 1.1, // Score multiplier for specific-to-specific matches

    // Title heuristics
    MIN_TITLE_LEN_FOR_PENALTY: 8,
    TITLE_LEN_PENALTY_RATIO: 0.5,
    TITLE_LEN_PENALTY_FACTOR: 0.5,
    MIN_SPECIFIC_TITLE_LENGTH: 15,
    TITLE_CHANGE_SIGNIFICANCE_RATIO: 2.0,

    // Debug sampling
    DEBUG_PENDING_SAMPLE_RATE: 0.1, // 10% chance to show pending decision debug info

    // Defaults
    WINDOW_STATE_PATH: 'window_control_state.json',
    OVERRIDES: {},
    DEFAULT_SYNC_MODE: 'RESTORE',
    DEFAULT_MATCH_THRESHOLD: 0.8,

    // Property configuration
    SIGNIFICANT_PROPS: ['title', 'wm_class'],
    MANAGED_PROPS: [
        'monitor',
        'workspace',
        'frame_rect',
        'minimized',
        'maximized',
        'fullscreen',
        'on_all_workspaces',
        'above',
    ],
}

// Character set for title similarity calculation
const ALL_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~ '
const CHAR_TO_IDX = {}
for (let i = 0; i < ALL_CHARS.length; i++) {
    CHAR_TO_IDX[ALL_CHARS[i]] = i
}

// Window state machine states
const WindowState = {
    PENDING: 'PENDING',       // Waiting for title to become specific
    RESTORING: 'RESTORING',   // Executing operations, ignore events
    SETTLING: 'SETTLING',     // Waiting for window to stabilize
    TRACKING: 'TRACKING',     // Actively tracking user changes
}

/**
 * Represents the state of a window in the state machine
 */
class WindowStateInfo {
    constructor(winid, state = WindowState.PENDING) {
        this.winid = winid
        this.state = state
        this.transitionTime = Date.now()
        this.lastEventTime = Date.now()
        this.settleTimeoutId = null
        this.targetConfig = null    // What we're trying to achieve in RESTORING
        this.details = null          // Last observed window details
        this.driftRetries = 0        // Count drift correction attempts
    }
}

const MAX_DRIFT_RETRIES = 3

class WindowStateMatcher {
    /**
     * @param {Object} options - Configuration options
     * @param {Function} options.onProcessing - Callback for async processing results
     * @param {Function} options.onStateChange - Callback when state changes (for persistence)
     * @param {Object} options.config - Override default configuration
     * @param {Array} options.initialState - Initial state to restore
     * @param {Function} options.actorQuery - Callback to query current window actors
     * @param {boolean} options.preserveOccupied - Preserve occupied status from saved state
     * @param {Function} options.policy - Custom policy callback for window tracking
     * @param {Function} options.getMonitorCount - Callback to get current monitor count: () => number
     */
    constructor({
        onProcessing = null,
        onStateChange = null,
        config = {},
        initialState = null,
        actorQuery = null,
        preserveOccupied = false,
        policy = null,
        getMonitorCount = null,
    } = {}) {
        this._config = { ...DEFAULT_CONFIG, ...config }

        this._windowStates = new Map() // winid -> WindowStateInfo
        this.knownWindows = [] // Array of {occupied: winid|null, props: windowDetails}
        this.lastMessageTime = null
        this.processingTimeoutId = null
        this._timeoutManager = new TimeoutManager()
        this.onProcessingCallback = onProcessing
        this.onStateChangeCallback = onStateChange
        this.actorQueryCallback = actorQuery
        this.preserveOccupiedState = preserveOccupied
        this.policyCallback = policy
        this.getMonitorCountCallback = getMonitorCount
        this._suppressStateNotify = false

        // Restore initial state if provided
        if (initialState) {
            this.restoreFromState(initialState)
        }

        // Query current actors if callback is provided
        if (this.actorQueryCallback) {
            const result = this.updateFromCurrentActors()
            // Pass results to callback for stat tracking
            if (result && (result.operations.length > 0 || result.events.length > 0) && this.onProcessingCallback) {
                this.onProcessingCallback(result)
            }
        }

        this.startProcessingTimer()
    }

    destroy() {
        this._timeoutManager.removeAll()
        this.processingTimeoutId = null
        this._windowStates.clear()
    }

    // Window state machine management

    /**
     * Get or create window state
     */
    _getWindowState(winid) {
        if (!this._windowStates.has(winid)) {
            this._windowStates.set(winid, new WindowStateInfo(winid))
        }
        return this._windowStates.get(winid)
    }

    /**
     * Transition window to a new state
     */
    _transitionState(winid, newState, details = null, reason = '') {
        const state = this._getWindowState(winid)
        const oldState = state.state

        if (oldState === newState) {
            return // No transition needed
        }

        const reasonStr = reason ? ` (${reason})` : ''
        const targetStr = state.targetConfig ? ` target: monitor=${state.targetConfig.monitor} workspace=${state.targetConfig.workspace}` : ''
        debug('state', `window ${winid} transition: ${oldState} → ${newState}${reasonStr}${targetStr}`)

        // Cancel any existing settle timer
        this._cancelSettleTimer(state)

        state.state = newState
        state.transitionTime = Date.now()
        state.lastEventTime = Date.now()
        if (details) {
            state.details = details
        }

        // Handle state-specific logic
        switch (newState) {
            case WindowState.SETTLING:
                // Start settle timer
                debug('state', `window ${winid} settling: will check drift in ${this._config.DRIFT_DETECTION_WINDOW}ms`)
                this._startSettleTimer(winid, state)
                break
            case WindowState.TRACKING:
                // Clear target config when entering tracking
                state.targetConfig = null
                break
        }
    }

    /**
     * Start settle timer for a window
     */
    _startSettleTimer(winid, state) {
        const settleTimeout = this._config.DRIFT_DETECTION_WINDOW

        state.settleTimeoutId = this._timeoutManager.add(GLib.PRIORITY_DEFAULT, settleTimeout, () => {
            state.settleTimeoutId = null
            this._onSettleTimeout(winid, state)
            return GLib.SOURCE_REMOVE
        })
    }

    /**
     * Cancel settle timer for a window
     */
    _cancelSettleTimer(state) {
        if (state.settleTimeoutId) {
            this._timeoutManager.remove(state.settleTimeoutId)
            state.settleTimeoutId = null
        }
    }

    /**
     * Handle settle timeout - window has stabilized
     */
    _onSettleTimeout(winid, state) {
        debug('state', `window ${winid} settle timeout, checking final state`)

        // If we have a target config, check if window settled correctly
        if (state.targetConfig && state.details) {
            const needsCorrection = this._checkNeedsCorrection(winid, state.details, state.targetConfig)
            if (needsCorrection) {
                // Check retry limit
                if (state.driftRetries >= MAX_DRIFT_RETRIES) {
                    debug('state', `window ${winid} drift correction failed after ${MAX_DRIFT_RETRIES} attempts, giving up`)
                    state.driftRetries = 0
                    this._transitionState(winid, WindowState.TRACKING, state.details, 'drift correction limit reached')
                    return
                }

                state.driftRetries++
                debug('state', `window ${winid} settled incorrectly, correcting drift (attempt ${state.driftRetries}/${MAX_DRIFT_RETRIES})`)

                // Transition to RESTORING to correct drift
                const occupiedSlots = this.findOccupiedSlots(winid)
                if (occupiedSlots.length > 0) {
                    const policy = this.getPolicyForWindow(occupiedSlots[0].props)
                    const operations = this.generateRestoreOperations(winid, state.details, occupiedSlots[0].props, policy)
                    if (operations.length > 0) {
                        this._transitionState(winid, WindowState.RESTORING, state.details, 'drift detected during settle')
                        if (this.onProcessingCallback) {
                            this.onProcessingCallback({
                                operations,
                                events: [{
                                    type: 'window.drift_corrected',
                                    winid,
                                    details: state.details,
                                    attempt: state.driftRetries
                                }]
                            })
                        }
                        return // Will transition to SETTLING after operations complete
                    }
                }
            }
        }

        // Window settled correctly or no target to check - reset retry counter
        state.driftRetries = 0
        this._transitionState(winid, WindowState.TRACKING, state.details, 'settled successfully')
    }

    /**
     * Check if window needs correction based on target config
     */
    _checkNeedsCorrection(winid, currentDetails, targetConfig) {
        // Check monitor
        if (targetConfig.monitor !== undefined && currentDetails.monitor !== targetConfig.monitor) {
            debug('state', `window ${winid} drift: monitor ${currentDetails.monitor} != ${targetConfig.monitor}`)
            return true
        }

        // Skip workspace drift check if window is on all workspaces
        // (workspace number is meaningless for such windows)
        const isOnAllWorkspaces = currentDetails.on_all_workspaces || targetConfig.on_all_workspaces
        if (!isOnAllWorkspaces &&
            targetConfig.workspace !== undefined &&
            currentDetails.workspace !== targetConfig.workspace) {
            debug('state', `window ${winid} drift: workspace ${currentDetails.workspace} != ${targetConfig.workspace}`)
            return true
        }

        // Check maximized state
        if (targetConfig.maximized !== undefined && currentDetails.maximized !== targetConfig.maximized) {
            debug('state', `window ${winid} drift: maximized ${currentDetails.maximized} != ${targetConfig.maximized}`)
            return true
        }

        // Check frame_rect for non-fully-maximized windows
        // (fully maximized windows fill the screen, position doesn't matter)
        if (targetConfig.maximized !== MAXIMIZED_BOTH &&
            targetConfig.frame_rect && currentDetails.frame_rect) {
            const target = targetConfig.frame_rect
            const current = currentDetails.frame_rect
            // Allow small tolerance (10px) for position drift
            const tolerance = 10
            if (Math.abs(current.x - target.x) > tolerance ||
                Math.abs(current.y - target.y) > tolerance) {
                debug('state', `window ${winid} drift: position (${current.x},${current.y}) != (${target.x},${target.y})`)
                return true
            }
        }

        return false
    }

    /**
     * Cleanup window state when destroyed
     */
    _cleanupWindowState(winid) {
        const state = this._windowStates.get(winid)
        if (state) {
            this._cancelSettleTimer(state)
            this._windowStates.delete(winid)
        }
    }

    /**
     * Signal that operations have completed for a window
     * Call this after executing restore operations to transition to SETTLING
     */
    onOperationsComplete(winid) {
        const state = this._windowStates.get(winid)
        if (state && state.state === WindowState.RESTORING) {
            this._transitionState(winid, WindowState.SETTLING, null, 'operations complete')
        }
    }

    // Window state persistence
    deepCopyProps(props) {
        return {
            ...props,
            // Deep copy configs array
            configs: props.configs ? props.configs.map(cfg => ({ ...cfg })) : []
        }
    }

    getSerializableState() {
        return this.knownWindows.map((w) => ({
            occupied: w.occupied,
            props: this.deepCopyProps(w.props),
            seen: w.seen,
        }))
    }

    restoreFromState(windowsState) {
        if (!Array.isArray(windowsState)) {
            this.knownWindows = []
            return
        }

        // Restore windows, optionally preserving occupied state
        this.knownWindows = windowsState.map((w) => ({
            occupied: this.preserveOccupiedState ? (w.occupied || null) : null,
            props: this.deepCopyProps(w.props),
            seen: w.seen || 0, // Use stored seen or 0 (epoch) for old entries
        }))
        // Don't save immediately after restoration - state was just loaded
    }

    notifyStateChange() {
        if (this._suppressStateNotify) return
        if (this.onStateChangeCallback) {
            this.onStateChangeCallback(this.getSerializableState())
        }
    }

    startProcessingTimer() {
        if (this.processingTimeoutId) {
            this._timeoutManager.remove(this.processingTimeoutId)
        }

        this.processingTimeoutId = this._timeoutManager.add(GLib.PRIORITY_DEFAULT, 200, () => {
            // Check if there are any windows in PENDING state
            const hasPendingWindows = Array.from(this._windowStates.values())
                .some(state => state.state === WindowState.PENDING)

            if (hasPendingWindows) {
                const result = this.processPendingWindows()
                if (result && (result.events.length > 0 || result.operations.length > 0) && this.onProcessingCallback) {
                    this.onProcessingCallback(result)
                }
            }
            this.startProcessingTimer() // Restart timer
            return GLib.SOURCE_REMOVE
        })
    }

    // Utility functions
    extractCoreDetails(details) {
        const props = [...this._config.SIGNIFICANT_PROPS, ...this._config.MANAGED_PROPS]
        const result = {}
        for (let key of props) {
            if (key in details) {
                result[key] = details[key]
            }
        }
        return result
    }

    isLikelyGenericTitle(title) {
        if (!title) return true
        return title.length < this._config.MIN_SPECIFIC_TITLE_LENGTH
    }

    hasTitleBecomeMoreSpecific(oldTitle, newTitle) {
        if (!oldTitle || !newTitle) return false
        return newTitle.length >= oldTitle.length * this._config.TITLE_CHANGE_SIGNIFICANCE_RATIO
    }

    // Title similarity calculation using character histograms
    titleToHist(title) {
        if (!title) return new Array(ALL_CHARS.length).fill(0)

        const hist = new Array(ALL_CHARS.length).fill(0)
        for (let char of title) {
            if (char in CHAR_TO_IDX) {
                hist[CHAR_TO_IDX[char]]++
            }
        }

        // Normalize
        for (let i = 0; i < hist.length; i++) {
            hist[i] /= title.length
        }

        return hist
    }

    // Multi-monitor configuration helpers
    getBestConfigForMonitors(configs, availableMonitors) {
        if (!configs || configs.length === 0) return null

        // Filter configs where monitor is available
        const availableConfigs = configs.filter(cfg =>
            cfg.monitor !== undefined && availableMonitors.includes(cfg.monitor)
        )

        if (availableConfigs.length === 0) return null

        // Prefer highest monitor index (external monitors over built-in)
        availableConfigs.sort((a, b) => b.monitor - a.monitor)

        return availableConfigs[0]
    }

    updateOrAddConfig(props, newStateProps) {
        // Ensure configs array exists
        if (!props.configs) {
            props.configs = []
        }

        // Find existing config for this monitor
        const monitor = newStateProps.monitor
        let existingConfig = null

        if (monitor !== undefined) {
            existingConfig = props.configs.find(cfg => cfg.monitor === monitor)
        }

        // Extract state properties
        const stateProps = {}
        for (let key of this._config.MANAGED_PROPS) {
            if (key in newStateProps) {
                stateProps[key] = newStateProps[key]
            }
        }

        if (existingConfig) {
            // Update existing config
            Object.assign(existingConfig, stateProps)
        } else {
            // Add new config
            props.configs.push(stateProps)
        }

        // Update identity properties at top level
        for (let key of this._config.SIGNIFICANT_PROPS) {
            if (key in newStateProps) {
                props[key] = newStateProps[key]
            }
        }
    }

    compareDetails(details1, details2) {
        if (details1.wm_class !== details2.wm_class) {
            return 0.0
        }

        const title1 = details1.title || ''
        const title2 = details2.title || ''

        if (title1 === title2) {
            return 1.0
        }

        const hist1 = this.titleToHist(title1)
        const hist2 = this.titleToHist(title2)

        // Calculate histogram difference (Manhattan distance)
        let dist = 0
        for (let i = 0; i < hist1.length; i++) {
            dist += Math.abs(hist1[i] - hist2[i])
        }

        // Distance is between 0 and maxDist (maximum when histograms are completely different)
        const score = Math.max(0, 1 - dist / this._config.TITLE_SIMILARITY_MAX_DIST)

        return score
    }

    /**
     * Find the best matching override rule for a window.
     * Priority: exact title match > generic rule (no title) > null
     */
    _findMatchingOverride(overrides, title) {
        if (!overrides) return null
        if (!Array.isArray(overrides)) return overrides

        // Exact title match has highest priority
        const exactMatch = overrides.find((r) => r.title === title)
        if (exactMatch) return exactMatch

        // Generic rule (no title constraint) is fallback
        return overrides.find((r) => r.title === undefined || r.title === null) || null
    }

    // Window matching logic
    getPolicyForWindow(details) {
        const wmClass = details.wm_class
        const title = details.title || ''

        const defaults = {
            action: this._config.DEFAULT_SYNC_MODE,
            threshold: this._config.DEFAULT_MATCH_THRESHOLD,
            matchProperties: null,
        }

        if (!wmClass || !this._config.OVERRIDES?.[wmClass]) {
            return defaults
        }

        const matchedRule = this._findMatchingOverride(this._config.OVERRIDES[wmClass], title)
        if (!matchedRule) {
            return defaults
        }

        return {
            action: matchedRule.action ?? defaults.action,
            threshold: matchedRule.threshold ?? defaults.threshold,
            matchProperties: matchedRule.match_properties ?? defaults.matchProperties,
        }
    }

    calculateWindowScore(pendingDetails, knownWindow) {
        let score = this.compareDetails(pendingDetails, knownWindow.props)

        // Don't apply penalties to perfect matches
        if (score === 1.0) {
            return score
        }

        const pendingTitle = pendingDetails.title || ''
        const knownTitle = knownWindow.props.title || ''

        // Penalize if pending title is much shorter than known title
        if (
            knownTitle.length > this._config.MIN_TITLE_LEN_FOR_PENALTY &&
            pendingTitle.length < knownTitle.length * this._config.TITLE_LEN_PENALTY_RATIO
        ) {
            score *= this._config.TITLE_LEN_PENALTY_FACTOR
        }

        // Boost score for specific-to-specific matches
        const pendingIsSpecific = !this.isLikelyGenericTitle(pendingTitle)
        const knownIsSpecific = !this.isLikelyGenericTitle(knownTitle)
        if (pendingIsSpecific && knownIsSpecific) {
            score *= this._config.SPECIFIC_MATCH_BOOST
        }

        return score
    }

    calculateScoresForWindow(pendingDetails) {
        const pendingTitle = pendingDetails.title || ''
        const unoccupiedKnownWindows = this.knownWindows.filter((w) => !w.occupied)

        const scores = unoccupiedKnownWindows.map((w) => ({
            score: this.calculateWindowScore(pendingDetails, w),
            window: w,
            exactTitle: pendingTitle === (w.props.title || ''),
        }))

        // Sort by exact title match (desc), then by score (desc)
        scores.sort((a, b) => (b.exactTitle - a.exactTitle) || (b.score - a.score))
        return scores
    }

    // Ambiguity detection
    groupPendingWindowsByClass() {
        const pendingByWmClass = {}
        for (let [winid, state] of this._windowStates) {
            if (state.state === WindowState.PENDING && state.details) {
                const wmClass = state.details.wm_class
                if (wmClass) {
                    if (!(wmClass in pendingByWmClass)) {
                        pendingByWmClass[wmClass] = []
                    }
                    pendingByWmClass[wmClass].push(state.details)
                }
            }
        }
        return pendingByWmClass
    }

    checkWindowsAmbiguity(windows) {
        if (windows.length <= 1) return false

        const hasGenericTitles = windows.some((w) => this.isLikelyGenericTitle(w.title || ''))
        const similarityThreshold = hasGenericTitles ? 0.99 : this._config.AMBIGUOUS_SIMILARITY_THRESHOLD

        for (let i = 0; i < windows.length; i++) {
            for (let j = i + 1; j < windows.length; j++) {
                if (this.compareDetails(windows[i], windows[j]) < similarityThreshold) {
                    return false
                }
            }
        }
        return true
    }

    findAmbiguousWmClasses() {
        const pendingByWmClass = this.groupPendingWindowsByClass()
        const ambiguousWmClasses = new Set()

        for (let [wmClass, windows] of Object.entries(pendingByWmClass)) {
            if (this.checkWindowsAmbiguity(windows)) {
                ambiguousWmClasses.add(wmClass)
            }
        }

        return ambiguousWmClasses
    }

    // Check if window has an exact match (perfect score)
    hasExactMatch(pendingDetails) {
        const unoccupiedKnownWindows = this.knownWindows.filter((w) => !w.occupied)

        for (let w of unoccupiedKnownWindows) {
            // Check for exact title and wm_class match
            if (
                pendingDetails.wm_class === w.props.wm_class &&
                (pendingDetails.title || '') === (w.props.title || '')
            ) {
                return true
            }
        }
        return false
    }

    // Decision making
    shouldDecideOnWindow(windowState, currentTime, isTimedOut) {
        const details = windowState.details
        const timeSinceLastUpdate = currentTime - windowState.lastEventTime
        const isIdle = timeSinceLastUpdate > this._config.SETTLE_IDLE_TIMEOUT
        const hasBeenIdleLongEnough = timeSinceLastUpdate > this._config.MIN_IDLE_TIME_BEFORE_MATCH

        const currentTitle = details.title || ''
        const titleIsStable = !this.isLikelyGenericTitle(currentTitle)

        // Fast path for exact matches - no need to wait
        const hasExactMatch = this.hasExactMatch(details)
        if (hasExactMatch) {
            return {
                decide: true,
                debug: {
                    timeSinceLastUpdate,
                    isIdle,
                    hasBeenIdleLongEnough,
                    isTimedOut,
                    titleIsStable,
                    title: currentTitle,
                    exactMatch: true,
                },
            }
        }

        // Return decision info for debugging
        const decision = titleIsStable ? isIdle || (hasBeenIdleLongEnough && isTimedOut) : isTimedOut || isIdle

        return {
            decide: decision,
            debug: {
                timeSinceLastUpdate,
                isIdle,
                hasBeenIdleLongEnough,
                isTimedOut,
                titleIsStable,
                title: currentTitle,
                exactMatch: false,
            },
        }
    }

    /**
     * Add pre-condition operations needed before the main operation
     * For example, unmaximize before move/place/maximize operations
     * @param {Object} operation - The operation to check
     * @param {Object} currentDetails - Current window state
     * @returns {Array} Array of operations (pre-conditions + original)
     */
    addOperationPreConditions(operation, currentDetails) {
        const operations = []
        const isMaximized = currentDetails.maximized && currentDetails.maximized !== MAXIMIZED_NONE

        // Unmaximize before placing, but only for fully maximized windows
        // Tiled windows (HORIZONTAL or VERTICAL only) can be repositioned without unmaximizing
        const isFullyMaximized = currentDetails.maximized === MAXIMIZED_BOTH
        if (operation.type === 'Place' && isFullyMaximized) {
            operations.push({
                type: 'Unmaximize',
                winid: operation.winid,
                args: [],
                description: `Unmaximize window ${operation.winid} before placing`,
            })
        }

        // Unmaximize before moving (position or monitor)
        if ((operation.type === 'Move' || operation.type === 'MoveToMonitor') && isMaximized) {
            operations.push({
                type: 'Unmaximize',
                winid: operation.winid,
                args: [],
                description: `Unmaximize window ${operation.winid} before moving`,
            })
        }

        // Unmaximize before changing maximize state (GNOME doesn't handle transitions well)
        // e.g., MAXIMIZED_BOTH -> MAXIMIZED_VERTICAL requires unmaximize first
        if (operation.type === 'Maximize' && isMaximized) {
            const targetMaximize = operation.args[0]
            // Only add unmaximize if actually changing to a different state
            if (currentDetails.maximized !== targetMaximize) {
                operations.push({
                    type: 'Unmaximize',
                    winid: operation.winid,
                    args: [],
                    description: `Unmaximize window ${operation.winid} before changing maximize state`,
                })
            }
        }

        // Add the original operation
        operations.push(operation)

        return operations
    }

    /**
     * Expand a list of operations by adding necessary pre-conditions
     * @param {Array} operations - List of operations
     * @param {Object} currentDetails - Current window state
     * @returns {Array} Expanded list of operations
     */
    expandOperations(operations, currentDetails) {
        const expanded = []
        // Track effective maximized state to avoid adding unnecessary Unmaximize preconditions
        // e.g., after Maximize(2), don't Unmaximize before Place
        let effectiveMaximized = currentDetails.maximized

        for (const op of operations) {
            const effectiveDetails = { ...currentDetails, maximized: effectiveMaximized }
            expanded.push(...this.addOperationPreConditions(op, effectiveDetails))

            // Update effective state based on operation
            if (op.type === 'Maximize') {
                effectiveMaximized = op.args[0]
            } else if (op.type === 'Unmaximize') {
                effectiveMaximized = MAXIMIZED_NONE
            }
        }
        return expanded
    }

    /**
     * Get the best available config for a window based on current monitor setup.
     * Prefers higher monitor indices (external monitors over built-in).
     * @param {Object} knownProps - Window props containing configs array
     * @returns {Object|null} Best available config, or null if none available
     */
    getBestAvailableConfig(knownProps) {
        if (!knownProps.configs || !Array.isArray(knownProps.configs) || knownProps.configs.length === 0) {
            return knownProps // Legacy: no configs array, use props directly
        }

        const monitorCount = this.getMonitorCountCallback?.() ?? 1
        const availableConfigs = knownProps.configs.filter(cfg =>
            cfg.monitor !== undefined && cfg.monitor >= 0 && cfg.monitor < monitorCount
        )

        if (availableConfigs.length === 0) {
            return null
        }

        // Prefer highest available monitor index (external monitors over built-in)
        availableConfigs.sort((a, b) => (b.monitor || 0) - (a.monitor || 0))
        return availableConfigs[0]
    }

    /**
     * Check if two configs are equivalent for the purpose of skipping duplicate operations.
     */
    configsAreEquivalent(configA, configB) {
        if (!configA || !configB) return false
        if (configA.monitor !== configB.monitor) return false
        if (!configA.frame_rect || !configB.frame_rect) return configA.monitor === configB.monitor
        return (
            configA.frame_rect.x === configB.frame_rect.x &&
            configA.frame_rect.y === configB.frame_rect.y &&
            configA.frame_rect.width === configB.frame_rect.width &&
            configA.frame_rect.height === configB.frame_rect.height
        )
    }

    // Operation generation
    generateRestoreOperations(winid, currentDetails, knownProps, policy = null) {
        const operations = []

        if (policy && policy.action === 'IGNORE') {
            return operations
        }

        const isAllowed = (prop) => {
            if (!policy || !policy.matchProperties) return true
            return policy.matchProperties.includes(prop)
        }

        // Get best config for current monitor setup
        const targetConfig = this.getBestAvailableConfig(knownProps)
        if (!targetConfig) {
            return operations
        }

        // Track if we're doing a monitor move - we'll need to re-maximize after if target is maximized
        let needsMonitorMove = false

        // Check monitor FIRST - must move to correct monitor before changing workspace
        // This ensures the workspace move happens on the target monitor where we know the workspace exists
        if (
            isAllowed('monitor') &&
            targetConfig.monitor !== undefined &&
            currentDetails.monitor !== targetConfig.monitor
        ) {
            needsMonitorMove = true
            operations.push({
                type: 'MoveToMonitor',
                winid: winid,
                args: [targetConfig.monitor],
                description: `Move window ${winid} to monitor ${targetConfig.monitor}`,
            })
        }

        // Check workspace AFTER monitor - workspace must be set on the correct monitor
        if (
            isAllowed('workspace') &&
            targetConfig.workspace !== undefined &&
            currentDetails.workspace !== targetConfig.workspace
        ) {
            operations.push({
                type: 'MoveToWorkspace',
                winid: winid,
                args: [targetConfig.workspace],
                description: `Move window ${winid} to workspace ${targetConfig.workspace}`,
            })
        }

        // Check maximized state BEFORE frame_rect for tiled windows
        // For tiled windows, we need to Maximize first, then Place to set final position
        // (GNOME's maximize overrides position, so Place must come after)
        const needsMaximizeAfterMonitorMove = needsMonitorMove &&
            isAllowed('maximized') &&
            targetConfig.maximized !== undefined &&
            targetConfig.maximized > 0

        const isTiled = targetConfig.maximized === MAXIMIZED_HORIZONTAL ||
            targetConfig.maximized === MAXIMIZED_VERTICAL

        if (
            isAllowed('maximized') &&
            targetConfig.maximized !== undefined &&
            (currentDetails.maximized !== targetConfig.maximized || needsMaximizeAfterMonitorMove)
        ) {
            if (targetConfig.maximized > 0) {
                operations.push({
                    type: 'Maximize',
                    winid: winid,
                    args: [targetConfig.maximized],
                    description: `Maximize window ${winid} (state: ${targetConfig.maximized})`,
                })
            } else {
                operations.push({
                    type: 'Unmaximize',
                    winid: winid,
                    args: [],
                    description: `Unmaximize window ${winid}`,
                })
            }
        }

        // Check frame rect (position and size)
        // Skip Place for fully maximized windows - the Maximize operation handles everything
        // For tiled windows, Place comes AFTER Maximize to set final position
        if (
            isAllowed('frame_rect') &&
            targetConfig.frame_rect &&
            currentDetails.frame_rect &&
            targetConfig.maximized !== MAXIMIZED_BOTH
        ) {
            const known = targetConfig.frame_rect
            const current = currentDetails.frame_rect

            // Skip if current geometry is invalid (window not fully initialized)
            const currentGeometryValid = current.width > 0 && current.height > 0

            if (
                currentGeometryValid &&
                (known.x !== current.x ||
                    known.y !== current.y ||
                    known.width !== current.width ||
                    known.height !== current.height)
            ) {
                operations.push({
                    type: 'Place',
                    winid: winid,
                    args: [known.x, known.y, known.width, known.height],
                    description: `Place window ${winid} at (${known.x}, ${known.y}) with size ${known.width}x${known.height}`,
                })
            }
        }

        // Check minimized state
        if (
            isAllowed('minimized') &&
            targetConfig.minimized !== undefined &&
            currentDetails.minimized !== targetConfig.minimized
        ) {
            if (targetConfig.minimized) {
                operations.push({
                    type: 'Minimize',
                    winid: winid,
                    args: [],
                    description: `Minimize window ${winid}`,
                })
            }
        }

        // Check fullscreen state
        if (
            isAllowed('fullscreen') &&
            targetConfig.fullscreen !== undefined &&
            currentDetails.fullscreen !== targetConfig.fullscreen
        ) {
            operations.push({
                type: 'SetFullscreen',
                winid: winid,
                args: [targetConfig.fullscreen],
                description: `Set fullscreen to ${targetConfig.fullscreen} for window ${winid}`,
            })
        }

        // Expand operations with pre-conditions (e.g., unmaximize before place/move)
        return this.expandOperations(operations, currentDetails)
    }

    // Window lifecycle management
    findOccupiedSlots(winid) {
        return this.knownWindows.filter((w) => w.occupied === winid)
    }

    unoccupyKnownWindow(winid) {
        for (let w of this.knownWindows) {
            if (w.occupied === winid) {
                w.occupied = null
                this.notifyStateChange()
                break
            }
        }
    }

    onWindowDestroyed(winid) {
        this._cleanupWindowState(winid)
        this.unoccupyKnownWindow(winid)
        return {
            type: 'window.destroyed',
            winid: winid,
        }
    }

    matchWindowToKnown(winid, details, bestMatch, policy = null) {
        bestMatch.occupied = winid
        bestMatch.seen = Date.now()

        // Generate operations for window state restoration
        const operations = this.generateRestoreOperations(winid, details, bestMatch.props, policy)

        const targetConfig = this.getBestAvailableConfig(bestMatch.props)

        // Transition to RESTORING if we have operations to execute
        if (operations.length > 0) {
            const windowState = this._getWindowState(winid)
            windowState.targetConfig = targetConfig
            this._transitionState(winid, WindowState.RESTORING, details, `matched, ${operations.length} operations`)
        } else if (targetConfig) {
            // No operations needed, go straight to TRACKING
            this._transitionState(winid, WindowState.TRACKING, details, 'matched, no operations needed')
        }

        // Don't update config here! Config updates should only happen in TRACKING state
        // when user moves windows. During matching, we want to preserve the stored config.
        this.notifyStateChange()

        return {
            operations: operations,
            event: {
                type: 'known.match',
                winid: winid,
                knownProps: bestMatch.props,
                activeDetails: details,
            },
        }
    }

    addWindowAsNew(winid, details) {
        // Create props structure with identity properties and configs array
        const props = {}

        // Add identity properties at top level
        for (let key of this._config.SIGNIFICANT_PROPS) {
            if (key in details) {
                props[key] = details[key]
            }
        }

        // Create configs array with initial config
        const config = {}
        for (let key of this._config.MANAGED_PROPS) {
            if (key in details) {
                config[key] = details[key]
            }
        }
        props.configs = [config]

        const newWindow = { occupied: winid, props: props, seen: Date.now() }
        this.knownWindows.push(newWindow)
        this.notifyStateChange()

        // Transition to TRACKING since this is a new window with no operations needed
        this._transitionState(winid, WindowState.TRACKING, details, 'added as new')

        return {
            operations: [],
            event: {
                type: 'known.new',
                winid: winid,
                details: details,
            },
        }
    }

    processSinglePendingWindow(winid, windowState, currentTime, ambiguousWmClasses) {
        const details = windowState.details

        // Use extended timeout for generic titles
        const title = details.title || ''
        const maxWaitTime = this.isLikelyGenericTitle(title)
            ? this._config.GENERIC_TITLE_EXTENDED_WAIT
            : this._config.SETTLE_MAX_WAIT
        const isTimedOut = currentTime - windowState.transitionTime > maxWaitTime

        const wmClass = details.wm_class
        const decisionResult = this.shouldDecideOnWindow(windowState, currentTime, isTimedOut)

        // Skip ambiguity check for exact matches
        if (ambiguousWmClasses.has(wmClass) && !isTimedOut && !decisionResult.debug?.exactMatch) {
            return { processed: false, operations: [], event: null }
        }
        if (!decisionResult.decide) {
            // Add debug event for why we're not deciding
            const debugEvent = {
                type: 'window.pending_decision',
                winid: winid,
                debug: decisionResult.debug,
            }
            return { processed: false, operations: [], event: debugEvent }
        }

        const scores = this.calculateScoresForWindow(details)

        const bestScore = scores.length > 0 ? scores[0].score : -1
        const secondBestScore = scores.length > 1 ? scores[1].score : -1
        const bestMatch = scores.length > 0 ? scores[0].window : null

        const policy = this.getPolicyForWindow(details)
        const threshold = policy.threshold

        const isConfident = scores.length === 0 || bestScore - secondBestScore >= this._config.MIN_SCORE_SPREAD
        const hasExactMatch = decisionResult.debug?.exactMatch

        if (!(isConfident || isTimedOut || hasExactMatch)) {
            return { processed: false, operations: [], event: null }
        }

        // Don't match windows with invalid geometry - wait until they're fully initialized
        if (details.frame_rect && !isValidGeometry(details.frame_rect)) {
            return { processed: false, operations: [], event: null }
        }

        let result
        if (bestMatch && bestScore >= threshold) {
            result = this.matchWindowToKnown(winid, details, bestMatch, policy)
        } else {
            result = this.addWindowAsNew(winid, details)
        }

        return { processed: true, operations: result.operations, event: result.event }
    }

    processPendingWindows() {
        const currentTime = Date.now()
        const ambiguousWmClasses = this.findAmbiguousWmClasses()

        // Get all windows in PENDING state
        const pendingWindows = Array.from(this._windowStates.entries())
            .filter(([winid, state]) => state.state === WindowState.PENDING)

        const allOperations = []
        const allEvents = []

        for (let [winid, windowState] of pendingWindows) {
            const result = this.processSinglePendingWindow(winid, windowState, currentTime, ambiguousWmClasses)
            if (result.processed) {
                // Window is no longer pending - will transition to RESTORING when operations execute
                allOperations.push(...result.operations)
                if (result.event) {
                    allEvents.push(result.event)
                }
            } else if (result.event && result.event.type === 'window.pending_decision') {
                // Include debug events for pending decisions (but only occasionally to avoid spam)
                if (Math.random() < this._config.DEBUG_PENDING_SAMPLE_RATE) {
                    allEvents.push(result.event)
                }
            }
        }

        return { operations: allOperations, events: allEvents }
    }

    // Main event handler
    onWindowModified(winid, eventName, windowDetails) {
        const currentTime = Date.now()
        this.lastMessageTime = currentTime

        // Accept both object and JSON string for backwards compatibility
        const details = typeof windowDetails === 'string'
            ? JSON.parse(windowDetails)
            : windowDetails

        if (!details) {
            return { operations: [], events: [] }
        }

        const coreDetails = this.extractCoreDetails(details)

        // Apply policy if defined
        if (this.policyCallback && !details.destroyed && eventName !== 'destroy') {
            if (!this.policyCallback(winid, details)) {
                return { operations: [], events: [] }
            }
        }

        // Handle destroyed windows
        if (details.destroyed || eventName === 'destroy') {
            const destroyedEvent = this.onWindowDestroyed(winid)
            return { operations: [], events: [destroyedEvent] }
        }

        // Handle monitor changes - relocate to best available config
        if (eventName === 'monitors-changed') {
            const occupiedSlots = this.findOccupiedSlots(winid)
            if (occupiedSlots.length > 0) {
                const currentSlot = occupiedSlots[0]
                const props = currentSlot.props

                // If this window has multiple configs, check if we should move to a different one
                if (props.configs && props.configs.length > 0) {
                    // Get the target config for current monitor setup
                    const targetConfig = this.getBestAvailableConfig(props)
                    if (!targetConfig) {
                        return { operations: [], events: [] }
                    }

                    // Skip if already restoring or settling
                    const windowState = this._getWindowState(winid)
                    if (windowState.state === WindowState.RESTORING || windowState.state === WindowState.SETTLING) {
                        debug('tracker', `skipping monitors-changed for window ${winid} (already in ${windowState.state} state)`)
                        return { operations: [], events: [] }
                    }

                    const policy = this.getPolicyForWindow(props)
                    const operations = this.generateRestoreOperations(winid, coreDetails, props, policy)

                    // Skip if no operations needed (window already in correct state)
                    if (operations.length === 0) {
                        debug('tracker', `skipping monitors-changed for window ${winid} (config unchanged: monitor ${targetConfig.monitor})`)
                        return { operations: [], events: [] }
                    }

                    debug('tracker', `monitor change triggered ${operations.length} operations for window ${winid} (target monitor: ${targetConfig.monitor})`)

                    // Transition to RESTORING state
                    windowState.targetConfig = targetConfig
                    this._transitionState(winid, WindowState.RESTORING, coreDetails, `monitors-changed, ${operations.length} operations`)

                    return {
                        operations: operations,
                        events: [{
                            type: 'window.monitor_relocated',
                            winid: winid,
                            details: coreDetails
                        }]
                    }
                }
            }
            return { operations: [], events: [] }
        }

        // Check if window should be tracked
        if (!shouldTrackWindow(details)) {
            return { operations: [], events: [] }
        }

        const modifiedEvent = {
            type: 'window.modified',
            winid: winid,
            eventName: eventName,
            details: coreDetails,
        }

        // Check if this is an already occupied window
        const occupiedSlots = this.findOccupiedSlots(winid)
        if (occupiedSlots.length > 0) {
            const currentSlot = occupiedSlots[0]
            const oldTitle = currentSlot.props.title || ''
            const newTitle = coreDetails.title || ''

            // Check if title became specific and we should migrate to a better slot
            if (this.hasTitleBecomeMoreSpecific(oldTitle, newTitle)) {
                const scores = this.calculateScoresForWindow(coreDetails)
                const bestMatch = scores.length > 0 ? scores[0].window : null
                const bestScore = scores.length > 0 ? scores[0].score : -1

                // Only migrate if we find a very high quality match (exact title or very close)
                if (bestMatch && bestScore >= 0.95) {
                    // Unoccupy current slot
                    currentSlot.occupied = null

                    // If the old slot was a generic one (created ad-hoc), remove it to avoid zombies
                    // We assume a slot is "generic/ad-hoc" if it has a generic title
                    if (this.isLikelyGenericTitle(oldTitle)) {
                        const slotIndex = this.knownWindows.indexOf(currentSlot)
                        if (slotIndex !== -1) {
                            this.knownWindows.splice(slotIndex, 1)
                        }
                    }

                    // Occupy new slot and return result
                    const policy = this.getPolicyForWindow(coreDetails)
                    const migrationResult = this.matchWindowToKnown(winid, coreDetails, bestMatch, policy)

                    return {
                        operations: migrationResult.operations,
                        events: [
                            {
                                type: 'window.title_became_specific',
                                winid: winid,
                                oldTitle: oldTitle,
                                newTitle: newTitle,
                            },
                            migrationResult.event,
                        ],
                    }
                }
            }

            // Check window state for special handling
            const windowState = this._getWindowState(winid)

            // If window is SETTLING, update details and reset the settle timer on any event
            // This ensures we wait for the window to fully stabilize before checking for drift
            if (windowState.state === WindowState.SETTLING) {
                debug('state', `window ${winid} event while SETTLING, resetting settle timer`)
                windowState.details = coreDetails // Update to current details for drift check
                windowState.lastEventTime = Date.now()
                this._cancelSettleTimer(windowState)
                this._startSettleTimer(winid, windowState)
            }

            // Update existing window config only if in TRACKING state
            // This prevents intermediate states from our operations (like unmaximize before monitor move)
            // from corrupting the stored configs
            if (windowState.state === WindowState.TRACKING) {
                // Check if user moved window to a different monitor
                const previousMonitor = windowState.details?.monitor
                const currentMonitor = coreDetails.monitor

                if (previousMonitor !== undefined &&
                    currentMonitor !== undefined &&
                    previousMonitor !== currentMonitor) {
                    // Monitor changed - check if we have a saved config for the new monitor
                    const existingConfig = currentSlot.props.configs?.find(
                        cfg => cfg.monitor === currentMonitor
                    )

                    if (existingConfig) {
                        // Restore the existing config for THIS SPECIFIC monitor (not "best" monitor)
                        // User explicitly chose this monitor, so honor that choice
                        debug('tracker', `user moved window ${winid} to monitor ${currentMonitor}, restoring saved config`)
                        const policy = this.getPolicyForWindow(currentSlot.props)

                        // Create a temporary props object with only this monitor's config
                        // This forces generateRestoreOperations to use this config, not pick "best"
                        const targetProps = {
                            ...currentSlot.props,
                            configs: [existingConfig]
                        }
                        const operations = this.generateRestoreOperations(winid, coreDetails, targetProps, policy)

                        if (operations.length > 0) {
                            windowState.targetConfig = existingConfig
                            this._transitionState(winid, WindowState.RESTORING, coreDetails, `user monitor change, ${operations.length} operations`)
                            currentSlot.seen = Date.now()
                            this.notifyStateChange()

                            return {
                                operations: operations,
                                events: [{
                                    type: 'window.user_monitor_change',
                                    winid: winid,
                                    fromMonitor: previousMonitor,
                                    toMonitor: currentMonitor,
                                }, modifiedEvent]
                            }
                        }
                    }
                }

                // No existing config or no operations needed - update config normally
                this.updateOrAddConfig(currentSlot.props, coreDetails)
                windowState.details = coreDetails
            }
            currentSlot.seen = Date.now()
            this.notifyStateChange()

            if (this.hasTitleBecomeMoreSpecific(oldTitle, newTitle)) {
                return {
                    operations: [],
                    events: [
                        {
                            type: 'window.title_became_specific',
                            winid: winid,
                            oldTitle: oldTitle,
                            newTitle: newTitle,
                        },
                        modifiedEvent,
                    ],
                }
            }

            return { operations: [], events: [modifiedEvent] }
        }

        // Handle pending or new windows
        let titleBecameSpecific = false
        let oldTitle = ''
        let newTitle = ''

        const windowState = this._getWindowState(winid)

        if (windowState.state === WindowState.PENDING) {
            // Update existing pending window
            oldTitle = windowState.details?.title || ''
            newTitle = coreDetails.title || ''

            titleBecameSpecific = this.hasTitleBecomeMoreSpecific(oldTitle, newTitle)
            if (titleBecameSpecific) {
                windowState.transitionTime = currentTime
            }

            windowState.details = coreDetails
            windowState.lastEventTime = currentTime
        } else {
            // New window - start in PENDING state
            this._transitionState(winid, WindowState.PENDING, coreDetails, 'new window detected')
        }

        // Process pending windows and get operations
        const result = this.processPendingWindows()

        // Collect all events
        const allEvents = []
        if (modifiedEvent) {
            allEvents.push(modifiedEvent)
        }
        if (titleBecameSpecific) {
            allEvents.push({
                type: 'window.title_became_specific',
                winid: winid,
                oldTitle: oldTitle,
                newTitle: newTitle,
            })
        }
        allEvents.push(...result.events)

        return { operations: result.operations, events: allEvents }
    }

    // Actor querying and state update methods
    updateFromCurrentActors() {
        if (!this.actorQueryCallback) {
            return { operations: [], events: [] }
        }

        const currentActors = this.actorQueryCallback()
        const allOperations = []
        const allEvents = []

        this._suppressStateNotify = true

        try {
            for (const actorInfo of currentActors) {
                const { winid, details } = actorInfo
                const result = this.onWindowModified(winid, 'initial-query', details)
                if (result) {
                    allOperations.push(...result.operations)
                    allEvents.push(...result.events)
                }
            }
        } finally {
            this._suppressStateNotify = false
            this.notifyStateChange()
        }

        return { operations: allOperations, events: allEvents }
    }

    refreshFromCurrentActors() {
        return this.updateFromCurrentActors()
    }

    // Public API
    getKnownWindows() {
        return [...this.knownWindows]
    }

    getPendingWindows() {
        // Return windows in PENDING state
        const pending = new Map()
        for (let [winid, state] of this._windowStates) {
            if (state.state === WindowState.PENDING && state.details) {
                pending.set(winid, {
                    details: state.details,
                    startTime: state.transitionTime,
                    lastUpdateTime: state.lastEventTime,
                })
            }
        }
        return pending
    }

    getStats() {
        const occupiedWindows = this.knownWindows.filter((w) => w.occupied !== null)
        const unoccupiedWindows = this.knownWindows.filter((w) => w.occupied === null)

        // Count windows in PENDING state
        const pendingWindows = Array.from(this._windowStates.values())
            .filter(state => state.state === WindowState.PENDING)
        const pendingWindowIds = pendingWindows.map(state => state.winid)

        // Create detailed slot information
        const allSlots = this.knownWindows.map((w, idx) => {
            const isOccupied = w.occupied !== null
            return {
                slotId: idx,
                occupied: isOccupied,
                winid: isOccupied ? w.occupied : null,
                wm_class: w.props.wm_class || 'unknown',
                title: w.props.title || 'untitled',
            }
        })

        // Create detailed pending window information
        const pendingDetails = pendingWindows.map(state => {
            return {
                winid: state.winid,
                wm_class: state.details?.wm_class || 'unknown',
                title: state.details?.title || 'untitled',
            }
        })

        return {
            knownWindows: this.knownWindows.length,
            occupiedWindows: occupiedWindows.length,
            unoccupiedWindows: unoccupiedWindows.length,
            pendingWindows: pendingWindows.length,
            occupiedWindowIds: occupiedWindows.map((w) => w.occupied),
            unoccupiedWindowIds: unoccupiedWindows.map((w, idx) => `slot-${idx}`),
            pendingWindowIds: pendingWindowIds,
            allSlots: allSlots,
            pendingDetails: pendingDetails,
        }
    }
}

// Export for use as ES6 module
export { WindowStateMatcher }

// Re-export constants for convenience
export * from './window-state.js'
