import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import { debug } from './utils.js'

export const DBUS_NAME = 'org.gnome.Shell'
export const DBUS_PATH = '/org/gnome/Shell/Extensions/WindowControl'
export const DBUS_INTERFACE = 'org.gnome.Shell.Extensions.WindowControl'

export const DBUS_DEFINITION = `
<node>
   <interface name="org.gnome.Shell.Extensions.WindowControl">
      <method name="List">
         <arg type="s" direction="out" name="windowList" />
      </method>
      <method name="ListNormalWindows">
         <arg type="s" direction="out" name="windowList" />
      </method>
      <method name="GetDetails">
         <arg type="u" direction="in" name="winid" />
         <arg type="s" direction="out" name="windowDetails" />
      </method>
      <method name="GetFrameRect">
         <arg type="u" direction="in" name="winid" />
         <arg type="s" direction="out" name="frameRect" />
      </method>
      <method name="GetBufferRect">
         <arg type="u" direction="in" name="winid" />
         <arg type="s" direction="out" name="bufferRect" />
      </method>
      <method name="GetTitle">
         <arg type="u" direction="in" name="winid" />
         <arg type="s" direction="out" name="title" />
      </method>
      <method name="MoveToWorkspace">
         <arg type="u" direction="in" name="winid" />
         <arg type="i" direction="in" name="wsid" />
      </method>
      <method name="MoveToMonitor">
         <arg type="u" direction="in" name="winid" />
         <arg type="i" direction="in" name="mid" />
      </method>
      <method name="Place">
         <arg type="u" direction="in" name="winid" />
         <arg type="i" direction="in" name="x" />
         <arg type="i" direction="in" name="y" />
         <arg type="u" direction="in" name="width" />
         <arg type="u" direction="in" name="height" />
      </method>
      <method name="Move">
         <arg type="u" direction="in" name="winid" />
         <arg type="i" direction="in" name="x" />
         <arg type="i" direction="in" name="y" />
      </method>
      <method name="Maximize">
         <arg type="u" direction="in" name="winid" />
         <arg type="i" direction="in" name="state" />
      </method>
      <method name="Minimize">
         <arg type="u" direction="in" name="winid" />
      </method>
      <method name="Unmaximize">
         <arg type="u" direction="in" name="winid" />
      </method>
      <method name="Close">
         <arg type="u" direction="in" name="winid" />
         <arg type="b" direction="in" name="isForced" />
      </method>
      <method name="ToggleFullscreen">
         <arg type="u" direction="in" name="winid" />
      </method>
      <method name="SetFullscreen">
         <arg type="u" direction="in" name="winid" />
         <arg type="b" direction="in" name="state" />
      </method>
      <method name="SetOnAllWorkspaces">
         <arg type="u" direction="in" name="winid" />
         <arg type="b" direction="in" name="state" />
      </method>
      <method name="SetAbove">
         <arg type="u" direction="in" name="winid" />
         <arg type="b" direction="in" name="state" />
      </method>
      <method name="GetFocusedMonitorDetails">
         <arg type="s" direction="out" name="focusedMonitorDetails" />
      </method>
      <signal name="WindowModified">
          <arg name="winid" type="u" />
          <arg name="eventName" type="s" />
         <arg name="windowDetails" type="s" />
      </signal>
   </interface>
</node>`

export class DbusExecutor {
    constructor(proxy) {
        this._proxy = proxy
    }

    moveToWorkspace(winid, wsid) {
        this._proxy.call_sync(
            'MoveToWorkspace',
            new GLib.Variant('(ui)', [winid, wsid]),
            Gio.DBusCallFlags.NONE,
            -1,
            null
        )
    }
    moveToMonitor(winid, mid) {
        this._proxy.call_sync('MoveToMonitor', new GLib.Variant('(ui)', [winid, mid]), Gio.DBusCallFlags.NONE, -1, null)
    }
    place(winid, x, y, width, height) {
        this._proxy.call_sync(
            'Place',
            new GLib.Variant('(uiiuu)', [winid, x, y, width, height]),
            Gio.DBusCallFlags.NONE,
            -1,
            null
        )
    }
    move(winid, x, y) {
        this._proxy.call_sync('Move', new GLib.Variant('(uii)', [winid, x, y]), Gio.DBusCallFlags.NONE, -1, null)
    }
    maximize(winid, state) {
        this._proxy.call_sync('Maximize', new GLib.Variant('(ui)', [winid, state]), Gio.DBusCallFlags.NONE, -1, null)
    }
    minimize(winid) {
        this._proxy.call_sync('Minimize', new GLib.Variant('(u)', [winid]), Gio.DBusCallFlags.NONE, -1, null)
    }
    unmaximize(winid) {
        this._proxy.call_sync('Unmaximize', new GLib.Variant('(u)', [winid]), Gio.DBusCallFlags.NONE, -1, null)
    }
    close(winid, isForced) {
        this._proxy.call_sync('Close', new GLib.Variant('(ub)', [winid, isForced]), Gio.DBusCallFlags.NONE, -1, null)
    }
    toggleFullscreen(winid) {
        this._proxy.call_sync('ToggleFullscreen', new GLib.Variant('(u)', [winid]), Gio.DBusCallFlags.NONE, -1, null)
    }
    setFullscreen(winid, state) {
        this._proxy.call_sync(
            'SetFullscreen',
            new GLib.Variant('(ub)', [winid, state]),
            Gio.DBusCallFlags.NONE,
            -1,
            null
        )
    }
    setOnAllWorkspaces(winid, state) {
        this._proxy.call_sync(
            'SetOnAllWorkspaces',
            new GLib.Variant('(ub)', [winid, state]),
            Gio.DBusCallFlags.NONE,
            -1,
            null
        )
    }
    setAbove(winid, state) {
        this._proxy.call_sync('SetAbove', new GLib.Variant('(ub)', [winid, state]), Gio.DBusCallFlags.NONE, -1, null)
    }

    // Friendly wrapper methods for common operations
    list() {
        const result = this._proxy.call_sync('List', null, Gio.DBusCallFlags.NONE, -1, null)
        const windowListStr = result.get_child_value(0).get_string()[0]
        return JSON.parse(windowListStr)
    }

    listNormalWindows() {
        const result = this._proxy.call_sync('ListNormalWindows', null, Gio.DBusCallFlags.NONE, -1, null)
        const windowListStr = result.get_child_value(0).get_string()[0]
        return JSON.parse(windowListStr)
    }

    getDetails(winid) {
        const result = this._proxy.call_sync(
            'GetDetails',
            new GLib.Variant('(u)', [winid]),
            Gio.DBusCallFlags.NONE,
            -1,
            null
        )
        const detailsStr = result.get_child_value(0).get_string()[0]
        return JSON.parse(detailsStr)
    }

    getFrameRect(winid) {
        const result = this._proxy.call_sync(
            'GetFrameRect',
            new GLib.Variant('(u)', [winid]),
            Gio.DBusCallFlags.NONE,
            -1,
            null
        )
        const rectStr = result.get_child_value(0).get_string()[0]
        return JSON.parse(rectStr)
    }

    getBufferRect(winid) {
        const result = this._proxy.call_sync(
            'GetBufferRect',
            new GLib.Variant('(u)', [winid]),
            Gio.DBusCallFlags.NONE,
            -1,
            null
        )
        const rectStr = result.get_child_value(0).get_string()[0]
        return JSON.parse(rectStr)
    }

    getTitle(winid) {
        const result = this._proxy.call_sync(
            'GetTitle',
            new GLib.Variant('(u)', [winid]),
            Gio.DBusCallFlags.NONE,
            -1,
            null
        )
        return result.get_child_value(0).get_string()[0]
    }

    getFocusedMonitorDetails() {
        const result = this._proxy.call_sync('GetFocusedMonitorDetails', null, Gio.DBusCallFlags.NONE, -1, null)
        const detailsStr = result.get_child_value(0).get_string()[0]
        return JSON.parse(detailsStr)
    }

    // Utility methods that combine multiple operations
    getAllWindowDetails() {
        const windows = this.list()
        return windows.map((window) => {
            try {
                return {
                    ...window,
                    details: this.getDetails(window.id),
                }
            } catch (error) {
                return {
                    ...window,
                    details: null,
                    error: error.message,
                }
            }
        })
    }

    getWindowIdentifiers() {
        const windows = this.list()
        return windows.map((window) => {
            try {
                const details = this.getDetails(window.id)
                return {
                    id: window.id,
                    wm_class: details.wm_class || 'unknown',
                    title: details.title || 'untitled',
                }
            } catch (error) {
                return {
                    id: window.id,
                    wm_class: 'error',
                    title: error.message,
                }
            }
        })
    }
}

export class DbusClient {
    constructor() {
        this._proxy = null
        this._executor = null
        this._signalId = null
    }

    async connect(onWindowModifiedCallback = null) {
        return new Promise((resolve, reject) => {
            try {
                const nodeInfo = Gio.DBusNodeInfo.new_for_xml(DBUS_DEFINITION)
                const interfaceInfo = nodeInfo.interfaces[0]

                this._proxy = new Gio.DBusProxy({
                    g_bus_type: Gio.BusType.SESSION,
                    g_name: DBUS_NAME,
                    g_object_path: DBUS_PATH,
                    g_interface_name: DBUS_INTERFACE,
                    g_interface_info: interfaceInfo,
                })

                this._proxy.init_async(GLib.PRIORITY_DEFAULT, null, (proxy, result) => {
                    try {
                        proxy.init_finish(result)
                        this._executor = new DbusExecutor(this._proxy)

                        if (onWindowModifiedCallback) {
                            this._signalId = this._proxy.connectSignal(
                                'WindowModified',
                                (proxy, sender, [winid, eventType, detailsJson]) => {
                                    onWindowModifiedCallback(winid, eventType, detailsJson)
                                }
                            )
                        }
                        resolve()
                    } catch (error) {
                        reject(error)
                    }
                })
            } catch (error) {
                reject(error)
            }
        })
    }

    connectSync(onWindowModifiedCallback = null) {
        try {
            const nodeInfo = Gio.DBusNodeInfo.new_for_xml(DBUS_DEFINITION)
            const interfaceInfo = nodeInfo.interfaces[0]

            this._proxy = new Gio.DBusProxy({
                g_bus_type: Gio.BusType.SESSION,
                g_name: DBUS_NAME,
                g_object_path: DBUS_PATH,
                g_interface_name: DBUS_INTERFACE,
                g_interface_info: interfaceInfo,
            })

            this._proxy.init(null)
            this._executor = new DbusExecutor(this._proxy)

            if (onWindowModifiedCallback) {
                this._signalId = this._proxy.connectSignal(
                    'WindowModified',
                    (proxy, sender, [winid, eventType, detailsJson]) => {
                        onWindowModifiedCallback(winid, eventType, detailsJson)
                    }
                )
            }
        } catch (error) {
            throw new Error(`Failed to connect to WindowControl extension: ${error.message}`)
        }
    }

    disconnect() {
        if (this._signalId && this._proxy) {
            this._proxy.disconnectSignal(this._signalId)
            this._signalId = null
        }
        this._proxy = null
        this._executor = null
    }

    getExecutor() {
        return this._executor
    }
}
