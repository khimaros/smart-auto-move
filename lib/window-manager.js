import { ShellWindowExecutor, ShellWindowMonitor, getConnectorForMonitor, getMonitorForConnector, getAvailableConnectors } from './gnome-shell.js'
import { StateSession } from './state-session.js'
import { debug } from './utils.js'

export class WindowManager {
    /**
     * @param {Object} options - Initialization options
     * @param {Object} options.config - Tracker configuration
     * @param {Function} options.stateLoader - () => state
     * @param {Function} options.stateSaver - (state) => void
     * @param {Object} options.trackerHandler - Custom handler
     * @param {Object} options.executorConfig - Configuration for ShellWindowExecutor
     * @param {Function} options.getMonitorCountCallback - Optional override for monitor count retrieval
     */
    constructor(options = {}) {
        this._executor = new ShellWindowExecutor(options.executorConfig)
        // Provide default callbacks for GNOME Shell context
        const sessionOptions = {
            ...options,
            getMonitorCountCallback: options.getMonitorCountCallback ?? (() => global.display.get_n_monitors()),
            getMonitorGeometryCallback: options.getMonitorGeometryCallback ?? ((monitorIndex) => {
                const nMonitors = global.display.get_n_monitors()
                if (monitorIndex < 0 || monitorIndex >= nMonitors) {
                    return null
                }
                const rect = global.display.get_monitor_geometry(monitorIndex)
                return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            }),
            // Connector mapping callbacks for LIFO monitor preference tracking
            getConnectorForMonitorCallback: options.getConnectorForMonitorCallback ?? getConnectorForMonitor,
            getMonitorForConnectorCallback: options.getMonitorForConnectorCallback ?? getMonitorForConnector,
            getAvailableConnectorsCallback: options.getAvailableConnectorsCallback ?? getAvailableConnectors,
        }
        this._session = new StateSession(this._executor, sessionOptions)
        this._monitor = new ShellWindowMonitor((winid, eventType, details) => {
            this._session.onWindowModified(winid, eventType, details)
        })
    }

    enable() {
        this._monitor.enable()
        debug('shell', 'WindowManager enabled')
    }

    disable() {
        this._monitor.disable()
        if (this._session) {
            this._session.destroy()
            this._session = null
        }
        debug('shell', 'WindowManager disabled')
    }

    getTracker() {
        return this._session ? this._session.getTracker() : null
    }

    getExecutor() {
        return this._session ? this._session.getExecutor() : null
    }

    getTrackerHandler() {
        return this._session ? this._session.getTrackerHandler() : null
    }

    getSession() {
        return this._session
    }

    updateConfig(newConfig) {
        if (this._session) {
            this._session.updateConfig(newConfig)
        }
    }

    getConfig() {
        return this._session ? this._session.getConfig() : {}
    }

    getStats() {
        return this._session ? this._session.getStats() : null
    }

    refreshWindowState() {
        return this._session ? this._session.refreshWindowState() : { operations: [], events: [] }
    }
}
