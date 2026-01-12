"use strict";

import { debug } from "./lib/utils.js";
import { parseOverrides, SYNC_MODE_IGNORE, SYNC_MODE_RESTORE } from "./common.js";

export const CURRENT_CONFIG_VERSION = 37;

// Convert action values from numbers (0/1) to strings ("IGNORE"/"RESTORE")
function normalizeActionToString(action) {
  if (action === SYNC_MODE_IGNORE || action === "IGNORE") return "IGNORE";
  if (action === SYNC_MODE_RESTORE || action === "RESTORE") return "RESTORE";
  return action;
}

// Converts old override format to new format
// - Converts action values from numbers (0/1) to strings ("IGNORE"/"RESTORE")
// - Converts { query: { title } } format to flat { title } format
function migrateOverrides(overrides) {
  Object.values(overrides).forEach((wshos) => {
    if (!Array.isArray(wshos)) return;
    wshos.forEach((o) => {
      // Convert action to string format expected by state-matcher.js
      if (o.action !== undefined) {
        o.action = normalizeActionToString(o.action);
      }
      // Convert old { query: { title } } format to new { title } format
      if (o.query && o.query.title !== undefined) {
        o.title = o.query.title;
        delete o.query;
      }
    });
  });
  return overrides;
}

// Main migration entry point - call this on extension enable
export function migrateSettings(settings) {
  const configVersion = settings.get_int("config-version");
  if (configVersion >= CURRENT_CONFIG_VERSION) return;

  // Check if this is a fresh install (no data to migrate)
  const savedWindows = settings.get_string("saved-windows");
  const overridesStr = settings.get_string("overrides");
  const isFreshInstall = configVersion === 0 &&
    (savedWindows === "{}" || savedWindows === "[]" || savedWindows === "") &&
    (overridesStr === "{}" || overridesStr === "");

  if (isFreshInstall) {
    debug("migrations", "Fresh install detected, skipping migration");
    settings.set_int("config-version", CURRENT_CONFIG_VERSION);
    return;
  }

  debug("migrations", `Migrating settings from version ${configVersion} to ${CURRENT_CONFIG_VERSION}`);

  if (configVersion < 36) {
    // Clear saved windows - format is incompatible between versions
    settings.set_string("saved-windows", "{}");

    // Migrate overrides: convert action numbers to strings and query format to flat format
    const overrides = migrateOverrides(parseOverrides(overridesStr));
    settings.set_string("overrides", JSON.stringify(overrides));

    debug("migrations", "Migration complete: saved windows cleared, overrides converted to new format");
  }

  if (configVersion < 37) {
    // v37: Added LIFO connector preference for monitor selection
    // Clear saved windows since old configs don't have connectorPreference field
    // and monitor selection behavior has changed
    settings.set_string("saved-windows", "{}");
    debug("migrations", "Migration v37: saved windows cleared for connector preference feature");
  }

  settings.set_int("config-version", CURRENT_CONFIG_VERSION);
}
