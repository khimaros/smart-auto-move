'use strict';

import * as Common from "../lib/common.js";

function assertScore(sw, query, want_score) {
    let score = Common.scoreWindow(sw, query);
    console.assert(want_score === score, {want_score: want_score, score: score, sw: sw, query: query});
}

assertScore(
    {title: 'user@host: ~', occupied: false},
    {title: 'user@host: ~/src/github.com/user/smart-auto-move', occupied: false},
    0.625,
);

assertScore(
    {title: 'user@host: ~', occupied: false},
    {title: 'user@host: ~', occupied: false},
    1.0,
);

assertScore(
    {title: 'user@host: ~', occupied: true},
    {title: 'user@host: ~', occupied: false},
    0.0,
);

function assertFoundWindow(saved_windows, wsh, query, threshold, want_found) {
    let [found, best_score] = Common.findSavedWindow(saved_windows, wsh, query, threshold);
    console.assert(want_found === found, {want_found: want_found, found: found, best_score: best_score, saved_windows: saved_windows, query: query, threshold: threshold});
}

assertFoundWindow(
    {'firefox': [
        {title: 'Wikipedia - The Encyclopedia', occupied: false},
        {title: 'GMail - user@gmail.com (1)', occupied: false},
    ]},
    'firefox', {title: 'GMail - user@gmail.com (3)', occupied: false}, 0.7,
    1,
);

assertFoundWindow(
    {'gnome-terminal': [
        {hash: 1001, title: 'user@host: ~', occupied: false},
        {hash: 1002, title: 'user@host: ~/src', occupied: false},
        {hash: 1003, title: 'user@host: ~/scratch'}
    ]},
    'gnome-terminal', {title: 'user@host :~/src/fnord', occupied: false}, 0.7,
    1,
);

assertFoundWindow(
    {'gnome-terminal': [
        {title: 'user@host: ~/src/github.com/khimaros/smart-auto-move', occupied: false},
    ]},
    'gnome-terminal', {title: 'user@host: ~', occupied: false}, 0.35,
    0,
);

assertFoundWindow(
    {'gnome-terminal': [
        {title: 'user@host: ~/src/github.com/khimaros/smart-auto-move', occupied: false},
        {title: 'user@host: ~/src', occupied: false},
        {title: 'user@host: ~', occupied: false},
    ]},
    'gnome-terminal', {title: 'user@host: ~', occupied: false}, 0.0,
    2,
);

assertFoundWindow(
    {'org.gnome.Nautilus': [
        {title: 'Documents', occupied: false},
    ]},
    'org.gnome.Nautilus', {title: 'Downloads', occupied: false}, 0.7,
    undefined,
);

function assertFoundOverride(overrides, wsh, sw, threshold, want_found) {
    let found = Common.findOverride(overrides, wsh, sw, threshold);
    console.assert(JSON.stringify(want_found) === JSON.stringify(found), {want_found: want_found, found: found, overrides: overrides, sw: sw, threshold: threshold});
}

assertFoundOverride(
    {'gnome-terminal-server': [
        {query: {title: 'user@host: ~'}, action: 1},
        {action: 0},
    ]},
    'gnome-terminal-server', {title: 'user@host: ~/src'}, 1.0,
    {action: 0},
);

assertFoundOverride(
    {'gnome-terminal-server': [
        {query: {title: 'user@host: ~'}, action: 1, threshold: 0.3},
        {action: 0},
    ]},
    'gnome-terminal-server', {title: 'user@host: ~'}, 1.0,
    {action: 1, threshold: 0.3},
);

function assertMatchedWindow(saved_windows, overrides, wsh, title, default_match_threshold, want_swi, want_sw) {
    let [swi, sw] = Common.matchedWindow(saved_windows, overrides, wsh, title, default_match_threshold);
    console.assert(want_swi === swi && JSON.stringify(want_sw) === JSON.stringify(sw), {want_swi: want_swi, swi: swi, want_sw: want_sw, sw: sw, saved_windows: saved_windows, overrides: overrides, wsh: wsh, title: title, default_match_threshold: default_match_threshold});
}

assertMatchedWindow(
    {'gnome-terminal-server': [
        {title: 'user@host: ~/src/github.com/khimaros/smart-auto-move', occupied: false},
    ]},
    {'gnome-terminal-server': [
        {action: 1, threshold: 0.3},
    ]},
    'gnome-terminal-server', 'user@host: ~', 0.7,
    0, {title: 'user@host: ~/src/github.com/khimaros/smart-auto-move', occupied: false},
);