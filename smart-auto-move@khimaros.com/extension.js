'use strict';

// imports
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const St = imports.gi.St;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

// setting constants
const SETTINGS_SCHEMA = 'org.gnome.shell.extensions.smart-auto-move';
const SETTINGS_KEY_SAVED_WINDOWS = 'saved-windows';
const SETTINGS_KEY_DEBUG_LOGGING = 'debug-logging';
const SETTINGS_KEY_STARTUP_DELAY = 'startup-delay';
const SETTINGS_KEY_SYNC_FREQUENCY = 'sync-frequency';
const SETTINGS_KEY_SAVE_FREQUENCY = 'save-frequency';
const SETTINGS_KEY_MATCH_THRESHOLD = 'match-threshold';
const SETTINGS_KEY_SYNC_MODE = 'sync-mode';
const SETTINGS_KEY_OVERRIDES = 'overrides';

const SYNC_MODE_IGNORE = 0;
const SYNC_MODE_RESTORE = 1;

// default setting values (see also gschema xml)
const DEFAULT_DEBUG_LOGGING = false;
const DEFAULT_STARTUP_DELAY_MS = 2500;
const DEFAULT_SYNC_FREQUENCY_MS = 100;
const DEFAULT_SAVE_FREQUENCY_MS = 1000;
const DEFAULT_MATCH_THRESHOLD = 0.7;
const DEFAULT_SYNC_MODE = SYNC_MODE_RESTORE;

// settings backed state
let debugLogging;
let startupDelayMs;
let syncFrequencyMs;
let saveFrequencyMs;
let matchThreshold;
let savedWindows;
let syncMode;
let overrides;

// mutable runtime state
let activeWindows;
let settings;

// signal descriptors
let timeoutSyncSignal;
let timeoutSaveSignal;
let changedDebugLoggingSignal;
let changedStartupDelaySignal;
let changedSyncFrequencySignal;
let changedSaveFrequencySignal;
let changedMatchThresholdSignal;
let changedSyncModeSignal;
let changedOverridesSignal;

//// EXTENSION LIFECYCLE

function init() {
	debug('init()');
}

function enable() {
	activeWindows = new Map();

	initializeSettings();

	debug('enable()');

	restoreSettings();

	connectSignals();
}

function disable() {
	debug('disable()');

	disconnectSignals();

	saveSettings();

	cleanupSettings();

	activeWindows = null;
}

//// SETTINGS

function initializeSettings() {
	settings = ExtensionUtils.getSettings(SETTINGS_SCHEMA);
	debugLogging = DEFAULT_DEBUG_LOGGING;
	startupDelayMs = DEFAULT_STARTUP_DELAY_MS;
	syncFrequencyMs = DEFAULT_SYNC_FREQUENCY_MS;
	saveFrequencyMs = DEFAULT_SAVE_FREQUENCY_MS;
	matchThreshold = DEFAULT_MATCH_THRESHOLD;
	savedWindows = new Object();
	syncMode = DEFAULT_SYNC_MODE;
	overrides = new Object();

	handleChangedDebugLogging();
}

function cleanupSettings() {
	settings = null;
	debugLogging = null;
	startupDelayMs = null;
	syncFrequencyMs = null;
	saveFrequencyMs = null;
	matchThreshold = null;
	savedWindows = null;
	syncMode = null;
	overrides = null;
}

function restoreSettings() {
	debug('restoreSettings()');
	savedWindows = JSON.parse(settings.get_string(SETTINGS_KEY_SAVED_WINDOWS));
	handleChangedDebugLogging();
	handleChangedStartupDelay();
	handleChangedSyncFrequency();
	handleChangedSaveFrequency();
	handleChangedMatchThreshold();
	handleChangedSyncMode();
	handleChangedOverrides();
	dumpSavedWindows();
}

function saveSettings() {
	settings.set_boolean(SETTINGS_KEY_DEBUG_LOGGING, debugLogging);
	settings.set_int(SETTINGS_KEY_STARTUP_DELAY, startupDelayMs);
	settings.set_int(SETTINGS_KEY_SYNC_FREQUENCY, syncFrequencyMs);
	settings.set_int(SETTINGS_KEY_SAVE_FREQUENCY, saveFrequencyMs);
	settings.set_double(SETTINGS_KEY_MATCH_THRESHOLD, matchThreshold);
	settings.set_enum(SETTINGS_KEY_SYNC_MODE, syncMode);
	let newOverrides = JSON.stringify(overrides);
	settings.set_string(SETTINGS_KEY_OVERRIDES, newOverrides);
	let oldSavedWindows = settings.get_string(SETTINGS_KEY_SAVED_WINDOWS);
	let newSavedWindows = JSON.stringify(savedWindows);
	if (oldSavedWindows === newSavedWindows) return;
	debug('saveSettings()');
	dumpSavedWindows();
	settings.set_string(SETTINGS_KEY_SAVED_WINDOWS, newSavedWindows);
}

//// WINDOW UTILITIES

function windowReady(win) {
	let win_rect = win.get_frame_rect();
	//if (win.get_title() === 'Loading…') return false;
	if (win_rect.width === 0 && win_rect.height === 0) return false;
	if (win_rect.x === 0 && win_rect.y === 0) return false;
	return true;
}

function windowData(win) {
	let win_rect = win.get_frame_rect();
	return {
		id: win.get_id(),
		hash: windowHash(win),
		sequence: win.get_stable_sequence(),
		title: win.get_title(),
		workspace: win.get_workspace().index(),
		maximized: win.get_maximized(),
		x: win_rect.x,
		y: win_rect.y,
		width: win_rect.width,
		height: win_rect.height,
		occupied: true,
	}
}

function windowRepr(win) {
	return JSON.stringify(windowData(win));
}

function windowSectionHash(win) {
	return win.get_wm_class();
}

function windowHash(win) {
	return win.get_id();
}

function windowDataEqual(sw1, sw2) {
	return JSON.stringify(sw1) === JSON.stringify(sw2);
}

function windowNewerThan(win, age) {
	let wh = windowHash(win);

	// TODO: consider using a state machine here: CREATED, MOVED, SAVED, etc.
	if (activeWindows.get(wh) === undefined) {
		activeWindows.set(wh, Date.now());
	}

	return (Date.now() - activeWindows.get(wh) < age);
}

//// WINDOW SAVE / RESTORE

function pushSavedWindow(win) {
	let wsh = windowSectionHash(win);
	//debug('pushSavedWindow() - start: ' + wsh + ', ' + win.get_title());
	if (wsh === null) return false;
	if (!savedWindows.hasOwnProperty(wsh))
		savedWindows[wsh] = new Array();
	let sw = windowData(win);
	savedWindows[wsh].push(sw);
	debug('pushSavedWindow() - pushed: ' + JSON.stringify(sw));
	return true;
}

function updateSavedWindow(win) {
	let wsh = windowSectionHash(win);
	//debug('updateSavedWindow() - start: ' + wsh + ', ' + win.get_title());
	let swi = findSavedWindow(wsh, { hash: windowHash(win) }, 1.0);
	if (swi === undefined)
		return false;
	let sw = windowData(win);
	if (windowDataEqual(savedWindows[wsh][swi], sw)) return true;
	savedWindows[wsh][swi] = sw;
	debug('updateSavedWindow() - updated: ' + swi + ', ' + JSON.stringify(sw));
	return true;
}

function ensureSavedWindow(win) {
	let wh = windowHash(win);

	if (windowNewerThan(win, startupDelayMs)) return;

	//debug('saveWindow(): ' + win.get_id());
	if (!updateSavedWindow(win)) {
		pushSavedWindow(win);
	}
}

function levensteinDistance(a, b) {
	var m = [], i, j, min = Math.min;

	if (!(a && b)) return (b || a).length;

	for (i = 0; i <= b.length; m[i] = [i++]);
	for (j = 0; j <= a.length; m[0][j] = j++);

	for (i = 1; i <= b.length; i++) {
		for (j = 1; j <= a.length; j++) {
			m[i][j] = b.charAt(i - 1) == a.charAt(j - 1)
				? m[i - 1][j - 1]
				: m[i][j] = min(
					m[i - 1][j - 1] + 1,
					min(m[i][j - 1] + 1, m[i - 1][j] + 1))
		}
	}

	return m[b.length][a.length];
}

function scoreWindow(sw, query) {
	//debug('scoreWindow() - search: ' + JSON.stringify(sw) + ' ?= ' + JSON.stringify(query));
	if (query.occupied !== undefined && sw.occupied != query.occupied) return 0;
	let match_parts = 0;
	let query_parts = 0;
	Object.keys(query).forEach(function (key) {
		let value = query[key];
		if (key === 'title') {
			let dist = levensteinDistance(value, sw[key]);
			match_parts += (value.length - dist) / value.length;
		} else if (sw[key] === value) {
			match_parts += 1;
		}
		query_parts += 1;
	});
	let score = match_parts / query_parts;
	return score;
}

function findOverrideAction(win, threshold) {
	let wsh = windowSectionHash(win);
	let sw = windowData(win);

	let action = syncMode;
	let matched = false;

	if (!overrides.hasOwnProperty(wsh)) {
		//debug('findOverrideAction(): no overrides for section ' + wsh);
		return action;
	}
	overrides[wsh].forEach(function (o, oi) {
		if (matched) return;
		if (!o.hasOwnProperty('query')) {
			action = o.action;
			matched = true;
			return;
		}
		let score = scoreWindow(sw, o.query);
		if (score >= threshold) {
			action = o.action;
			matched = true;
			return;
		}
	});

	//debug('findOverrideAction(): ' + wsh + ' ' + JSON.stringify(sw) + ' ' + action);
	return action;
}

function findSavedWindow(wsh, query, threshold) {
	if (!savedWindows.hasOwnProperty(wsh)) {
		//debug('findSavedWindow() - no such window section: ' + wsh)
		return undefined;
	}

	let scores = new Map();
	savedWindows[wsh].forEach(function (sw, swi) {
		let score = scoreWindow(sw, query);
		scores.set(swi, score);
	});

	let sorted_scores = new Map([...scores.entries()].sort((a, b) => b[1] - a[1]));

	//debug('findSavedWindow() - sorted_scores: ' + JSON.stringify(Array.from(sorted_scores.entries())));

	let best_swi = sorted_scores.keys().next().value;
	let best_score = sorted_scores.get(best_swi);

	let found = undefined;
	if (best_score >= threshold)
		found = best_swi;

	//debug('findSavedWindow() - found: ' + found + ' ' + ' ' + best_score + JSON.stringify(savedWindows[wsh][found]));

	return found;
}

function moveWindow(win, sw) {
	//debug('moveWindow(): ' + JSON.stringify(sw));
	let ws = global.workspaceManager.get_workspace_by_index(sw.workspace);
	win.change_workspace(ws);
	win.move_resize_frame(false, sw.x, sw.y, sw.width, sw.height);
	if (sw.maximized) win.maximize(sw.maximized);

	// NOTE: these additional move/maximize operations were needed in order
	// to convince Firefox to stay where we put it.
	win.move_resize_frame(false, sw.x, sw.y, sw.width, sw.height);
	if (sw.maximized) win.maximize(sw.maximized);
	win.move_resize_frame(false, sw.x, sw.y, sw.width, sw.height);

	let nsw = windowData(win);

	return nsw;
}

function restoreWindow(win) {
	let wsh = windowSectionHash(win);

	let swi = findSavedWindow(wsh, { hash: windowHash(win), occupied: true }, 1.0);

	if (swi !== undefined) return false;

	swi = findSavedWindow(wsh, { title: win.get_title(), occupied: false }, matchThreshold);

	if (swi === undefined) return false;

	if (!windowReady(win)) return true;

	let sw = savedWindows[wsh][swi];

	if (windowDataEqual(sw, windowData(win))) return true;

	//debug('restoreWindow() - found: ' + JSON.stringify(sw));

	let pWinRepr = windowRepr(win);

	let nsw = moveWindow(win, sw);

	if (!(sw.x === nsw.x && sw.y === nsw.y)) return true;

	debug('restoreWindow() - moved: ' + pWinRepr + ' => ' + JSON.stringify(nsw));

	savedWindows[wsh][swi] = nsw;

	return true;
}

function cleanupWindows() {
	let found = new Map();

	global.get_window_actors().forEach(function (actor) {
		let win = actor.get_meta_window();
		found.set(windowHash(win), true);
	});

	Object.keys(savedWindows).forEach(function (wsh) {
		let sws = savedWindows[wsh];
		sws.forEach(function (sw) {
			if (sw.occupied && !found.has(sw.hash)) {
				sw.occupied = false;
				debug('cleanupWindows() - deoccupy: ' + JSON.stringify(sw));
			}
		});
	});
}

function syncWindows() {
	cleanupWindows();
	global.get_window_actors().forEach(function (actor) {
		let win = actor.get_meta_window();

		let action = findOverrideAction(win, 1.0);
		if (action !== SYNC_MODE_RESTORE) return false;

		if (!restoreWindow(win))
			ensureSavedWindow(win);
	});
}

//// SIGNAL HANDLERS

function handleTimeoutSave() {
	//debug('handleTimeoutSave(): ' + JSON.stringify(savedWindows));
	saveSettings();
	timeoutSaveSignal = Mainloop.timeout_add(saveFrequencyMs, handleTimeoutSave);
}

function handleTimeoutSync() {
	//debug('handleTimeoutSync()');
	syncWindows();
	timeoutSyncSignal = Mainloop.timeout_add(syncFrequencyMs, handleTimeoutSync);
}

function handleChangedDebugLogging() {
	debugLogging = settings.get_boolean(SETTINGS_KEY_DEBUG_LOGGING);
	log('[smart-auto-move] handleChangedDebugLogging(): ' + debugLogging);
}

function handleChangedStartupDelay() {
	startupDelayMs = settings.get_int(SETTINGS_KEY_STARTUP_DELAY);
	debug('handleChangedStartupDelay(): ' + startupDelayMs);
}

function handleChangedSyncFrequency() {
	syncFrequencyMs = settings.get_int(SETTINGS_KEY_SYNC_FREQUENCY);
	debug('handleChangedSyncFrequency(): ' + syncFrequencyMs);
}

function handleChangedSaveFrequency() {
	saveFrequencyMs = settings.get_int(SETTINGS_KEY_SAVE_FREQUENCY);
	debug('handleChangedSaveFrequency(): ' + saveFrequencyMs);
}

function handleChangedMatchThreshold() {
	matchThreshold = settings.get_double(SETTINGS_KEY_MATCH_THRESHOLD);
	debug('handleChangedMatchThreshold(): ' + matchThreshold);
}

function handleChangedSyncMode() {
	syncMode = settings.get_enum(SETTINGS_KEY_SYNC_MODE);
	debug('handleChangedSyncMode(): ' + syncMode);
}

function handleChangedOverrides() {
	overrides = JSON.parse(settings.get_string(SETTINGS_KEY_OVERRIDES));
	debug('handleChangedOverrides(): ' + JSON.stringify(overrides));
}

//// SIGNAL HELPERS

function connectSignals() {
	addTimeouts();
	connectSettingChangedSignals();
}

function disconnectSignals() {
	debug('disconnectingSignals()');
	removeTimeouts();
	disconnectSettingChangedSignals();
}

function addTimeouts() {
	timeoutSyncSignal = Mainloop.timeout_add(syncFrequencyMs, handleTimeoutSync);
	timeoutSaveSignal = Mainloop.timeout_add(saveFrequencyMs, handleTimeoutSave);
}

function removeTimeouts() {
	Mainloop.source_remove(timeoutSyncSignal);
	timeoutSyncSignal = null;

	Mainloop.source_remove(timeoutSaveSignal);
	timeoutSaveSignal = null;
}

function connectSettingChangedSignals() {
	changedDebugLoggingSignal = settings.connect('changed::' + SETTINGS_KEY_DEBUG_LOGGING, handleChangedDebugLogging);
	changedStartupDelaySignal = settings.connect('changed::' + SETTINGS_KEY_STARTUP_DELAY, handleChangedStartupDelay);
	changedSyncFrequencySignal = settings.connect('changed::' + SETTINGS_KEY_SYNC_FREQUENCY, handleChangedSyncFrequency);
	changedSaveFrequencySignal = settings.connect('changed::' + SETTINGS_KEY_SAVE_FREQUENCY, handleChangedSaveFrequency);
	changedMatchThresholdSignal = settings.connect('changed::' + SETTINGS_KEY_MATCH_THRESHOLD, handleChangedMatchThreshold);
	changedSyncModeSignal = settings.connect('changed::' + SETTINGS_KEY_SYNC_MODE, handleChangedSyncMode);
	changedOverridesSignal = settings.connect('changed::' + SETTINGS_KEY_OVERRIDES, handleChangedOverrides);
}

function disconnectSettingChangedSignals() {
	settings.disconnect(changedDebugLoggingSignal);
	settings.disconnect(changedStartupDelaySignal);
	settings.disconnect(changedSyncFrequencySignal);
	settings.disconnect(changedSaveFrequencySignal);
	settings.disconnect(changedMatchThresholdSignal);
	settings.disconnect(changedSyncModeSignal);
	settings.disconnect(changedOverridesSignal);

	changedDebugLoggingSignal = null;
	changedStartupDelaySignal = null;
	changedSyncFrequencySignal = null;
	changedSaveFrequencySignal = null;
	changedMatchThresholdSignal = null;
	changedSyncModeSignal = null;
	changedOverridesSignal = null;
}

//// DEBUG UTILITIES

function debug(message) {
	if (debugLogging) {
		log('[smart-auto-move] ' + message);
	}
}

function dumpSavedWindows() {
	Object.keys(savedWindows).forEach(function (wsh) {
		let sws = savedWindows[wsh];
		debug('dumpSavedwindows(): ' + wsh + ' ' + JSON.stringify(sws));
	});
}

function dumpCurrentWindows() {
	global.get_window_actors().forEach(function (actor) {
		let win = actor.get_meta_window();
		dumpWindow(win);
	});
}

function dumpWindow(win) {
	debug('dumpWindow(): ' + windowRepr(win));
}

function dumpState() {
	dumpSavedWindows();
	dumpCurrentWindows();
}