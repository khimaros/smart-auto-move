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
var SYNC_MODE_IGNORE = 0;
var SYNC_MODE_RESTORE = 1;

// default setting values (see also gschema xml)
var DEFAULT_DEBUG_LOGGING = false;
var DEFAULT_STARTUP_DELAY_MS = 2500;
var DEFAULT_SYNC_FREQUENCY_MS = 100;
var DEFAULT_SAVE_FREQUENCY_MS = 1000;
var DEFAULT_MATCH_THRESHOLD = 0.7;
var DEFAULT_SYNC_MODE = SYNC_MODE_RESTORE;

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
			let title_score = (value.length - dist) / value.length;
			if (title_score < 0) title_score = -0.3;
			match_parts += title_score;
		} else if (sw[key] === value) {
			match_parts += 1;
		}
		query_parts += 1;
	});
	let score = match_parts / query_parts;
	if (score < 0) score = 0;
	return score;
}

function findSavedWindow(saved_windows, wsh, query, threshold) {
	if (!saved_windows.hasOwnProperty(wsh)) {
		//debug('findSavedWindow() - no such window section: ' + wsh)
		return [undefined, undefined];
	}

	let scores = new Map();
	saved_windows[wsh].forEach(function (sw, swi) {
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

	return [found, best_score];
}

function findOverride(overrides, wsh, sw, threshold) {
	let override = {};
	let matched = false;

	if (!overrides.hasOwnProperty(wsh)) {
		//debug('findOverrideAction(): no overrides for section ' + wsh);
		return override;
	}
	overrides[wsh].forEach(function (o, oi) {
		if (matched) return;
		if (!o.hasOwnProperty('query')) {
			override.action = o.action;
			override.threshold = o.threshold;
			matched = true;
			return;
		}
		let score = scoreWindow(sw, o.query);
		if (score >= threshold) {
			override.action = o.action;
			override.threshold = o.threshold;
			matched = true;
			return;
		}
	});

	//debug('findOverrideAction(): ' + wsh + ' ' + JSON.stringify(sw) + ' ' + action);
	return override;
}

function matchedWindow(saved_windows, overrides, wsh, title, default_match_threshold) {
	let o = findOverride(overrides, wsh, { title: title }, 1.0);

	let threshold = default_match_threshold;
	if (o !== undefined && o.threshold !== undefined) threshold = o.threshold;

	let [swi, _] = findSavedWindow(saved_windows, wsh, { title: title, occupied: false }, threshold);

	if (swi === undefined) return [undefined, undefined];

	let sw = saved_windows[wsh][swi];

	return [swi, sw];
}
