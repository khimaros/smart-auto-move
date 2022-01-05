'use strict';

const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const St = imports.gi.St;
const ExtensionUtils = imports.misc.extensionUtils;

const Me = ExtensionUtils.getCurrentExtension();

const DEBUG_LOGGING = false;
const WINDOW_SAVE_DELAY_MS = 2500;
const WINDOW_RESTORE_MATCH_THRESHOLD = 0.7;
const WINDOW_SYNC_TIMEOUT_MS = 50;
const SESSION_SAVE_TIMEOUT_MS = 2000;
const SESSION_SETTINGS_KEY = 'saved-windows';

let settings;
let savedWindows;
let seenWindows;

let timeoutSyncSignal;
let timeoutSaveSignal;

//// EXTENSION LIFECYCLE

function init() {
	debug('init()');
}

function enable() {
	debug('enable()');

	savedWindows = new Object();
	seenWindows = new Map();

	settings = ExtensionUtils.getSettings();

	restoreSettings();

	connectTimeoutSignals();
}

function disable() {
	debug('disable()');

	removeTimeouts();

	saveSettings();

	settings = null;

	savedWindows = null;
	seenWindows = null;
}

//// SETTINGS

function restoreSettings() {
	debug('restoreSettings()');
	savedWindows = JSON.parse(settings.get_string(SESSION_SETTINGS_KEY));
	dumpSavedWindows();
}

function saveSettings() {
	let current = settings.get_string(SESSION_SETTINGS_KEY);
	let session = JSON.stringify(savedWindows);
	if (current === session) return;
	debug('saveSettings()');
	dumpSavedWindows();
	settings.set_string(SESSION_SETTINGS_KEY, session);
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

	if (seenWindows.get(wh) === undefined) {
		seenWindows.set(wh, Date.now());
	}

	return (Date.now() - seenWindows.get(wh) < age);
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

function saveWindow(win) {
	let wh = windowHash(win);

	if (windowNewerThan(win, WINDOW_SAVE_DELAY_MS)) return;

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

function findSavedWindow(wsh, query, threshold) {
	//debug('findSavedWindow() - search: ' + wsh + ', ' + JSON.stringify(query) + ' threshold: ' + threshold);

	if (!savedWindows.hasOwnProperty(wsh)) {
		//debug('findSavedWindow() - no such window: ' + wsh)
		return undefined;
	}

	let scores = new Map();
	savedWindows[wsh].forEach(function (sw, swi) {
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
		scores.set(swi, score);
	});

	let sorted_scores = new Map([...scores.entries()].sort((a, b) => b[1] - a[1]));

	//debug('findSavedWindow() - sorted_scores: ' + JSON.stringify(Array.from(sorted_scores.entries())));

	let best_swi = sorted_scores.keys().next().value;
	let best_score = sorted_scores.get(best_swi);

	let found = undefined;
	if (best_score >= threshold)
		found = best_swi;

	//debug('findSavedWindow() - found: ' + found + ' ' + JSON.stringify(savedWindows[wsh][found]));

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

	swi = findSavedWindow(wsh, { title: win.get_title(), occupied: false }, WINDOW_RESTORE_MATCH_THRESHOLD);

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
		if (!restoreWindow(win))
			saveWindow(win);
	});
}

//// SIGNAL HANDLERS

function handleTimeoutSave() {
	//debug('handleTimeoutSave(): ' + JSON.stringify(savedWindows));
	saveSettings();
	timeoutSaveSignal = Mainloop.timeout_add(SESSION_SAVE_TIMEOUT_MS, handleTimeoutSave);
}

function handleTimeoutSync() {
	//debug('handleTimeoutSync()');
	syncWindows();
	timeoutSyncSignal = Mainloop.timeout_add(WINDOW_SYNC_TIMEOUT_MS, handleTimeoutSync);
}

//// SIGNAL HELPERS

function connectTimeoutSignals() {
	timeoutSyncSignal = Mainloop.timeout_add(WINDOW_SYNC_TIMEOUT_MS, handleTimeoutSync);
	timeoutSaveSignal = Mainloop.timeout_add(SESSION_SAVE_TIMEOUT_MS, handleTimeoutSave);
}

function removeTimeouts() {
	Mainloop.source_remove(timeoutSyncSignal);
	timeoutSyncSignal = null;

	Mainloop.source_remove(timeoutSaveSignal);
	timeoutSaveSignal = null;
}

//// DEBUG UTILITIES

function debug(message) {
	if (DEBUG_LOGGING) {
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