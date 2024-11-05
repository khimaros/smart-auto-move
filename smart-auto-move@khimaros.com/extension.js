'use strict';

// imports
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import Meta from "gi://Meta";
import GLib from "gi://GLib";
import * as Common from "./lib/common.js";

// settings backed state
let debugLogging;
let startupDelayMs;
let syncFrequencyMs;
let saveFrequencyMs;
let matchThreshold;
let syncMode;
let freezeSaves;
let activateWorkspace;
let ignorePosition;
let ignoreWorkspace;
let overrides;
let savedWindows;

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
let changedFreezeSavesSignal;
let changedActivateWorkspaceSignal;
let changedIgnorePositionSignal;
let changedIgnoreWorkspaceSignal;
let changedOverridesSignal;
let changedSavedWindowsSignal;

//// EXTENSION CLASS

export default class SmartAutoMove extends Extension {
	constructor(metadata) {
		super(metadata);

		debug('init()');
	}

	enable() {
		activeWindows = new Map();

		initializeSettings(this);

		debug('enable()');

		restoreSettings();

		// maybe Meta.prefs_get_dynamic_workspaces()
		// maybe Meta.prefs_set_num_workspaces()

		connectSignals();
	}

	disable() {
		debug('disable()');

		disconnectSignals();

		saveSettings();

		cleanupSettings();

		activeWindows = null;
	}
}

//// SETTINGS

function initializeSettings(extension) {
	settings = extension.getSettings();

	debugLogging = Common.DEFAULT_DEBUG_LOGGING;
	startupDelayMs = Common.DEFAULT_STARTUP_DELAY_MS;
	syncFrequencyMs = Common.DEFAULT_SYNC_FREQUENCY_MS;
	saveFrequencyMs = Common.DEFAULT_SAVE_FREQUENCY_MS;
	matchThreshold = Common.DEFAULT_MATCH_THRESHOLD;
	syncMode = Common.DEFAULT_SYNC_MODE;
	freezeSaves = Common.DEFAULT_FREEZE_SAVES;
	activateWorkspace = Common.DEFAULT_ACTIVATE_WORKSPACE;
	ignorePosition = Common.DEFAULT_IGNORE_POSITION;
	ignoreWorkspace = Common.DEFAULT_IGNORE_WORKSPACE;
	overrides = new Object();
	savedWindows = new Object();

	handleChangedDebugLogging();
}

function cleanupSettings() {
	settings = null;
	debugLogging = null;
	startupDelayMs = null;
	syncFrequencyMs = null;
	saveFrequencyMs = null;
	matchThreshold = null;
	syncMode = null;
	freezeSaves = null;
	activateWorkspace = null;
	ignorePosition = null;
	ignoreWorkspace = null;
	overrides = null;
	savedWindows = null;
}

function restoreSettings() {
	debug('restoreSettings()');
	handleChangedDebugLogging();
	handleChangedStartupDelay();
	handleChangedSyncFrequency();
	handleChangedSaveFrequency();
	handleChangedMatchThreshold();
	handleChangedSyncMode();
	handleChangedFreezeSaves();
	handleChangedActivateWorkspace();
	handleChangedIgnorePosition();
	handleChangedIgnoreWorkspace();
	handleChangedOverrides();
	handleChangedSavedWindows();
	dumpSavedWindows();
}

function saveSettings() {
	settings.set_boolean(Common.SETTINGS_KEY_DEBUG_LOGGING, debugLogging);
	settings.set_int(Common.SETTINGS_KEY_STARTUP_DELAY, startupDelayMs);
	settings.set_int(Common.SETTINGS_KEY_SYNC_FREQUENCY, syncFrequencyMs);
	settings.set_int(Common.SETTINGS_KEY_SAVE_FREQUENCY, saveFrequencyMs);
	settings.set_double(Common.SETTINGS_KEY_MATCH_THRESHOLD, matchThreshold);
	settings.set_enum(Common.SETTINGS_KEY_SYNC_MODE, syncMode);
	settings.set_boolean(Common.SETTINGS_KEY_FREEZE_SAVES, freezeSaves);
	settings.set_boolean(Common.SETTINGS_KEY_ACTIVATE_WORKSPACE, activateWorkspace);
	settings.set_boolean(Common.SETTINGS_KEY_IGNORE_POSITION, ignorePosition);
	settings.set_boolean(Common.SETTINGS_KEY_IGNORE_WORKSPACE, ignoreWorkspace);

	let newOverrides = JSON.stringify(overrides);
	settings.set_string(Common.SETTINGS_KEY_OVERRIDES, newOverrides);

	let oldSavedWindows = settings.get_string(Common.SETTINGS_KEY_SAVED_WINDOWS);
	let newSavedWindows = JSON.stringify(savedWindows);
	if (oldSavedWindows === newSavedWindows) return;
	debug('saveSettings()');
	dumpSavedWindows();
	settings.set_string(Common.SETTINGS_KEY_SAVED_WINDOWS, newSavedWindows);
}

//// WINDOW UTILITIES

function windowReady(win) {
	let win_rect = win.get_frame_rect();
	//if (win.get_title() === 'Loading…') return false;
	if (win_rect.width === 0 && win_rect.height === 0) return false;
	if (win_rect.x === 0 && win_rect.y === 0) return false;
	return true;
}

// https://gjs-docs-experimental.web.app/meta-10/Window/
function windowData(win) {
	let win_rect = win.get_frame_rect();
	return {
		id: win.get_id(),
		hash: windowHash(win),
		sequence: win.get_stable_sequence(),
		title: win.get_title(),
		//sandboxed_app_id: win.get_sandboxed_app_id(),
		//pid: win.get_pid(),
		//user_time: win.get_user_time(),
		workspace: win.get_workspace().index(),
		maximized: win.get_maximized(),
		fullscreen: win.is_fullscreen(),
		above: win.is_above(),
		monitor: win.get_monitor(),
		//on_all_workspaces: win.is_on_all_workspaces(),
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
	// TODO: win.get_user_time() might also be useful here.
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
	let [swi, _] = Common.findSavedWindow(savedWindows, wsh, { hash: windowHash(win) }, 1.0);
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

	if (freezeSaves) return;

	//debug('saveWindow(): ' + windowHash(win);
	if (!updateSavedWindow(win)) {
		pushSavedWindow(win);
	}
}

function findOverrideAction(win, threshold) {
	let wsh = windowSectionHash(win);
	let sw = windowData(win);

	let action = syncMode;

	let override = Common.findOverride(overrides, wsh, sw, threshold);

	if (override !== undefined && override.action !== undefined) action = override.action;

	return action;
}

function moveWindow(win, sw) {
	//debug('moveWindow(): ' + JSON.stringify(sw));

	win.move_to_monitor(sw.monitor);

	let ws = global.workspaceManager.get_workspace_by_index(sw.workspace);
	if (!ignoreWorkspace) {
		win.change_workspace(ws);
	}

	if (ignorePosition) {
	    let cw = windowData(win);
	    sw.x = cw.x;
	    sw.y = cw.y;
	}

	win.move_resize_frame(false, sw.x, sw.y, sw.width, sw.height);
	if (sw.maximized) win.maximize(sw.maximized);
	// NOTE: these additional move/maximize operations were needed in order
	// to convince Firefox to stay where we put it.
	win.move_resize_frame(false, sw.x, sw.y, sw.width, sw.height);
	if (sw.maximized) win.maximize(sw.maximized);
	win.move_resize_frame(false, sw.x, sw.y, sw.width, sw.height);

	if (sw.fullscreen) win.make_fullscreen();

	if (sw.above) win.make_above();

	//if (sw.on_all_workspaces) ...

	if (activateWorkspace && !ws.active && !ignoreWorkspace) ws.activate(true)

	let nsw = windowData(win);

	return nsw;
}

function restoreWindow(win) {
	let wsh = windowSectionHash(win);

	let sw;

	let [swi, _] = Common.findSavedWindow(savedWindows, wsh, { hash: windowHash(win), occupied: true }, 1.0);

	if (swi !== undefined) return false;

	if (!windowReady(win)) return true; // try again later

	[swi, sw] = Common.matchedWindow(savedWindows, overrides, wsh, win.get_title(), matchThreshold);

	if (swi === undefined) return false;

	if (windowDataEqual(sw, windowData(win))) return true;

	let action = findOverrideAction(win, 1.0);
	if (action !== Common.SYNC_MODE_RESTORE) return true;

	//debug('restoreWindow() - found: ' + JSON.stringify(sw));

	let pWinRepr = windowRepr(win);

	let nsw = moveWindow(win, sw);

	if (!ignorePosition) {
		if (!(sw.x === nsw.x && sw.y === nsw.y)) return true;
	}

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

function shouldSkipWindow(win) {
	debug('shouldSkipWindow() ' + win.get_title() + ' ' + win.is_skip_taskbar() + ' ' + win.get_window_type());

	if (win.is_skip_taskbar()) return true;

	if (win.get_window_type() !== Meta.WindowType.NORMAL) return true;

	return false;
}

function syncWindows() {
	cleanupWindows();
	global.get_window_actors().forEach(function (actor) {
		let win = actor.get_meta_window();

		if (shouldSkipWindow(win)) return;

		if (!restoreWindow(win))
			ensureSavedWindow(win);
	});
}

//// SIGNAL HANDLERS

function handleTimeoutSave() {
	//debug('handleTimeoutSave(): ' + JSON.stringify(savedWindows));
	GLib.Source.remove(timeoutSaveSignal);
	timeoutSaveSignal = null;
	saveSettings();
	timeoutSaveSignal = GLib.timeout_add(GLib.PRIORITY_DEFAULT, saveFrequencyMs, handleTimeoutSave);
	return GLib.SOURCE_CONTINUE;
}

function handleTimeoutSync() {
	//debug('handleTimeoutSync()');
	GLib.Source.remove(timeoutSyncSignal);
	timeoutSyncSignal = null;
	syncWindows();
	timeoutSyncSignal = GLib.timeout_add(GLib.PRIORITY_DEFAULT, syncFrequencyMs, handleTimeoutSync);
	return GLib.SOURCE_CONTINUE;
}

function handleChangedDebugLogging() {
	debugLogging = settings.get_boolean(Common.SETTINGS_KEY_DEBUG_LOGGING);
	console.log('[smart-auto-move] handleChangedDebugLogging(): ' + debugLogging);
}

function handleChangedStartupDelay() {
	startupDelayMs = settings.get_int(Common.SETTINGS_KEY_STARTUP_DELAY);
	debug('handleChangedStartupDelay(): ' + startupDelayMs);
}

function handleChangedSyncFrequency() {
	syncFrequencyMs = settings.get_int(Common.SETTINGS_KEY_SYNC_FREQUENCY);
	debug('handleChangedSyncFrequency(): ' + syncFrequencyMs);
}

function handleChangedSaveFrequency() {
	saveFrequencyMs = settings.get_int(Common.SETTINGS_KEY_SAVE_FREQUENCY);
	debug('handleChangedSaveFrequency(): ' + saveFrequencyMs);
}

function handleChangedMatchThreshold() {
	matchThreshold = settings.get_double(Common.SETTINGS_KEY_MATCH_THRESHOLD);
	debug('handleChangedMatchThreshold(): ' + matchThreshold);
}

function handleChangedSyncMode() {
	syncMode = settings.get_enum(Common.SETTINGS_KEY_SYNC_MODE);
	debug('handleChangedSyncMode(): ' + syncMode);
}

function handleChangedFreezeSaves() {
	freezeSaves = settings.get_boolean(Common.SETTINGS_KEY_FREEZE_SAVES);
	debug('[smart-auto-move] handleChangedFreezeSaves(): ' + freezeSaves);
}

function handleChangedActivateWorkspace() {
	activateWorkspace = settings.get_boolean(Common.SETTINGS_KEY_ACTIVATE_WORKSPACE);
	debug('[smart-auto-move] handleChangedActivateWorkspace(): ' + activateWorkspace);
}

function handleChangedIgnorePosition() {
	ignorePosition = settings.get_boolean(Common.SETTINGS_KEY_IGNORE_POSITION);
	debug('[smart-auto-move] handleChangedIgnorePosition(): ' + ignorePosition);
}

function handleChangedIgnoreWorkspace() {
	ignoreWorkspace = settings.get_boolean(Common.SETTINGS_KEY_IGNORE_WORKSPACE);
	debug('[smart-auto-move] handleChangedIgnoreWorkspace(): ' + ignoreWorkspace);
}

function handleChangedOverrides() {
	overrides = JSON.parse(settings.get_string(Common.SETTINGS_KEY_OVERRIDES));
	debug('handleChangedOverrides(): ' + JSON.stringify(overrides));
}

function handleChangedSavedWindows() {
	savedWindows = JSON.parse(settings.get_string(Common.SETTINGS_KEY_SAVED_WINDOWS));
	debug('handleChangedSavedWindows(): ' + JSON.stringify(savedWindows));
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
	timeoutSyncSignal = GLib.timeout_add(GLib.PRIORITY_DEFAULT, syncFrequencyMs, handleTimeoutSync);
	timeoutSaveSignal = GLib.timeout_add(GLib.PRIORITY_DEFAULT, saveFrequencyMs, handleTimeoutSave);
}

function removeTimeouts() {
	GLib.Source.remove(timeoutSyncSignal);
	timeoutSyncSignal = null;

	GLib.Source.remove(timeoutSaveSignal);
	timeoutSaveSignal = null;
}

function connectSettingChangedSignals() {
	changedDebugLoggingSignal = settings.connect('changed::' + Common.SETTINGS_KEY_DEBUG_LOGGING, handleChangedDebugLogging);
	changedStartupDelaySignal = settings.connect('changed::' + Common.SETTINGS_KEY_STARTUP_DELAY, handleChangedStartupDelay);
	changedSyncFrequencySignal = settings.connect('changed::' + Common.SETTINGS_KEY_SYNC_FREQUENCY, handleChangedSyncFrequency);
	changedSaveFrequencySignal = settings.connect('changed::' + Common.SETTINGS_KEY_SAVE_FREQUENCY, handleChangedSaveFrequency);
	changedMatchThresholdSignal = settings.connect('changed::' + Common.SETTINGS_KEY_MATCH_THRESHOLD, handleChangedMatchThreshold);
	changedSyncModeSignal = settings.connect('changed::' + Common.SETTINGS_KEY_SYNC_MODE, handleChangedSyncMode);
	changedFreezeSavesSignal = settings.connect('changed::' + Common.SETTINGS_KEY_FREEZE_SAVES, handleChangedFreezeSaves);
	changedActivateWorkspaceSignal = settings.connect('changed::' + Common.SETTINGS_KEY_ACTIVATE_WORKSPACE, handleChangedActivateWorkspace);
	changedIgnorePositionSignal = settings.connect('changed::' + Common.SETTINGS_KEY_IGNORE_POSITION, handleChangedIgnorePosition);
	changedIgnoreWorkspaceSignal = settings.connect('changed::' + Common.SETTINGS_KEY_IGNORE_WORKSPACE, handleChangedIgnoreWorkspace);
	changedOverridesSignal = settings.connect('changed::' + Common.SETTINGS_KEY_OVERRIDES, handleChangedOverrides);
	changedSavedWindowsSignal = settings.connect('changed::' + Common.SETTINGS_KEY_SAVED_WINDOWS, handleChangedSavedWindows);
}

function disconnectSettingChangedSignals() {
	settings.disconnect(changedDebugLoggingSignal);
	settings.disconnect(changedStartupDelaySignal);
	settings.disconnect(changedSyncFrequencySignal);
	settings.disconnect(changedSaveFrequencySignal);
	settings.disconnect(changedMatchThresholdSignal);
	settings.disconnect(changedSyncModeSignal);
	settings.disconnect(changedOverridesSignal);
	settings.disconnect(changedSavedWindowsSignal);

	changedDebugLoggingSignal = null;
	changedStartupDelaySignal = null;
	changedSyncFrequencySignal = null;
	changedSaveFrequencySignal = null;
	changedMatchThresholdSignal = null;
	changedSyncModeSignal = null;
	changedOverridesSignal = null;
	changedSavedWindowsSignal = null;
}

//// DEBUG UTILITIES

function info(message) {
	console.log('[smart-auto-move] ' + message);
}

function debug(message) {
	if (debugLogging) {
		info(message);
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
