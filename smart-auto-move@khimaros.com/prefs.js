'use strict';

import GObject from "gi://GObject";
import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Pango from "gi://Pango";

import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";
import * as Common from "./lib/common.js";

const TemplatesBox = GObject.registerClass({
    GTypeName: 'templates',
    Template: GLib.path_get_dirname(import.meta.url) + '/ui/templates-gtk4.ui',
    InternalChildren: [
        'section-header-label',
        'override-template-listboxrow',
        'override-label',
        'override-threshold-spin',
        'override-action-combo',
        'override-delete-button',
        'saved-window-template-listboxrow',
        'saved-window-label',
        'saved-window-delete-button',
        'saved-window-ignore-button',
        'saved-window-ignore-any-button',
    ],
}, class TemplatesBox extends Gtk.Box { });

let changedOverridesSignal;
let changedSavedWindowsSignal;

export default class SAMPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const widget = buildPrefsWidget(this);
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup();
        group.add(widget);
        page.add(group);
        window.add(page);
    }

    get uiFile() {
        return `${this.path}/ui/prefs-gtk4.ui`;
    }
  }


function buildPrefsWidget(extension) {
    let settings = extension.getSettings();

    let builder = new Gtk.Builder();

    builder.add_from_file(extension.uiFile);

    let root = builder.get_object('prefs-notebook');

    /// GENERAL

    let debug_logging_widget = builder.get_object('debug-logging-switch');
    settings.bind(
        Common.SETTINGS_KEY_DEBUG_LOGGING,
        debug_logging_widget,
        'active',
        Gio.SettingsBindFlags.DEFAULT
    );

    let sync_mode_widget = builder.get_object('sync-mode-combo');
    settings.bind(
        Common.SETTINGS_KEY_SYNC_MODE,
        sync_mode_widget,
        'active-id',
        Gio.SettingsBindFlags.DEFAULT
    );

    let match_threshold_widget = builder.get_object('match-threshold-spin');
    settings.bind(
        Common.SETTINGS_KEY_MATCH_THRESHOLD,
        match_threshold_widget,
        'value',
        Gio.SettingsBindFlags.DEFAULT
    );

    let sync_frequency_widget = builder.get_object('sync-frequency-spin');
    settings.bind(
        Common.SETTINGS_KEY_SYNC_FREQUENCY,
        sync_frequency_widget,
        'value',
        Gio.SettingsBindFlags.DEFAULT
    );

    let save_frequency_widget = builder.get_object('save-frequency-spin');
    settings.bind(
        Common.SETTINGS_KEY_SAVE_FREQUENCY,
        save_frequency_widget,
        'value',
        Gio.SettingsBindFlags.DEFAULT
    );

    let freeze_saves_widget = builder.get_object('freeze-saves-switch');
    settings.bind(
        Common.SETTINGS_KEY_FREEZE_SAVES,
        freeze_saves_widget,
        'active',
        Gio.SettingsBindFlags.DEFAULT
    );

    let activate_workspace_widget = builder.get_object('activate-workspace-switch');
    settings.bind(
        Common.SETTINGS_KEY_ACTIVATE_WORKSPACE,
        activate_workspace_widget,
        'active',
        Gio.SettingsBindFlags.DEFAULT
    );

    let ignore_position_widget = builder.get_object('ignore-position-switch');
    settings.bind(
        Common.SETTINGS_KEY_IGNORE_POSITION,
        ignore_position_widget,
        'active',
        Gio.SettingsBindFlags.DEFAULT
    );

    let ignore_workspace_widget = builder.get_object('ignore-workspace-switch');
    settings.bind(
        Common.SETTINGS_KEY_IGNORE_WORKSPACE,
        ignore_workspace_widget,
        'active',
        Gio.SettingsBindFlags.DEFAULT
    );

    /// SAVED WINDOWS

    let saved_windows_list_widget = builder.get_object('saved-windows-listbox');
    let saved_windows_list_objects = [];
    let saved_windows_cleanup_widget = builder.get_object('saved-windows-cleanup-button');
    saved_windows_cleanup_widget.connect('clicked', function () {
	//console.log('CLEANUP BUTTON CLICKED');
        deleteNonOccupiedWindows(extension);
    });
    loadSavedWindowsSetting(extension, saved_windows_list_widget, saved_windows_list_objects);
    changedSavedWindowsSignal = settings.connect('changed::' + Common.SETTINGS_KEY_SAVED_WINDOWS, function () {
	    loadSavedWindowsSetting(extension, saved_windows_list_widget, saved_windows_list_objects);
    });

    /// OVERRIDES

    let overrides_list_objects = [];
    let overrides_list_widget = builder.get_object('overrides-listbox');
    let overrides_add_application_widget = builder.get_object('overrides-add-application-button');
    overrides_add_application_widget.connect('clicked', function () {
        // TODO
    });
    loadOverridesSetting(extension, overrides_list_widget, overrides_list_objects);
    changedOverridesSignal = settings.connect('changed::' + Common.SETTINGS_KEY_OVERRIDES, function () {
	    loadOverridesSetting(extension, overrides_list_widget, overrides_list_objects);
    });

    return root;
}

function loadOverridesSetting(extension, list_widget, list_objects) {
    let settings = extension.getSettings();

    let overrides = JSON.parse(settings.get_string(Common.SETTINGS_KEY_OVERRIDES));

    // TODO: deduplicate this with similar logic in loadSavedWindowsSetting()
    let current_row = list_widget.get_first_child();
    current_row = current_row.get_next_sibling(); // skip the first row
    while (current_row !== null) {
        let prev_row = current_row;
        current_row = current_row.get_next_sibling();

        // disconnect signals for all children
        // TODO: simplify this by using an array instead of an object.
        let lo = list_objects.shift();
        if (lo !== null) {
            lo['threshold'][1].disconnect(lo['threshold'][0]);
            lo['action'][1].disconnect(lo['action'][0]);
            lo['delete'][1].disconnect(lo['delete'][0]);
        }

        list_widget.remove(prev_row);
    }
    // TODO: assert that list_objects is empty.

    Object.keys(overrides).forEach(function (wsh) {
        let header_templates = new TemplatesBox();
        let header = header_templates._section_header_label
        header.unparent();
        header.set_label(wsh);
        list_widget.append(header);
        list_objects.push(null);

        let wshos = overrides[wsh];
        wshos.forEach(function (o, oi) {
            let row_templates = new TemplatesBox();

            let row = row_templates._override_template_listboxrow;
            row.unparent();

            let label_widget = row_templates._override_label;
            let query = 'ANY';
            if (o.query) query = JSON.stringify(o.query);
            label_widget.set_label(query);

            let threshold_widget = row_templates._override_threshold_spin;
            if (o.query !== undefined) threshold_widget.set_sensitive(false);
            if (o.threshold !== undefined) threshold_widget.set_value(o.threshold);
            let threshold_signal = threshold_widget.connect('value-changed', function (spin) {
                let threshold = spin.get_value();
                if (threshold <= 0.01) threshold = undefined;
                //console.log('SPIN THRESHOLD CHANGED: ' + threshold);
                wshos[oi].threshold = threshold;
                settings.set_string(Common.SETTINGS_KEY_OVERRIDES, JSON.stringify(overrides));
            });

            let action_widget = row_templates._override_action_combo
            if (o.action !== undefined) action_widget.set_active(o.action);
            else action_widget.set_active(2);
            let action_signal = action_widget.connect('changed', function (combo) {
                let action = combo.get_active();
                if (action === 2) action = undefined;
                //console.log('COMBO CHANGED ACTIVE: ' + combo.get_active());
                wshos[oi].action = action;
                settings.set_string(Common.SETTINGS_KEY_OVERRIDES, JSON.stringify(overrides));
            });

            let delete_widget = row_templates._override_delete_button;
            let delete_signal = delete_widget.connect('clicked', function () {
                //console.log('DELETE OVERRIDE: ' + JSON.stringify(o));
                wshos.splice(oi, 1);
                if (wshos.length < 1) delete (overrides[wsh]);
                settings.set_string(Common.SETTINGS_KEY_OVERRIDES, JSON.stringify(overrides));
            });

            list_widget.append(row);

            list_objects.push({
                threshold: [threshold_signal, threshold_widget],
                action: [action_signal, action_widget],
                delete: [delete_signal, delete_widget],
            });
        });
    });
}

function deleteNonOccupiedWindows(extension) {
    let settings = extension.getSettings();

    let saved_windows = JSON.parse(settings.get_string(Common.SETTINGS_KEY_SAVED_WINDOWS));

    Object.keys(saved_windows).forEach(function (wsh) {
            let sws = saved_windows[wsh];
            sws.forEach(function (sw, swi) {
                    if (!sw.occupied) {
                            sws.splice(swi, 1);
                            if (sws.length < 1) delete (saved_windows[wsh]);
                    }
            });
    });

    settings.set_string(Common.SETTINGS_KEY_SAVED_WINDOWS, JSON.stringify(saved_windows));
}

function loadSavedWindowsSetting(extension, list_widget, list_objects) {
    let settings = extension.getSettings();

    let saved_windows = JSON.parse(settings.get_string(Common.SETTINGS_KEY_SAVED_WINDOWS));

    let current_row = list_widget.get_first_child();
    current_row = current_row.get_next_sibling(); // skip the first row
    while (current_row !== null) {
        let prev_row = current_row;
        current_row = current_row.get_next_sibling();

        // disconnect signals for all children
        let lo = list_objects.shift();
        if (lo !== null) {
            lo['delete'][1].disconnect(lo['delete'][0]);
            lo['ignore'][1].disconnect(lo['ignore'][0]);
        }

        list_widget.remove(prev_row);
    }

    Object.keys(saved_windows).forEach(function (wsh) {
        let sws = saved_windows[wsh];
        sws.forEach(function (sw, swi) {
            let row_templates = new TemplatesBox();

            let row = row_templates._saved_window_template_listboxrow;
            row.unparent();

            let label_widget = row_templates._saved_window_label;
            label_widget.set_label(wsh + ' - ' + sw.title);
            let label_attrs = Pango.AttrList.new();
            if (!sw.occupied) label_attrs.insert(Pango.attr_strikethrough_new(true));
            label_widget.set_attributes(label_attrs);

            let delete_widget = row_templates._saved_window_delete_button;
            let delete_signal = delete_widget.connect('clicked', function () {
                //console.log('DELETE SAVED WINDOW: ' + JSON.stringify(sw));
                sws.splice(swi, 1);
                if (sws.length < 1) delete (saved_windows[wsh]);
                settings.set_string(Common.SETTINGS_KEY_SAVED_WINDOWS, JSON.stringify(saved_windows));
            });

            let ignore_widget = row_templates._saved_window_ignore_button;
            let ignore_signal = ignore_widget.connect('clicked', function () {
                let o = { query: { title: sw.title }, action: 0 };
                //console.log('ADD OVERRIDE: ' + wsh + ' ' + o);
                let overrides = JSON.parse(settings.get_string(Common.SETTINGS_KEY_OVERRIDES));
                if (!overrides.hasOwnProperty(wsh))
                    overrides[wsh] = new Array();
                overrides[wsh].unshift(o);
                settings.set_string(Common.SETTINGS_KEY_OVERRIDES, JSON.stringify(overrides));
            });

            let ignore_any_widget = row_templates._saved_window_ignore_any_button;
            let ignore_any_signal = ignore_any_widget.connect('clicked', function () {
                let o = { action: 0, threshold: settings.get_double(Common.SETTINGS_KEY_MATCH_THRESHOLD) };
                //console.log('ADD OVERRIDE: ' + wsh + ' ' + o);
                let overrides = JSON.parse(settings.get_string(Common.SETTINGS_KEY_OVERRIDES));
                if (!overrides.hasOwnProperty(wsh))
                    overrides[wsh] = new Array();
                overrides[wsh].push(o);
                settings.set_string(Common.SETTINGS_KEY_OVERRIDES, JSON.stringify(overrides));
            });

            list_widget.append(row);

            list_objects.push({
                delete: [delete_signal, delete_widget],
                ignore: [ignore_signal, ignore_widget],
                ignore_any: [ignore_any_signal, ignore_any_widget],
            });
        });
    });
}
