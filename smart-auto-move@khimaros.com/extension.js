'use strict';

const Main = imports.ui.main;
const Shell = imports.gi.Shell;
const Mainloop = imports.mainloop;
const St = imports.gi.St;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const WINDOW_RESTORE_DELAY_MS = 4000;
const WINDOW_RESTORE_MATCH_THRESHOLD = 0.7;

let appSystem = Shell.AppSystem.get_default();

let savedWindows = new Object();
let seenWindows = new Map();
let windowSignals = new Map();
let appSignals = new Map();
let appSystemSignals = new Array();

//// EXTENSION LIFECYCLE

function init() {
	log('[smart-auto-move] init()');
}

function enable() {
	log('[smart-auto-move] enable()');

	appSystem.get_running().forEach(function (app) {
		handleAppStateChanged(appSystem, app);
	});

	connectAppSystemSignals(appSystem);

	//let timeout = Mainloop.timeout_add(5000, handleMainloopTimeout);
}

function disable() {
	log('[smart-auto-move] disable()');

	removeTimeouts();

	disconnectSignals();
}

//// WINDOW UTILS

function windowReady(win) {
	let win_rect = win.get_frame_rect();
	if (win_rect.width === 0 || win_rect.height === 0) return false;
	return true;
}

function windowToSaved(win) {
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

function appHash(app) {
	return app.get_id();
}

function windowSectionHash(win) {
	return win.get_wm_class();
}

function windowHash(win) {
	return win.get_id();
}

//// WINDOW SAVE

function pushSavedWindow(win) {
	let wsh = windowSectionHash(win);
	log('[smart-auto-move] pushSavedWindow() - start: ' + wsh + ', ' + win.get_title());
	if (wsh === null) return;
	if (!savedWindows.hasOwnProperty(wsh))
		savedWindows[wsh] = new Array();
	let sw = windowToSaved(win);
	savedWindows[wsh].push(sw);
	log('[smart-auto-move] pushSavedWindow() - pushed: ' + JSON.stringify(sw));
}

function updateSavedWindow(win) {
	let wsh = windowSectionHash(win);
	log('[smart-auto-move] updateSavedWindow() - search: ' + wsh + ', ' + win.get_title());
	let swi = findSavedWindow(wsh, { sequence: win.get_stable_sequence() }, 1.0);
	if (swi === undefined)
		return false;
	let sw = windowToSaved(win);
	savedWindows[wsh][swi] = sw;
	log('[smart-auto-move] updateSavedWindow() - saved: ' + swi + ', ' + JSON.stringify(sw));
	return true;
}

function saveWindow(win) {
	log('[smart-auto-move] ensureSavedWindow()');
	if (!updateSavedWindow(win)) {
		pushSavedWindow(win);
	}
}

function saveCurrentWindows() {
	//savedWindows = new Object();
	global.get_window_actors().forEach(function (actor) {
		let win = actor.get_meta_window();
		saveWindow(win);
	});
	log('[smart-auto-move] saveCurrentWindows(): ' + JSON.stringify(savedWindows));
}

//// WINDOW RESTORE

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
	log('[smart-auto-move] findSavedWindow() - search: ' + wsh + ', ' + JSON.stringify(query) + ' threshold: ' + threshold);

	if (!savedWindows.hasOwnProperty(wsh)) {
		log('[smart-auto-move] findSavedWindow() - no such window: ' + wsh)
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

	log('[smart-auto-move] findSavedWindow() - sorted_scores: ' + JSON.stringify(Array.from(sorted_scores.entries())));

	let best_swi = sorted_scores.keys().next().value;
	let best_score = sorted_scores.get(best_swi);

	let found = undefined;
	if (best_score >= threshold)
		found = best_swi;

	log('[smart-auto-move] findSavedWindow() - found: ' + found);

	return found;
}

function restoreWindow(win) {
	let wsh = windowSectionHash(win);

	let swi = findSavedWindow(wsh, { title: win.get_title(), occupied: false }, WINDOW_RESTORE_MATCH_THRESHOLD);

	if (swi === undefined) return false;

	let sw = savedWindows[wsh][swi];

	log('[smart-auto-move] restoreWindow() - start: ' + JSON.stringify(sw));

	//while (!windowReady(win));

	let ws = global.workspaceManager.get_workspace_by_index(sw.workspace);
	win.change_workspace(ws);
	if (sw.maximized) win.maximize(sw.maximized);
	win.move_resize_frame(false, sw.x, sw.y, sw.width, sw.height);

	sw = windowToSaved(win);
	savedWindows[wsh][swi] = sw;

	log('[smart-auto-move] restoreWindow() - restored: ' + JSON.stringify(sw));

	return true;
}

function restoreSavedWindows() {
	log('[smart-auto-move] restoreSavedWindows(): ' + JSON.stringify(savedWindows));

	global.get_window_actors().forEach(function (actor) {
		let win = actor.get_meta_window();
		restoreWindow(win);
	});
}

function restoreOrSaveUnseenWindows(app) {
	app.get_windows().forEach(function (win) {
		let wh = windowHash(win);

		if (seenWindows.get(wh) !== undefined) return;
		seenWindows.set(wh, true);

		if (!restoreWindow(win))
			saveWindow(win);
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
				log('[smart-auto-move] cleaning up occupied window: ' + sw.hash)
				sw.occupied = false;
			}
		});
	});
}

//// SIGNAL HELPERS

function connectWindowSignals(win) {
	let wh = windowHash(win);
	if (windowSignals.has(wh)) return;
	log('[smart-auto-move] connecting signals for window ' + win.get_title() + ' ' + wh);
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
	log('[smart-auto-move] connecting signals for app ' + app.get_name() + ' ' + ah);
	let s1 = app.connect('windows-changed', handleAppWindowsChanged);
	appSignals.set(ah, s1);
}

function connectAppSystemSignals(appSys) {
	let s1 = appSystem.connect('app-state-changed', handleAppStateChanged);
	appSystemSignals = [s1];
}

function disconnectAppSignals(app) {
	let ah = appHash(app);
	log('[smart-auto-move] disconnecting signals for App ' + app.get_name() + ' ' + ah);
	app.disconnect(appSignals.get(ah));
	appSignals.delete(ah);
	app.get_windows().forEach(function (win) {
		disconnectWindowSignals(win);
	});
}

function disconnectWindowSignals(win) {
	let wh = windowHash(win);
	log('[smart-auto-move] disconnecting signals for Window ' + win.get_title() + ' ' + wh);
	windowSignals.get(wh).forEach(function (signal) {
		win.disconnect(signal);
	});
	windowSignals.delete(wh);
}

function disconnectAppSystemSignals(appSys) {
	log('[smart-auto-move] disconnecting signals for AppSystem');
	appSystemSignals.forEach(function (signal) {
		appSystem.disconnect(signal);
	});
	appSystemSignals = new Array();
}

function disconnectSignals() {
	log('[smart-auto-move] disconnecting all signals');
	appSystem.get_running().forEach(function (app) {
		disconnectAppSignals(app);
	});
	disconnectAppSystemSignals(appSystem);
}

function removeTimeouts() {
	// TODO: cleanup timeout on disable.
	//Mainloop.source_remove(timeout);
	return;
}

//// SIGNAL HANDLERS

function handleMainloopTimeout() {
	log('[smart-auto-move] handleMainloopTimeout(): ' + JSON.stringify(savedWindows));
	//saveCurrentWindows();
	//restoreSavedWindows();
	dumpCurrentWindows();
	let timeout = Mainloop.timeout_add(5000, handleMainloopTimeout);
}

function handleNotifyWindowTitle(win) {
	log('[smart-auto-move] handleNotifyWindowTitle(): ' + win.get_title());
	if (win.get_title() === null) return;
	if (win.get_title() === 'Loading…') return;
	updateSavedWindow(win);
	//ensureSavedWindow(win);
}

function handleAppStateChanged(appSys, app) {
	/*
	if (app.state === Shell.AppState.STOPPED)
		disconnectAppSignals(app);
	*/

	if (app.state !== Shell.AppState.RUNNING) return;

	//while (app.is_busy());

	if (app.get_name() === "Unknown") return;

	let ah = appHash(app);

	log('[smart-auto-move] handleAppStateChanged(): ' + app.get_name() + ' ' + ah + ' state ' + app.state);

	//restoreOrSaveUnseenWindows(app);

	handleAppWindowsChanged(app);

	connectAppSignals(app);
}

function handleAppWindowsChanged(app) {
	log('[smart-auto-move] handleAppWindowsChanged(): ' + app.get_name());
	connectAppSignals(app);
	cleanupWindows();
	let timeout = Mainloop.timeout_add(WINDOW_RESTORE_DELAY_MS, function () {
		restoreOrSaveUnseenWindows(app);
	});
}

function handleWindowSizeChanged(win) {
	log('[smart-auto-move] handleWindowSizeChanged(): ' + win.get_title());
	updateSavedWindow(win);
}

function handleWindowWorkspaceChanged(win) {
	log('[smart-auto-move] handleWindowWorkspaceChanged(): ' + win.get_title());
	updateSavedWindow(win);
}

function handleWindowPositionChanged(win) {
	log('[smart-auto-move] handleWindowPositionChanged(): ' + win.get_title());
	updateSavedWindow(win);
}

function handleWindowFocus(win) {
	log('[smart-auto-move] handleWindowFocus(): ' + win.get_title());
}

//// DEBUG UTILITIES

function dumpCurrentWindows() {
	global.get_window_actors().forEach(function (actor) {
		let win = actor.get_meta_window();
		dumpWindow(win);
	});
}

function dumpWindow(win) {
	log('\n[smart-auto-move] dumpWindow()\n' +
		'  stable_sequence: ' + win.get_stable_sequence() + '\n' +
		'  title: ' + win.get_title() + '\n' +
		'  wm_class: ' + win.get_wm_class() + '\n' +
		'  wm_class_instance: ' + win.get_wm_class_instance() + '\n' +
		'  id: ' + win.get_id() + '\n' +
		'  startup_id: ' + win.get_startup_id() + '\n' +
		'  role: ' + win.get_role() + '\n' +
		'  pid: ' + win.get_pid() + '\n' +
		'\n');
}


