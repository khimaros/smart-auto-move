'use strict';

const Main = imports.ui.main;
const Shell = imports.gi.Shell;
const Mainloop = imports.mainloop;
const St = imports.gi.St;
const ExtensionUtils = imports.misc.extensionUtils;
const Clutter = imports.gi;

const Me = ExtensionUtils.getCurrentExtension();
const Settings = ExtensionUtils.getSettings();
const AppSystem = Shell.AppSystem.get_default();

const DEBUG_LOGGING = true;
const WINDOW_RESTORE_DELAY_MS = 4000;
const WINDOW_SAVE_DELAY_MS = 2500;
const WINDOW_RESTORE_MATCH_THRESHOLD = 0.7;
const WINDOW_SYNC_TIMEOUT_MS = 50;
const SESSION_SAVE_TIMEOUT_MS = 15000;

let savedWindows = new Object();
let seenWindows = new Map();

let panelButton;
let windowSignals = new Map();
let appSignals = new Map();
let appSystemSignals = new Array();
let timeoutSyncSignal;
let timeoutSaveSignal;

//// EXTENSION LIFECYCLE

function init() {
	debug('init()');
}

function enable() {
	debug('enable()');

	/*
	AppSystem.get_running().forEach(function (app) {
		handleAppStateChanged(AppSystem, app);
	});
	connectSignals();
	*/

	connectTimeoutSignals();

	createPanelMenu();
}

function disable() {
	debug('disable()');

	//disconnectSignals();

	removeTimeouts();

	removePanelMenu();
}

//// SETTINGS

function restoreSettings() {
	debug('restoreSettings()');
}

function saveSettings() {
	debug('saveSettings()');
}

//// WINDOW UTILITIES

function windowReady(win) {
	let win_rect = win.get_frame_rect();
	//if (win.get_title() === 'Loading…') return false;
	if (win_rect.width === 0 && win_rect.height === 0) return false;
	if (win_rect.x === 0 && win_rect.y === 0) return false;
	return true;
}

function waitForWindow(win) {
	debug('waitForWindow() - start: ' + win.get_id());
	let start = Date.now();
	let notify = 1000; // Math.floor(WINDOW_RESTORE_DELAY_MS / 4)
	while (!windowReady(win)) {
		let duration = Date.now() - start;
		if (duration % notify === 0) {
			debug('waitForWindow() - waiting: ' + windowRepr(win));
		}
		if (duration >= WINDOW_RESTORE_DELAY_MS) {
			debug('waitForWindow() - timeout: ' + win.get_id());
			return false;
		}
	};
	debug('waitForWindow() - ready: ' + win.get_id());
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

function appHash(app) {
	return app.get_id();
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

function sleep(duration) {
	let start = Date.now();
	while (true) {
		if (Date.now() - start >= duration)
			return;
	}
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
	let swi = findSavedWindow(wsh, { sequence: win.get_stable_sequence() }, 1.0);
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
	win.move_resize_frame(false, sw.x, sw.y, sw.width, sw.height);
	if (sw.maximized) win.maximize(sw.maximized);
	win.move_resize_frame(false, sw.x, sw.y, sw.width, sw.height);

	let nsw = windowData(win);

	/*
	nsw.x = sw.x;
	nsw.y = sw.y;
	nsw.width = sw.width;
	nsw.height = sw.height;
	nsw.maximized = sw.maximized;
	nsw.workspace = sw.workspace;
	*/

	return nsw;
}

function restoreWindow(win) {
	let wsh = windowSectionHash(win);

	//if (! windowNewerThan(win, WINDOW_RESTORE_DELAY_MS)) return false;
	
	let swi = findSavedWindow(wsh, { hash: windowHash(win), occupied: true }, 1.0);

	if (swi !== undefined) return false;

	swi = findSavedWindow(wsh, { title: win.get_title(), occupied: false }, WINDOW_RESTORE_MATCH_THRESHOLD);

	if (swi === undefined) return false;

	// update sequence even if the window never becomes ready
	// so that we don't duplicate savedWindow data.
	savedWindows[wsh][swi].sequence = win.get_stable_sequence();

	//if (!waitForWindow(win)) return true;

	if (!windowReady(win)) return true;

	//blockWindowHandlers(win);

	let sw = savedWindows[wsh][swi];

	if (windowDataEqual(sw, windowData(win))) return true;

	debug('restoreWindow() - found: ' + JSON.stringify(sw));

	let pWinRepr = windowRepr(win);

	let nsw = moveWindow(win, sw);

	if (! (sw.x === nsw.x && sw.y === nsw.y)) return true;

	debug('restoreWindow() - moved: ' + pWinRepr + ' => ' + JSON.stringify(nsw));

	savedWindows[wsh][swi] = nsw;

	//unblockWindowHandlers(win);

	return true;
}

function restoreOrSaveUnseenWindows(app) {
	app.get_windows().forEach(function (win) {
		if (!restoreWindow(win))
			saveWindow(win);
	});
}

function restoreSavedWindows() {
	//debug('restoreSavedWindows(): ' + JSON.stringify(savedWindows));
	global.get_window_actors().forEach(function (actor) {
		let win = actor.get_meta_window();
		restoreWindow(win);
	});
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
	/*
	debug('------------------------------------------------------');
	debug('syncWindows() - start');
	dumpState();
	*/

	cleanupWindows();
	global.get_window_actors().forEach(function (actor) {
		let win = actor.get_meta_window();
		if (!restoreWindow(win))
			saveWindow(win);
	});

	/*
	debug('syncWindows() - end');
	dumpState();
	debug('------------------------------------------------------');
	*/
}

//// GUI UTILITIES

function createPanelMenu() {
	panelButton = new St.Bin({
		style_class: "panel-button",
		reactive: true,
	});
	let icon = new St.Icon({
		icon_name: 'security-low-symbolic',
		style_class: 'system-status-icon',
	});
	panelButton.set_child(icon);
	//panelButton.connect('button-press-event', syncWindows)
	panelButton.connect('button-press-event', dumpState);
	/*
	let panelButtonText = new St.Label({
		text: "Sync",
		y_align: Clutter.ActorAlign.CENTER,
	});
	panelButton.set_child(panelButtonText);
	*/
	Main.panel._rightBox.insert_child_at_index(panelButton, 0);
}

function removePanelMenu() {
	Main.panel._rightBox.remove_child(panelButton);
}

//// SIGNAL HANDLERS

function handleTimeoutSave() {
	debug('handleTimeoutSave(): ' + JSON.stringify(savedWindows));
	//saveCurrentWindows();
	//restoreSavedWindows();
	//dumpCurrentWindows();
	timeoutSaveSignal = Mainloop.timeout_add(SESSION_SAVE_TIMEOUT_MS, handleTimeoutSave);
}

function handleTimeoutSync() {
	//debug('handleTimeoutSync()');
	syncWindows();
	timeoutSyncSignal = Mainloop.timeout_add(WINDOW_SYNC_TIMEOUT_MS, handleTimeoutSync);
}

function handleAppStateChanged(appSys, app) {
	/*
	if (app.state === Shell.AppState.STOPPED)
		disconnectAppSignals(app);
	*/

	if (app.state !== Shell.AppState.RUNNING) return;

	// TODO: wait until app is finished loading.
	//while (app.is_busy());

	if (app.get_name() === "Unknown") return;

	let ah = appHash(app);

	debug('handleAppStateChanged(): ' + app.get_name() + ' ' + ah + ' state ' + app.state);

	handleAppWindowsChanged(app);

	connectAppSignals(app);
}

function handleAppWindowsChanged(app) {
	debug('handleAppWindowsChanged(): ' + app.get_name());
	connectAppSignals(app);
	cleanupWindows();
	let timeout = Mainloop.timeout_add(2000, function () { restoreOrSaveUnseenWindows(app); });
}

function handleNotifyWindowTitle(win) {
	//if (!windowReady(win)) return;
	debug('handleNotifyWindowTitle(): ' + win.get_title());
	if (win.get_title() === null) return;
	updateSavedWindow(win);
}

function handleWindowSizeChanged(win) {
	let win_rect = win.get_frame_rect();
	if (win_rect.height === 0 && win_rect.width === 0) return;
	// TODO: debounce
	debug('handleWindowSizeChanged(): ' + win.get_title());
	updateSavedWindow(win);
}

function handleWindowPositionChanged(win) {
	let win_rect = win.get_frame_rect();
	if (win_rect.x === 0 && win_rect.y === 0) return;
	// TODO: debounce
	debug('handleWindowPositionChanged(): ' + win.get_title());
	updateSavedWindow(win);
}

function handleWindowWorkspaceChanged(win) {
	if (win.get_workspace() === null) return;
	debug('handleWindowWorkspaceChanged(): ' + win.get_title());
	updateSavedWindow(win);
}

function handleWindowFocus(win) {
	debug('handleWindowFocus(): ' + win.get_title());
}

//// SIGNAL HELPERS

function connectSignals() {
	//Settings.connect('changed', handleSettingsChanged);
	// TODO: maybe use Workspace::window-added / Workspace::window-removed instead of App::WindowChanged?
	connectAppSystemSignals(AppSystem);
}

function connectTimeoutSignals() {
	//timeoutSaveSignal = Mainloop.timeout_add(SESSION_SAVE_TIMEOUT_MS, handleTimeoutSave);
	timeoutSyncSignal = Mainloop.timeout_add(WINDOW_SYNC_TIMEOUT_MS, handleTimeoutSync);
}

function connectWindowSignals(win) {
	let wh = windowHash(win);
	if (windowSignals.has(wh)) return;
	debug('connectWindowSignals(): ' + win.get_title() + ' ' + wh);
	// https://gjs-docs.gnome.org/meta9~9_api/meta.window
	let s1 = win.connect('workspace-changed', handleWindowWorkspaceChanged);
	let s2 = win.connect('size-changed', handleWindowSizeChanged);
	let s3 = win.connect('position-changed', handleWindowPositionChanged);
	let s4 = win.connect('notify::title', handleNotifyWindowTitle);
	//win.connect('focus', handleWindowFocus);
	windowSignals.set(wh, [s1, s2, s3, s4]);
}

function connectAppSignals(app) {
	app.get_windows().forEach(function (win) {
		connectWindowSignals(win);
	});
	let ah = appHash(app);
	if (appSignals.has(ah)) return;
	debug('connectAppSignals(): ' + app.get_name() + ' ' + ah);
	let s1 = app.connect('windows-changed', handleAppWindowsChanged);
	appSignals.set(ah, s1);
}

function connectAppSystemSignals(appSys) {
	let s1 = AppSystem.connect('app-state-changed', handleAppStateChanged);
	appSystemSignals = [s1];
}

function disconnectAppSignals(app) {
	let ah = appHash(app);
	debug('disconnectAppSignals(): ' + app.get_name() + ' ' + ah);
	app.disconnect(appSignals.get(ah));
	appSignals.delete(ah);
	app.get_windows().forEach(function (win) {
		disconnectWindowSignals(win);
	});
}

function disconnectWindowSignals(win) {
	let wh = windowHash(win);
	debug('disconnectWindowSignals(): ' + win.get_title() + ' ' + wh);
	windowSignals.get(wh).forEach(function (signal) {
		win.disconnect(signal);
	});
	windowSignals.delete(wh);
}

function disconnectAppSystemSignals(appSys) {
	debug('disconnectAppSystemSignals()');
	appSystemSignals.forEach(function (signal) {
		AppSystem.disconnect(signal);
	});
	appSystemSignals = new Array();
}

function disconnectSignals() {
	debug('disconnectingSignals()');
	AppSystem.get_running().forEach(function (app) {
		disconnectAppSignals(app);
	});
	disconnectAppSystemSignals(AppSystem);
}

function blockWindowHandlers(win) {
	findWindowHandlers(win).forEach(function (signal) {
		win.block_signal_handler(signal);
	});
}

function unblockWindowHandlers(win) {
	findWindowHandlers(win).forEach(function (signal) {
		win.unblock_signal_handler(signal);
	});
}

function findWindowHandlers(win) {
	let wh = windowHash(win);
	return windowSignals.get(wh);
}

function removeTimeouts() {
	Mainloop.source_remove(timeoutSyncSignal);
	//Mainloop.source_remove(timeoutSaveSignal);
	return;
}

//// DEBUG UTILITIES

function debug(message) {
	if (DEBUG_LOGGING) {
		log('[smart-auto-move] ' + message);
	}
}

function dumpSavedWindows() {
	debug('dumpSavedwindows(): ' + JSON.stringify(savedWindows));
	/*
	Object.keys(savedWindows).forEach(function (wsh) {
		let sws = savedWindows[wsh];
		sws.forEach(function (sw) {
		});
	});
	*/
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