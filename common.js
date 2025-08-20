"use strict";

export const SECONDS_PER_HOUR = 3600;

// D-Bus constants
export const DBUS_NAME = "org.gnome.shell.extensions.SmartAutoMove";
export const DBUS_PATH = "/org/gnome/shell/extensions/SmartAutoMove";
export const DBUS_INTERFACE = `
<node>
  <interface name="org.gnome.shell.extensions.SmartAutoMove">
    <method name="ListWindows">
      <arg type="s" direction="out" name="windows_json"/>
    </method>
    <method name="RefreshFromCurrentActors">
    </method>
  </interface>
</node>
`;

// Settings constants for prefs.js
export const SETTINGS_KEY_DEBUG_LOGGING = "debug-logging";
export const SETTINGS_KEY_CONFIG_VERSION = "config-version";
export const SETTINGS_KEY_SAVED_WINDOWS = "saved-windows";
export const SETTINGS_KEY_OVERRIDES = "overrides";
export const SETTINGS_KEY_MATCH_THRESHOLD = "match-threshold";

// Sync mode constants
export const SYNC_MODE_IGNORE = 0;
export const SYNC_MODE_RESTORE = 1;
export const SYNC_MODE_DEFAULT = "DEFAULT";

// Settings configuration for prefs.js binding
export const SETTINGS_CONFIG = [
  {
    key: "debug-logging",
    property: "active",
    widgetId: "debug-logging-switch",
  },
  {
    key: "new-window-max-wait-ms",
    property: "value",
    widgetId: "new-window-max-wait-spin",
  },
  {
    key: "new-window-title-stability-ms",
    property: "value",
    widgetId: "new-window-title-stability-spin",
  },
  {
    key: "generic-title-max-length",
    property: "value",
    widgetId: "generic-title-max-length-spin",
  },
  {
    key: "ambiguity-threshold",
    property: "value",
    widgetId: "ambiguity-threshold-generic-spin",
  },
  {
    key: "min-score-spread",
    property: "value",
    widgetId: "min-score-spread-spin",
  },
  {
    key: "generic-title-extended-wait",
    property: "value",
    widgetId: "generic-title-extended-wait-spin",
  },
  {
    key: "max-unseen-age",
    property: "value",
    widgetId: "max-unseen-age-spin",
  },
  {
    key: "match-threshold",
    property: "value",
    widgetId: "match-threshold-spin",
  },
  {
    key: "sync-mode",
    property: "active-id",
    widgetId: "sync-mode-combo",
  },
  {
    key: "freeze-saves",
    property: "active",
    widgetId: "freeze-saves-switch",
  },
  {
    key: "activate-workspace",
    property: "active",
    widgetId: "activate-workspace-switch",
  },
  {
    key: "ignore-position",
    property: "active",
    widgetId: "ignore-position-switch",
  },
  {
    key: "ignore-workspace",
    property: "active",
    widgetId: "ignore-workspace-switch",
  },
  {
    key: "ignore-monitor",
    property: "active",
    widgetId: "ignore-monitor-switch",
  },
];

export function getActionId(action) {
  if (action === SYNC_MODE_IGNORE || action === "IGNORE") return "IGNORE";
  if (action === SYNC_MODE_RESTORE || action === "RESTORE") return "RESTORE";
  return "DEFAULT";
}

export function parseOverrides(overridesStr) {
  try {
    return JSON.parse(overridesStr || "{}");
  } catch (e) {
    return {};
  }
}

export function deleteNonOccupiedWindows(savedWindows) {
  Object.keys(savedWindows).forEach((wsh) => {
    savedWindows[wsh] = savedWindows[wsh].filter((sw) => sw.occupied);
    if (savedWindows[wsh].length === 0) {
      delete savedWindows[wsh];
    }
  });
}

export function ignoreSavedWindow(
  savedWindows,
  overrides,
  wsh,
  swi,
  threshold,
  ignoreAny,
) {
  if (!savedWindows[wsh] || !savedWindows[wsh][swi]) return;

  const sw = savedWindows[wsh][swi];

  if (!overrides[wsh]) {
    overrides[wsh] = [];
  }

  if (ignoreAny) {
    overrides[wsh].push({
      action: "IGNORE",
      threshold: threshold,
    });
  } else {
    overrides[wsh].unshift({
      title: sw.title,
      action: "IGNORE",
    });
  }
}
