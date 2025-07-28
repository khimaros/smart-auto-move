'use strict';

// imports
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import Meta from "gi://Meta";
import GLib from "gi://GLib";
import * as Common from "./lib/common.js";

// mutable runtime state
let state;
let settingSignals;
let activeWindows;
let settings;

// signal descriptors
let timeoutSyncSignal;
let timeoutSaveSignal;

//// EXTENSION CLASS

export default class SmartAutoMove extends Extension {
	constructor(metadata) {
		super(metadata);
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

	state = {};
	settingSignals = {};

	Common.SETTINGS_CONFIG.forEach(c => {
		if (typeof c.default === 'function') {
			state[c.name] = c.default();
		} else {
			state[c.name] = c.default;
		}

		c.handler = createSettingChangedHandler(c);
	});

	// Manually load debug logging so we can use debug() during startup.
	state.debugLogging = settings.get_boolean(Common.SETTINGS_KEY_DEBUG_LOGGING);
	console.log('[smart-auto-move] handleChangedDebugLogging(): ' + state.debugLogging);
}

function cleanupSettings() {
	settings = null;
	state = null;
	settingSignals = null;
}

function restoreSettings() {
	debug('restoreSettings()');
	Common.SETTINGS_CONFIG.forEach(c => c.handler());
	dumpSavedWindows();
}

function saveSettings() {
	Common.SETTINGS_CONFIG.forEach(c => {
		if (c.name === 'savedWindows') return;

		const setter = 'set_' + c.type;
		let value = state[c.name];

		if (c.json) {
			value = JSON.stringify(value);
		}
		settings[setter](c.key, value);
	});

	let oldSavedWindows = settings.get_string(Common.SETTINGS_KEY_SAVED_WINDOWS);
	let newSavedWindows = JSON.stringify(state.savedWindows);
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
		on_all_workspaces: win.is_on_all_workspaces(),
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
	if (!state.savedWindows.hasOwnProperty(wsh))
		state.savedWindows[wsh] = new Array();
	let sw = windowData(win);
	state.savedWindows[wsh].push(sw);
	debug('pushSavedWindow() - pushed: ' + JSON.stringify(sw));
	return true;
}

function updateSavedWindow(win) {
	let wsh = windowSectionHash(win);
	//debug('updateSavedWindow() - start: ' + wsh + ', ' + win.get_title());
	let [swi, _] = Common.findSavedWindow(state.savedWindows, wsh, { hash: windowHash(win) }, 1.0);
	if (swi === undefined)
		return false;
	let sw = windowData(win);
	if (windowDataEqual(state.savedWindows[wsh][swi], sw)) return true;
	state.savedWindows[wsh][swi] = sw;
	debug('updateSavedWindow() - updated: ' + swi + ', ' + JSON.stringify(sw));
	return true;
}

function ensureSavedWindow(win) {
	let wh = windowHash(win);

	if (windowNewerThan(win, state.startupDelayMs)) return;

	if (state.freezeSaves) return;

	//debug('saveWindow(): ' + windowHash(win);
	if (!updateSavedWindow(win)) {
		pushSavedWindow(win);
	}
}

function findOverrideAction(win, threshold) {
	let wsh = windowSectionHash(win);
	let sw = windowData(win);

	let action = state.syncMode;

	let override = Common.findOverride(state.overrides, wsh, sw, threshold);

	if (override !== undefined && override.action !== undefined) action = override.action;

	return action;
}

function moveWindow(win, sw) {
	//debug('moveWindow(): ' + JSON.stringify(sw));

	if (!state.ignoreMonitor) {
		win.move_to_monitor(sw.monitor);
	}

	let ws = global.workspaceManager.get_workspace_by_index(sw.workspace);
	if (!state.ignoreWorkspace) {
		win.change_workspace(ws);
	}

	if (state.ignorePosition) {
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

	if (sw.on_all_workspaces) win.stick();

	if (state.activateWorkspace && !ws.active && !state.ignoreWorkspace) ws.activate(true)

	let nsw = windowData(win);

	return nsw;
}

function restoreWindow(win) {
	let wsh = windowSectionHash(win);

	let sw;

	let [swi, _] = Common.findSavedWindow(state.savedWindows, wsh, { hash: windowHash(win), occupied: true }, 1.0);

	if (swi !== undefined) return false;

	if (!windowReady(win)) return true; // try again later

	[swi, sw] = Common.matchedWindow(state.savedWindows, state.overrides, wsh, win.get_title(), state.matchThreshold);

	if (swi === undefined) return false;

	if (windowDataEqual(sw, windowData(win))) return true;

	let action = findOverrideAction(win, 1.0);
	if (action !== Common.SYNC_MODE_RESTORE) return true;

	//debug('restoreWindow() - found: ' + JSON.stringify(sw));

	let pWinRepr = windowRepr(win);

	let nsw = moveWindow(win, sw);

	if (!state.ignorePosition) {
		if (!(sw.x === nsw.x && sw.y === nsw.y)) return true;
	}

	debug('restoreWindow() - moved: ' + pWinRepr + ' => ' + JSON.stringify(nsw));

	state.savedWindows[wsh][swi] = nsw;

	return true;
}

function cleanupWindows() {
	let found = new Map();

	global.get_window_actors().forEach(function (actor) {
		let win = actor.get_meta_window();
		found.set(windowHash(win), true);
	});

	Object.keys(state.savedWindows).forEach(function (wsh) {
		let sws = state.savedWindows[wsh];
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
	//debug('handleTimeoutSave(): ' + JSON.stringify(state.savedWindows));
	GLib.Source.remove(timeoutSaveSignal);
	timeoutSaveSignal = null;
	saveSettings();
	timeoutSaveSignal = GLib.timeout_add(GLib.PRIORITY_DEFAULT, state.saveFrequencyMs, handleTimeoutSave);
	return GLib.SOURCE_CONTINUE;
}

function handleTimeoutSync() {
	//debug('handleTimeoutSync()');
	GLib.Source.remove(timeoutSyncSignal);
	timeoutSyncSignal = null;
	syncWindows();
	timeoutSyncSignal = GLib.timeout_add(GLib.PRIORITY_DEFAULT, state.syncFrequencyMs, handleTimeoutSync);
	return GLib.SOURCE_CONTINUE;
}

function createSettingChangedHandler(setting) {
	return () => {
		let value;
		const getter = 'get_' + setting.type;
		value = settings[getter](setting.key);

		if (setting.json) {
			value = JSON.parse(value);
		}
		state[setting.name] = value;

		const name_upper = setting.name.charAt(0).toUpperCase() + setting.name.slice(1);
		const msg = `handleChanged${name_upper}(): ` + (setting.json ? JSON.stringify(value) : value);

		if (setting.name === 'debugLogging') {
			console.log('[smart-auto-move] ' + msg);
		} else {
			debug(msg);
		}
	}
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
	timeoutSyncSignal = GLib.timeout_add(GLib.PRIORITY_DEFAULT, state.syncFrequencyMs, handleTimeoutSync);
	timeoutSaveSignal = GLib.timeout_add(GLib.PRIORITY_DEFAULT, state.saveFrequencyMs, handleTimeoutSave);
}

function removeTimeouts() {
	GLib.Source.remove(timeoutSyncSignal);
	timeoutSyncSignal = null;

	GLib.Source.remove(timeoutSaveSignal);
	timeoutSaveSignal = null;
}

function connectSettingChangedSignals() {
	Common.SETTINGS_CONFIG.forEach(c => {
		settingSignals[c.name] = settings.connect('changed::' + c.key, c.handler);
	});
}

function disconnectSettingChangedSignals() {
	Common.SETTINGS_CONFIG.forEach(c => {
		if (settingSignals[c.name]) {
			settings.disconnect(settingSignals[c.name]);
			settingSignals[c.name] = null;
		}
	});
}

//// DEBUG UTILITIES

function info(message) {
	console.log('[smart-auto-move] ' + message);
}

function debug(message) {
	if (state && state.debugLogging) {
		info(message);
	}
}

function dumpSavedWindows() {
	Object.keys(state.savedWindows).forEach(function (wsh) {
		let sws = state.savedWindows[wsh];
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
