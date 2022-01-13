'use strict';

// setting constants
var SETTINGS_SCHEMA = 'org.gnome.shell.extensions.smart-auto-move';
var SETTINGS_KEY_SAVED_WINDOWS = 'saved-windows';
var SETTINGS_KEY_DEBUG_LOGGING = 'debug-logging';
var SETTINGS_KEY_STARTUP_DELAY = 'startup-delay';
var SETTINGS_KEY_SYNC_FREQUENCY = 'sync-frequency';
var SETTINGS_KEY_SAVE_FREQUENCY = 'save-frequency';
var SETTINGS_KEY_MATCH_THRESHOLD = 'match-threshold';
var SETTINGS_KEY_SYNC_MODE = 'sync-mode';
var SETTINGS_KEY_OVERRIDES = 'overrides';

// sync mode enum values
const SYNC_MODE_IGNORE = 0;
const SYNC_MODE_RESTORE = 1;

// default setting values (see also gschema xml)
const DEFAULT_DEBUG_LOGGING = false;
const DEFAULT_STARTUP_DELAY_MS = 2500;
const DEFAULT_SYNC_FREQUENCY_MS = 100;
const DEFAULT_SAVE_FREQUENCY_MS = 1000;
const DEFAULT_MATCH_THRESHOLD = 0.7;
const DEFAULT_SYNC_MODE = SYNC_MODE_RESTORE;