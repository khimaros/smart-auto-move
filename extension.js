"use strict";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import Gio from "gi://Gio";
import { WindowManager } from "./lib/window-manager.js";
import { createGSettingsStorage } from "./lib/state-session.js";
import { debug, setDebugEnabled } from "./lib/utils.js";
import {
  DBUS_NAME,
  DBUS_PATH,
  DBUS_INTERFACE,
  SECONDS_PER_HOUR,
  getActionId,
  parseOverrides,
} from "./common.js";
import { migrateSettings } from "./migrations.js";

// Declarative settings handlers for cleaner change management
const SETTING_HANDLERS = {
  "debug-logging": {
    type: "boolean",
    apply: (value) => setDebugEnabled(value),
  },
  "max-unseen-age": {
    type: "int",
    field: "_maxUnseenAge",
    apply: (value, ext) => ext._cleanupStaleEntries(),
  },
  "freeze-saves": {
    type: "boolean",
    field: "_freezeSaves",
    apply: (value, ext) => {
      if (ext._helper?.getSession()) {
        ext._helper.getSession()._readOnly = value;
      }
    },
  },
  "activate-workspace": {
    type: "boolean",
    field: "_activateWorkspace",
    apply: (value, ext) => {
      if (ext._helper?.getExecutor()) {
        ext._helper.getExecutor()._config.activate_on_move = value;
      }
    },
  },
  "ignore-position": { type: "boolean", field: "_ignorePosition" },
  "ignore-workspace": { type: "boolean", field: "_ignoreWorkspace" },
  "ignore-monitor": { type: "boolean", field: "_ignoreMonitor" },
  "sync-mode": {
    type: "enum",
    field: "_syncMode",
    transform: (value) => getActionId(value),
    apply: (value, ext) => ext._helper.updateConfig({ DEFAULT_SYNC_MODE: value }),
  },
  "match-threshold": {
    type: "double",
    field: "_matchThreshold",
    apply: (value, ext) => ext._helper.updateConfig({ DEFAULT_MATCH_THRESHOLD: value }),
  },
  "overrides": {
    type: "string",
    field: "_overrides",
    transform: (value) => parseOverrides(value),
    apply: (value, ext) => ext._helper.updateConfig({ OVERRIDES: value }),
  },
  "saved-windows": {
    type: "string",
    apply: (value, ext) => {
      try {
        const newState = JSON.parse(value || "{}");
        ext._helper.getTracker()?.restoreFromState(newState);
      } catch (e) {
        debug("extension", `Error restoring state from GSettings: ${e.message}`, true);
      }
    },
  },
};

class SmartAutoMoveService {
  constructor(extension) {
    this._extension = extension;
  }

  ListWindows() {
    debug("extension", "ListWindows D-Bus method called");
    if (
      this._extension._helper &&
      this._extension._helper.getExecutor()
    ) {
      const windows = this._extension._helper
        .getExecutor()
        .listNormalWindows();
      debug("extension", `ListWindows found ${windows.length} windows`);
      return JSON.stringify(windows);
    }
    return JSON.stringify([]);
  }

  RefreshFromCurrentActors() {
    debug("extension", "RefreshFromCurrentActors D-Bus method called");
    if (this._extension._helper) {
      this._extension._helper.refreshWindowState();
    }
  }
}

export default class SmartAutoMove extends Extension {
  enable() {
    this._setupDBus();
    this._settings = this.getSettings();
    this._migrateSettingsIfNeeded();
    this._loadExtensionSettings();

    setDebugEnabled(this._settings.get_boolean("debug-logging"));

    this._helper = new WindowManager({
      config: this._createConfigFromSettings(),
      stateLoader: createGSettingsStorage(this._settings, "saved-windows").stateLoader,
      stateSaver: (state) => this._saveState(state),
      readOnly: this._freezeSaves,
      executorConfig: { activate_on_move: this._activateWorkspace },
      operationFilter: (op) => this._operationFilter(op)
    });

    this._helper.enable();
    this._cleanupStaleEntries();

    this._settingsId = this._settings.connect("changed", (settings, key) => {
      this._handleSettingChanged(key);
    });

    debug("extension", "SmartAutoMove extension enabled");
  }

  _setupDBus() {
    this._dbusImpl = new SmartAutoMoveService(this);
    this._dbusExport = Gio.DBusExportedObject.wrapJSObject(DBUS_INTERFACE, this._dbusImpl);
    this._ownerId = Gio.bus_own_name(
      Gio.BusType.SESSION,
      DBUS_NAME,
      Gio.BusNameOwnerFlags.NONE,
      () => {},
      (connection, name) => {
        debug("extension", `D-Bus name ${name} acquired, exporting service`);
        this._dbusExport.export(connection, DBUS_PATH);
      },
      () => {
        debug("extension", "D-Bus name lost");
        if (this._dbusExport) this._dbusExport.unexport();
      }
    );
  }

  _saveState(state) {
    if (this._settingsId) {
      this._settings.block_signal_handler(this._settingsId);
    }
    try {
      this._settings.set_string("saved-windows", JSON.stringify(state));
    } catch (e) {
      debug("extension", `Error saving state: ${e.message}`, true);
    } finally {
      if (this._settingsId) {
        this._settings.unblock_signal_handler(this._settingsId);
      }
    }
  }

  disable() {
    debug("extension", "SmartAutoMove extension disabled");

    if (this._settingsId) {
      this._settings.disconnect(this._settingsId);
      this._settingsId = null;
    }

    if (this._helper) {
      this._helper.disable();
      this._helper = null;
    }

    if (this._dbusExport) {
      this._dbusExport.unexport();
      this._dbusExport = null;
    }
    if (this._ownerId) {
      Gio.bus_unown_name(this._ownerId);
      this._ownerId = null;
    }
    this._dbusImpl = null;
    this._settings = null;
  }

  _migrateSettingsIfNeeded() {
    migrateSettings(this._settings);
  }

  _cleanupStaleEntries() {
    if (this._helper && this._maxUnseenAge > 0) {
      const hours = this._maxUnseenAge / SECONDS_PER_HOUR;
      this._helper.getSession().cleanupStaleEntries(hours);
    }
  }

  _operationFilter(op) {
    if (this._ignorePosition && (op.type === "Place" || op.type === "Move")) return false;
    if (this._ignoreWorkspace && op.type === "MoveToWorkspace") return false;
    if (this._ignoreMonitor && op.type === "MoveToMonitor") return false;
    return true;
  }

  _loadExtensionSettings() {
    for (const [key, handler] of Object.entries(SETTING_HANDLERS)) {
      if (handler.field) {
        const rawValue = this._getSettingValue(key, handler.type);
        this[handler.field] = handler.transform ? handler.transform(rawValue) : rawValue;
      }
    }
  }

  _getSettingValue(key, type) {
    switch (type) {
      case "boolean": return this._settings.get_boolean(key);
      case "int": return this._settings.get_int(key);
      case "double": return this._settings.get_double(key);
      case "enum": return this._settings.get_enum(key);
      case "string": return this._settings.get_string(key);
      default: return this._settings.get_string(key);
    }
  }

  _handleSettingChanged(key) {
    const handler = SETTING_HANDLERS[key];
    if (!handler) {
      this._helper.updateConfig(this._createConfigFromSettings());
      return;
    }

    const rawValue = this._getSettingValue(key, handler.type);
    const value = handler.transform ? handler.transform(rawValue) : rawValue;

    if (handler.field) {
      this[handler.field] = value;
    }
    if (handler.apply) {
      handler.apply(value, this);
    }
  }

  _createConfigFromSettings() {
    return {
      SETTLE_IDLE_TIMEOUT: this._settings.get_int("new-window-title-stability-ms"),
      SETTLE_MAX_WAIT: this._settings.get_int("new-window-max-wait-ms"),
      GENERIC_TITLE_EXTENDED_WAIT: this._settings.get_int("generic-title-extended-wait"),
      MIN_SCORE_SPREAD: this._settings.get_double("min-score-spread"),
      AMBIGUOUS_SIMILARITY_THRESHOLD: this._settings.get_double("ambiguity-threshold"),
      MIN_SPECIFIC_TITLE_LENGTH: this._settings.get_int("generic-title-max-length"),
      OVERRIDES: this._overrides,
      DEFAULT_SYNC_MODE: this._syncMode,
      DEFAULT_MATCH_THRESHOLD: this._matchThreshold,
    };
  }
}
