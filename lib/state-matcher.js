import GLib from 'gi://GLib'
import { debug, TimeoutManager } from './utils.js'
import {
    MAXIMIZED_NONE,
    MAXIMIZED_HORIZONTAL,
    MAXIMIZED_VERTICAL,
    MAXIMIZED_BOTH,
    isValidGeometry,
    shouldTrackWindow,
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
    OPERATION_SETTLE_DELAY_MS: 200, // ms - delay after workspace change before executing queued ops

    // Score calculation
    MIN_SCORE_SPREAD: 0.6,
    AMBIGUOUS_SIMILARITY_THRESHOLD: 0.95,
    TITLE_SIMILARITY_MAX_DIST: 2.0, // Max histogram distance for normalization
    SPECIFIC_MATCH_BOOST: 1.1, // Score multiplier for specific-to-specific matches
    TITLE_MIGRATION_THRESHOLD: 0.95, // Min score to migrate window to better-matching slot

    // Position tolerance
    POSITION_TOLERANCE_PX: 10, // Maximum pixel distance for position drift detection

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
     * @param {Function} options.getMonitorGeometry - Callback to get monitor geometry: (index) => {x, y, width, height}
     * @param {Function} options.getConnectorForMonitor - Callback to get connector name for monitor index: (index) => string|null
     * @param {Function} options.getMonitorForConnector - Callback to get monitor index for connector name: (name) => number (-1 if not found)
     * @param {Function} options.getAvailableConnectors - Callback to get list of connected connector names: () => string[]
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
        getMonitorGeometry = null,
        getConnectorForMonitor = null,
        getMonitorForConnector = null,
        getAvailableConnectors = null,
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
        this.getMonitorGeometryCallback = getMonitorGeometry
        this.getConnectorForMonitorCallback = getConnectorForMonitor
        this.getMonitorForConnectorCallback = getMonitorForConnector
        this.getAvailableConnectorsCallback = getAvailableConnectors
        this._suppressStateNotify = false

        // Restore initial state if provided
        if (initialState) {
            this.restoreFromState(initialState)
        }

        // Note: initial actor query is deferred to caller via updateFromCurrentActors()
        // to ensure all references (like OperationHandler._tracker) are set up first

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
                // Pass state.targetConfig directly to generateRestoreOperations via directConfig
                // parameter to avoid going through getBestAvailableConfig again (which would
                // lose frame_rect since targetConfig has frame_rect but not relative_rect)
                const occupiedSlots = this.findOccupiedSlots(winid)
                if (occupiedSlots.length > 0 && state.targetConfig) {
                    const policy = this.getPolicyForWindow(occupiedSlots[0].props)
                    // Use directConfig parameter to pass targetConfig directly
                    const operations = this.generateRestoreOperations(
                        winid, state.details, occupiedSlots[0].props, policy, false, state.targetConfig
                    )
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
        // Check frame_rect first for non-fully-maximized windows
        // Position is the primary indicator - if position is correct, don't flag monitor
        // index changes as drift (monitor indices can change when displays are added/removed)
        let positionCorrect = true
        if (targetConfig.maximized !== MAXIMIZED_BOTH &&
            targetConfig.frame_rect && currentDetails.frame_rect) {
            const current = currentDetails.frame_rect

            // Allow small tolerance for position drift
            // Compare absolute coordinates directly (frame_rect is already in global space)
            if (!this._isPositionWithinTolerance(current, targetConfig.frame_rect.x, targetConfig.frame_rect.y, this._config.POSITION_TOLERANCE_PX)) {
                debug('state', `window ${winid} drift: position (${current.x},${current.y}) != (${targetConfig.frame_rect.x},${targetConfig.frame_rect.y})`)
                positionCorrect = false
            }
        }

        // Only check monitor if position is wrong - monitor indices are unstable
        // when displays are added/removed, so we trust position over index
        if (!positionCorrect && targetConfig.monitor !== undefined && currentDetails.monitor !== targetConfig.monitor) {
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

        // Return position drift status
        return !positionCorrect
    }

    /**
     * Check if two frame positions are within a specified tolerance.
     * @param {Object} current - Current frame_rect with x, y properties
     * @param {number} targetX - Target X coordinate
     * @param {number} targetY - Target Y coordinate
     * @param {number} tolerance - Maximum pixel distance allowed
     * @returns {boolean} True if positions are within tolerance
     */
    _isPositionWithinTolerance(current, targetX, targetY, tolerance) {
        return Math.abs(current.x - targetX) <= tolerance &&
               Math.abs(current.y - targetY) <= tolerance
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

    /**
     * Update connector preference list (LIFO). Moves connector to front.
     * This tracks the user's monitor preferences by connector name, which is stable
     * across monitor connect/disconnect cycles unlike monitor indices.
     *
     * @param {Object} props - Window props containing connectorPreference array
     * @param {string} connector - Connector name to add/move to front
     */
    _updateConnectorPreference(props, connector) {
        if (!connector) return

        if (!props.connectorPreference) {
            props.connectorPreference = []
        }

        // Remove if already present
        const idx = props.connectorPreference.indexOf(connector)
        if (idx !== -1) {
            props.connectorPreference.splice(idx, 1)
        }

        // Add to front (most recent = highest priority)
        props.connectorPreference.unshift(connector)

        debug('state', `updated connector preference: [${props.connectorPreference.join(', ')}]`)
    }

    /**
     * Get the highest-priority available connector from preference list.
     * Walks through the preference list in order and returns the first
     * connector that is currently connected.
     *
     * @param {string[]} preferenceList - Ordered list of connector names (most preferred first)
     * @returns {string|null} Best available connector, or null if none available
     */
    _getBestAvailableConnector(preferenceList) {
        if (!preferenceList || !this.getAvailableConnectorsCallback) {
            return null
        }

        const available = new Set(this.getAvailableConnectorsCallback())

        for (const connector of preferenceList) {
            if (available.has(connector)) {
                return connector
            }
        }

        return null
    }

    /**
     * Pick specified properties from a source object.
     * @param {Object} source - Source object to pick from
     * @param {Array<string>} propNames - Array of property names to pick
     * @returns {Object} New object with only the specified properties
     */
    _pickProps(source, propNames) {
        const result = {}
        for (let key of propNames) {
            if (key in source) {
                result[key] = source[key]
            }
        }
        return result
    }

    extractCoreDetails(details) {
        const props = [...this._config.SIGNIFICANT_PROPS, ...this._config.MANAGED_PROPS]
        return this._pickProps(details, props)
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

    updateOrAddConfig(props, newStateProps) {
        // Ensure configs array exists
        if (!props.configs) {
            props.configs = []
        }

        // Get connector name for this monitor (stable identifier)
        const monitorIndex = newStateProps.monitor
        const connector = this.getConnectorForMonitorCallback?.(monitorIndex)

        if (!connector) {
            debug('state', `cannot save config: no connector for monitor ${monitorIndex}`)
            return
        }

        // Find existing config for this connector
        let existingConfig = props.configs.find(cfg => cfg.connector === connector)

        // Convert absolute frame_rect to relative position within monitor
        let relativeRect = null
        if (newStateProps.frame_rect && this.getMonitorGeometryCallback) {
            const monitorGeom = this.getMonitorGeometryCallback(monitorIndex)
            if (monitorGeom) {
                relativeRect = {
                    x: newStateProps.frame_rect.x - monitorGeom.x,
                    y: newStateProps.frame_rect.y - monitorGeom.y,
                    width: newStateProps.frame_rect.width,
                    height: newStateProps.frame_rect.height
                }
            }
        }

        // Build config with connector-based storage
        const configProps = {
            connector: connector,
            workspace: newStateProps.workspace,
            minimized: newStateProps.minimized,
            maximized: newStateProps.maximized,
        }
        if (relativeRect) {
            configProps.relative_rect = relativeRect
        }

        if (existingConfig) {
            // Update existing config
            Object.assign(existingConfig, configProps)
        } else {
            // Add new config
            props.configs.push(configProps)
        }

        // Update identity properties at top level
        Object.assign(props, this._pickProps(newStateProps, this._config.SIGNIFICANT_PROPS))
    }

    compareDetails(details1, details2) {
        if (details1.wm_class !== details2.wm_class) {
            return 0.0
        }

        const title1 = details1?.title || ''
        const title2 = details2?.title || ''

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

        const pendingTitle = pendingDetails?.title || ''
        const knownTitle = knownWindow.props?.title || ''

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
        const pendingTitle = pendingDetails?.title || ''
        const unoccupiedKnownWindows = this.knownWindows.filter((w) => !w.occupied)

        const scores = unoccupiedKnownWindows.map((w) => ({
            score: this.calculateWindowScore(pendingDetails, w),
            window: w,
            exactTitle: pendingTitle === w.props?.title || '',
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
                pendingDetails?.title || '' === w.props?.title || ''
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
     * Convert a stored config (connector-based, relative position) to an applicable config
     * (monitor index, absolute position) for the current monitor layout.
     *
     * @param {Object} storedConfig - Config with connector and relative_rect
     * @returns {Object|null} Config with monitor index and absolute frame_rect, or null if connector unavailable
     */
    _convertConfigForCurrentLayout(storedConfig) {
        if (!storedConfig.connector) {
            return null
        }

        // Get current monitor index for this connector
        const monitorIndex = this.getMonitorForConnectorCallback?.(storedConfig.connector)
        if (monitorIndex === undefined || monitorIndex < 0) {
            return null // Connector not currently available
        }

        // Build result with current monitor index
        const result = {
            monitor: monitorIndex,
            connector: storedConfig.connector,
            workspace: storedConfig.workspace,
            minimized: storedConfig.minimized,
            maximized: storedConfig.maximized,
        }

        // Convert relative_rect to absolute frame_rect
        if (storedConfig.relative_rect && this.getMonitorGeometryCallback) {
            const monitorGeom = this.getMonitorGeometryCallback(monitorIndex)
            if (monitorGeom) {
                result.frame_rect = {
                    x: storedConfig.relative_rect.x + monitorGeom.x,
                    y: storedConfig.relative_rect.y + monitorGeom.y,
                    width: storedConfig.relative_rect.width,
                    height: storedConfig.relative_rect.height
                }
            }
        }

        return result
    }

    /**
     * Get the best available config for a window based on current monitor setup.
     * Configs are stored by connector name and relative position.
     * This function finds the best config and converts it to absolute coordinates.
     *
     * Priority order:
     * 1. User's connector preference list (LIFO - most recent first)
     * 2. Fallback: any available connector's config
     *
     * @param {Object} knownProps - Window props containing configs array and optional connectorPreference
     * @returns {Object|null} Best available config with monitor index and absolute frame_rect, or null if none available
     */
    getBestAvailableConfig(knownProps) {
        if (!knownProps.configs || !Array.isArray(knownProps.configs) || knownProps.configs.length === 0) {
            return null
        }

        // Get set of available connectors
        const availableConnectors = new Set(this.getAvailableConnectorsCallback?.() ?? [])

        // Check user's connector preference list (LIFO - most recent user choice wins)
        if (knownProps.connectorPreference?.length) {
            for (const connector of knownProps.connectorPreference) {
                if (availableConnectors.has(connector)) {
                    // Find config for this connector
                    const config = knownProps.configs.find(cfg => cfg.connector === connector)
                    if (config) {
                        const converted = this._convertConfigForCurrentLayout(config)
                        if (converted) {
                            debug('state', `using preferred connector ${connector} (monitor ${converted.monitor})`)
                            return converted
                        }
                    }
                }
            }
        }

        // Fallback: find any config for an available connector
        for (const config of knownProps.configs) {
            if (config.connector && availableConnectors.has(config.connector)) {
                const converted = this._convertConfigForCurrentLayout(config)
                if (converted) {
                    debug('state', `using fallback connector ${config.connector} (monitor ${converted.monitor})`)
                    return converted
                }
            }
        }

        return null
    }

    /**
     * Check if two configs are equivalent for the purpose of skipping duplicate operations.
     */
    configsAreEquivalent(configA, configB) {
        if (!configA || !configB) return false
        // Compare by connector (stable identifier)
        if (configA.connector !== configB.connector) return false
        if (!configA.frame_rect || !configB.frame_rect) return configA.connector === configB.connector
        return (
            configA.frame_rect.x === configB.frame_rect.x &&
            configA.frame_rect.y === configB.frame_rect.y &&
            configA.frame_rect.width === configB.frame_rect.width &&
            configA.frame_rect.height === configB.frame_rect.height
        )
    }

    // Operation generation helpers

    /**
     * Generate maximize/unmaximize operations for a window.
     * @returns {Array} Array of operations to add
     */
    _generateMaximizeOperations(winid, currentDetails, targetConfig, isAllowed, force, needsMonitorMove) {
        const operations = []

        const needsMaximizeAfterMonitorMove = needsMonitorMove &&
            isAllowed('maximized') &&
            targetConfig.maximized !== undefined &&
            targetConfig.maximized > 0

        if (
            isAllowed('maximized') &&
            targetConfig.maximized !== undefined &&
            (force || currentDetails.maximized !== targetConfig.maximized || needsMaximizeAfterMonitorMove)
        ) {
            if (targetConfig.maximized > 0) {
                // If we are forcing restore (e.g. monitor change) and target is tiled,
                // explicitly unmaximize first to ensure clean state application.
                // This fixes issues where window stays tiled to the wrong side because
                // maximize flags are identical (e.g. both Vertical).
                if (force && (targetConfig.maximized & (MAXIMIZED_HORIZONTAL | MAXIMIZED_VERTICAL))) {
                    operations.push({
                        type: 'Unmaximize',
                        winid: winid,
                        args: [],
                        description: `Unmaximize window ${winid} before retiling`,
                    })
                }

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

        return operations
    }

    /**
     * Generate place operation for a window's frame rect.
     * @returns {Object|null} Place operation or null if not needed
     */
    _generatePlaceOperation(winid, currentDetails, targetConfig, isAllowed, force) {
        if (
            !isAllowed('frame_rect') ||
            !targetConfig.frame_rect ||
            !currentDetails.frame_rect ||
            targetConfig.maximized === MAXIMIZED_BOTH
        ) {
            return null
        }

        const known = targetConfig.frame_rect
        const current = currentDetails.frame_rect

        // Skip if current geometry is invalid (window not fully initialized)
        const currentGeometryValid = current.width > 0 && current.height > 0

        // Use saved absolute coordinates directly (frame_rect is stored in global space)
        const positionOrSizeChanged =
            known.x !== current.x ||
            known.y !== current.y ||
            known.width !== current.width ||
            known.height !== current.height

        if (force || (currentGeometryValid && positionOrSizeChanged)) {
            return {
                type: 'Place',
                winid: winid,
                args: [known.x, known.y, known.width, known.height],
                description: `Place window ${winid} at (${known.x}, ${known.y}) with size ${known.width}x${known.height}`,
            }
        }

        return null
    }

    generateRestoreOperations(winid, currentDetails, knownProps, policy = null, force = false, directConfig = null) {
        const operations = []

        if (policy && policy.action === 'IGNORE') {
            return operations
        }

        const isAllowed = (prop) => {
            if (!policy || !policy.matchProperties) return true
            return policy.matchProperties.includes(prop)
        }

        // Use directConfig if provided (e.g., for drift correction), otherwise get best config
        const targetConfig = directConfig || this.getBestAvailableConfig(knownProps)
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
            (force || currentDetails.monitor !== targetConfig.monitor)
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
            (force || currentDetails.workspace !== targetConfig.workspace)
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
        operations.push(...this._generateMaximizeOperations(winid, currentDetails, targetConfig, isAllowed, force, needsMonitorMove))

        // Check frame rect (position and size)
        // Skip Place for fully maximized windows - the Maximize operation handles everything
        // For tiled windows, Place comes AFTER Maximize to set final position
        const placeOp = this._generatePlaceOperation(winid, currentDetails, targetConfig, isAllowed, force)
        if (placeOp) {
            operations.push(placeOp)
        }

        // Check minimized state
        if (
            isAllowed('minimized') &&
            targetConfig.minimized !== undefined &&
            (force || currentDetails.minimized !== targetConfig.minimized)
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
            (force || currentDetails.fullscreen !== targetConfig.fullscreen)
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
        const props = this._pickProps(details, this._config.SIGNIFICANT_PROPS)

        // Create connector-based config (not legacy frame_rect-based)
        const monitorIndex = details.monitor
        const connector = this.getConnectorForMonitorCallback?.(monitorIndex)

        if (connector) {
            // Convert absolute frame_rect to relative position within monitor
            let relativeRect = null
            if (details.frame_rect && this.getMonitorGeometryCallback) {
                const monitorGeom = this.getMonitorGeometryCallback(monitorIndex)
                if (monitorGeom) {
                    relativeRect = {
                        x: details.frame_rect.x - monitorGeom.x,
                        y: details.frame_rect.y - monitorGeom.y,
                        width: details.frame_rect.width,
                        height: details.frame_rect.height
                    }
                }
            }

            const configProps = {
                connector: connector,
                workspace: details.workspace,
                minimized: details.minimized,
                maximized: details.maximized,
            }
            if (relativeRect) {
                configProps.relative_rect = relativeRect
            }

            props.configs = [configProps]

            // Initialize connector preference
            props.connectorPreference = [connector]
        } else {
            // No connector available - can't create a proper config
            debug('state', `addWindowAsNew: no connector for monitor ${monitorIndex}, skipping window`, true)
            return {
                operations: [],
                event: null,
            }
        }

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
        const title = details?.title || ''
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

    /**
     * Handle monitors-changed event for a window.
     * @param {string} winid - Window ID
     * @param {Object} coreDetails - Extracted core window details
     * @returns {Object|null} Result with operations/events, or null if not handled
     */
    _handleMonitorsChanged(winid, coreDetails) {
        const occupiedSlots = this.findOccupiedSlots(winid)
        if (occupiedSlots.length === 0) {
            return { operations: [], events: [] }
        }

        const currentSlot = occupiedSlots[0]
        const props = currentSlot.props

        // If this window has no configs, nothing to do
        if (!props.configs || props.configs.length === 0) {
            return { operations: [], events: [] }
        }

        // Check if window is already on its preferred connector
        // This handles the case where monitor indices shift but the window is still
        // on the correct physical monitor (no saved config for the new index)
        const bestConnector = this._getBestAvailableConnector(props.connectorPreference)
        if (bestConnector && this.getConnectorForMonitorCallback) {
            const currentConnector = this.getConnectorForMonitorCallback(coreDetails.monitor)
            if (currentConnector === bestConnector) {
                debug('tracker', `window ${winid} already on preferred connector ${bestConnector}, skipping monitors-changed`)
                return { operations: [], events: [] }
            }
        }

        // Get the target config for current monitor setup
        // This uses the connector preference list (LIFO) to select the best available monitor
        const targetConfig = this.getBestAvailableConfig(props)
        if (!targetConfig) {
            return { operations: [], events: [] }
        }

        // Debug: log current vs target state and connector preference
        const prefList = props.connectorPreference?.join(', ') || 'none'
        debug('tracker', `monitors-changed for window ${winid}: current monitor=${coreDetails.monitor}, target monitor=${targetConfig.monitor}, prefs=[${prefList}]`)
        if (coreDetails.frame_rect && targetConfig.frame_rect) {
            debug('tracker', `  current pos=(${coreDetails.frame_rect.x}, ${coreDetails.frame_rect.y}), target pos=(${targetConfig.frame_rect.x}, ${targetConfig.frame_rect.y})`)
        }

        // Always re-apply state on monitors-changed.
        // Even if the window reports the correct monitor/position, the underlying
        // compositor state might be different (e.g. visual jumps), or the monitor
        // layout shift might require a forceful move to snap it back.
        // Optimization removed to fix "ghost window" issues.

        // Skip if already restoring or settling
        const windowState = this._getWindowState(winid)
        if (windowState.state === WindowState.RESTORING || windowState.state === WindowState.SETTLING) {
            debug('tracker', `skipping monitors-changed for window ${winid} (already in ${windowState.state} state)`)
            return { operations: [], events: [] }
        }

        const policy = this.getPolicyForWindow(props)
        const operations = this.generateRestoreOperations(winid, coreDetails, props, policy, true)

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

    /**
     * Handle user-initiated monitor change for a window in TRACKING state.
     * Checks if user moved window to a different monitor and restores saved config if available.
     *
     * @param {string} winid - Window ID
     * @param {Object} windowState - Window state info
     * @param {Object} coreDetails - Current window details
     * @param {Object} currentSlot - The occupied slot for this window
     * @param {Object} modifiedEvent - The base modified event to include
     * @returns {Object|null} Result with operations/events if restoration needed, null otherwise
     */
    _handleUserMonitorChange(winid, windowState, coreDetails, currentSlot, modifiedEvent) {
        const previousMonitor = windowState.details?.monitor
        const currentMonitor = coreDetails.monitor

        // No monitor change detected
        if (previousMonitor === undefined || currentMonitor === undefined || previousMonitor === currentMonitor) {
            return null
        }

        // Distinguish USER action from shell fallback:
        // If previous monitor no longer exists, the shell moved us because our monitor
        // disconnected - this is NOT a user action, don't update preference list.
        const monitorCount = this.getMonitorCountCallback?.() ?? 1
        const isUserAction = previousMonitor < monitorCount

        if (isUserAction) {
            // User explicitly moved to this monitor - record connector preference
            const connector = this.getConnectorForMonitorCallback?.(currentMonitor)
            if (connector) {
                this._updateConnectorPreference(currentSlot.props, connector)
                debug('tracker', `user moved window ${winid} to monitor ${currentMonitor} (${connector}), updated preference`)
            }
        } else {
            debug('tracker', `window ${winid} moved to monitor ${currentMonitor} by shell (previous monitor ${previousMonitor} no longer exists), preference unchanged`)
        }

        // Check if we have a saved config for the new connector
        const currentConnector = this.getConnectorForMonitorCallback?.(currentMonitor)
        const storedConfig = currentConnector
            ? currentSlot.props.configs?.find(cfg => cfg.connector === currentConnector)
            : null

        if (!storedConfig) {
            debug('tracker', `user move: no saved config for connector ${currentConnector}, will save current state`)
            return null
        }

        // Convert stored config to applicable config with absolute coordinates
        const existingConfig = this._convertConfigForCurrentLayout(storedConfig)
        if (!existingConfig) {
            return null
        }

        // Restore the existing config for THIS SPECIFIC connector (not "best")
        // User explicitly chose this monitor, so honor that choice
        debug('tracker', `user move: found saved config for ${currentConnector}: pos=(${existingConfig.frame_rect?.x},${existingConfig.frame_rect?.y})`)
        debug('tracker', `user move: current state: pos=(${coreDetails.frame_rect?.x},${coreDetails.frame_rect?.y}), monitor=${coreDetails.monitor}`)
        const policy = this.getPolicyForWindow(currentSlot.props)

        // Create a temporary props object with only this connector's config
        // This forces generateRestoreOperations to use this config, not pick "best"
        const targetProps = {
            ...currentSlot.props,
            configs: [storedConfig]
        }
        const operations = this.generateRestoreOperations(winid, coreDetails, targetProps, policy)
        debug('tracker', `user move: generated ${operations.length} restore operations`)

        if (operations.length === 0) {
            debug('tracker', `user move: no operations needed (window already at correct position)`)
            return null
        }

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

    /**
     * Handle modification event for an already-occupied window.
     * @param {string} winid - Window ID
     * @param {Object} coreDetails - Extracted core window details
     * @param {Object} currentSlot - The occupied slot for this window
     * @param {Object} modifiedEvent - The base modified event to include
     * @returns {Object} Result with operations and events
     */
    _handleOccupiedWindowModified(winid, coreDetails, currentSlot, modifiedEvent) {
        const oldTitle = currentSlot.props?.title || ''
        const newTitle = coreDetails?.title || ''

        // Check if title became specific and we should migrate to a better slot
        if (this.hasTitleBecomeMoreSpecific(oldTitle, newTitle)) {
            const scores = this.calculateScoresForWindow(coreDetails)
            const bestMatch = scores.length > 0 ? scores[0].window : null
            const bestScore = scores.length > 0 ? scores[0].score : -1

            // Only migrate if we find a very high quality match (exact title or very close)
            if (bestMatch && bestScore >= this._config.TITLE_MIGRATION_THRESHOLD) {
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

        // If window is RESTORING, update details to track current state
        // This prevents stale details from causing issues after operations complete
        if (windowState.state === WindowState.RESTORING) {
            windowState.details = coreDetails
            windowState.lastEventTime = Date.now()
        }

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
            // Check if user moved window to a different monitor and handle restoration
            const monitorChangeResult = this._handleUserMonitorChange(winid, windowState, coreDetails, currentSlot, modifiedEvent)
            if (monitorChangeResult) {
                return monitorChangeResult
            }

            // No existing config or no operations needed - update config normally
            this.updateOrAddConfig(currentSlot.props, coreDetails)

            // Initialize connector preference if not yet set (for initial placement)
            // This ensures the first monitor a window appears on becomes its default preference
            if (!currentSlot.props.connectorPreference?.length) {
                const connector = this.getConnectorForMonitorCallback?.(coreDetails.monitor)
                if (connector) {
                    this._updateConnectorPreference(currentSlot.props, connector)
                    debug('tracker', `initialized connector preference for window ${winid}: ${connector}`)
                }
            }

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
            return this._handleMonitorsChanged(winid, coreDetails)
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
            return this._handleOccupiedWindowModified(winid, coreDetails, occupiedSlots[0], modifiedEvent)
        }

        // Handle pending or new windows
        let titleBecameSpecific = false
        let oldTitle = ''
        let newTitle = ''

        const windowState = this._getWindowState(winid)

        if (windowState.state === WindowState.PENDING) {
            // Update existing pending window
            oldTitle = windowState.details?.title || ''
            newTitle = coreDetails?.title || ''

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
