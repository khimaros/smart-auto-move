'use strict';

const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Gio = imports.gi.Gio;
const Pango = imports.gi.Pango;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const Common = Me.imports.lib.common;

var TemplatesBox = GObject.registerClass({
    GTypeName: 'templates',
    Template: 'file://' + Me.path + '/ui/templates-gtk4.ui',
    InternalChildren: [
        'section-header-label',
        'section-separator',
        'override-template-listboxrow',
        'override-label',
        'override-action-combo',
        'override-delete-button',
        'saved-window-template-listboxrow',
        'saved-window-label',
        'saved-window-delete-button',
        'saved-window-ignore-button',
    ],
}, class TemplatesBox extends Gtk.Box { });

let settings;

let changedOverridesSignal;
let changedSavedWindowsSignal;

function init() { }

function buildPrefsWidget() {
    settings = ExtensionUtils.getSettings(Common.SETTINGS_SCHEMA);

    let builder = new Gtk.Builder();

    builder.add_from_file(Me.path + '/ui/prefs-gtk4.ui');

    let notebook = builder.get_object('prefs-notebook');

    let debugLoggingWidget = builder.get_object('debug-logging-switch');
    settings.bind(
        Common.SETTINGS_KEY_DEBUG_LOGGING,
        debugLoggingWidget,
        'active',
        Gio.SettingsBindFlags.DEFAULT
    );

    let syncModeWidget = builder.get_object('sync-mode-combo');
    settings.bind(
        Common.SETTINGS_KEY_SYNC_MODE,
        syncModeWidget,
        'active-id',
        Gio.SettingsBindFlags.DEFAULT
    );

    let matchThresholdWidget = builder.get_object('match-threshold-spin');
    settings.bind(
        Common.SETTINGS_KEY_MATCH_THRESHOLD,
        matchThresholdWidget,
        'value',
        Gio.SettingsBindFlags.DEFAULT
    );

    let syncFrequencyWidget = builder.get_object('sync-frequency-spin');
    settings.bind(
        Common.SETTINGS_KEY_SYNC_FREQUENCY,
        syncFrequencyWidget,
        'value',
        Gio.SettingsBindFlags.DEFAULT
    );

    let saveFrequencyWidget = builder.get_object('save-frequency-spin');
    settings.bind(
        Common.SETTINGS_KEY_SAVE_FREQUENCY,
        saveFrequencyWidget,
        'value',
        Gio.SettingsBindFlags.DEFAULT
    );

    let overridesListWidget = builder.get_object('overrides-listbox');
    loadOverridesSetting(overridesListWidget);
    changedOverridesSignal = settings.connect('changed::' + Common.SETTINGS_KEY_OVERRIDES, function () { loadOverridesSetting(overridesListWidget); });

    let savedWindowsListWidget = builder.get_object('saved-windows-listbox');
    loadSavedWindowsSetting(savedWindowsListWidget);
    changedSavedWindowsSignal = settings.connect('changed::' + Common.SETTINGS_KEY_SAVED_WINDOWS, function () { loadSavedWindowsSetting(savedWindowsListWidget); });

    return notebook;
}

function loadOverridesSetting(listWidget) {
    let overrides = JSON.parse(settings.get_string(Common.SETTINGS_KEY_OVERRIDES));

    let current_row = listWidget.get_first_child();
    current_row = current_row.get_next_sibling(); // skip the first row
    while (current_row !== null) {
        let prev_row = current_row;
        current_row = current_row.get_next_sibling();
        listWidget.remove(prev_row);
    }

    Object.keys(overrides).forEach(function (wsh) {
        let header_templates = new TemplatesBox();
        let header = header_templates._section_header_label
        header.unparent();
        header.set_label(wsh);
        listWidget.append(header);
        let wshos = overrides[wsh];
        wshos.forEach(function (o, oi) {
            let row_templates = new TemplatesBox();
            let row = row_templates._override_template_listboxrow;
            row.unparent();
            row_templates._override_label.set_label(JSON.stringify(o.query));
            row_templates._override_action_combo.set_active(o.action);
            row_templates._override_action_combo.connect('changed', function (combo) {
                //log('COMBO CHANGED ACTIVE: ' + combo.get_active());
                wshos[oi].action = combo.get_active();
                settings.set_string(Common.SETTINGS_KEY_OVERRIDES, JSON.stringify(overrides));
            });
            row_templates._override_delete_button.connect('clicked', function () {
                //log('DELETE OVERRIDE: ' + JSON.stringify(o));
                wshos.splice(oi, 1);
                if (wshos.length < 1) delete(overrides[wsh]);
                settings.set_string(Common.SETTINGS_KEY_OVERRIDES, JSON.stringify(overrides));
            });
            listWidget.append(row);
        });
        listWidget.append(header_templates._section_separator);
    });
}

function loadSavedWindowsSetting(listWidget) {
    let savedWindows = JSON.parse(settings.get_string(Common.SETTINGS_KEY_SAVED_WINDOWS));

    let current_row = listWidget.get_first_child();
    while (current_row !== null) {
        let prev_row = current_row;
        current_row = current_row.get_next_sibling();
        listWidget.remove(prev_row);
    }

    Object.keys(savedWindows).forEach(function (wsh) {
        let sws = savedWindows[wsh];
        sws.forEach(function (sw, swi) {
            let row_templates = new TemplatesBox();
            let row = row_templates._saved_window_template_listboxrow;
            row.unparent();
            row_templates._saved_window_label.set_label(wsh + ' - ' + sw.title);
            let label_attrs = Pango.AttrList.new();
            if (!sw.occupied) label_attrs.insert(Pango.attr_strikethrough_new(true));
            row_templates._saved_window_label.set_attributes(label_attrs);
            row_templates._saved_window_delete_button.connect('clicked', function () {
                //log('DELETE SAVED WINDOW: ' + JSON.stringify(sw));
                sws.splice(swi, 1);
                if (sws.length < 1) delete(savedWindows[wsh]);
                settings.set_string(Common.SETTINGS_KEY_SAVED_WINDOWS, JSON.stringify(savedWindows));
            });
            row_templates._saved_window_ignore_button.connect('clicked', function () {
                let o = {query: {title: sw.title}, action: 0};
                //log('ADD OVERRIDE: ' + wsh + ' ' + o);
                let overrides = JSON.parse(settings.get_string(Common.SETTINGS_KEY_OVERRIDES));
                if (! overrides.hasOwnProperty(wsh))
                    overrides[wsh] = new Array();
                overrides[wsh].push(o);
                settings.set_string(Common.SETTINGS_KEY_OVERRIDES, JSON.stringify(overrides));
            })
            listWidget.append(row);
        });
    });
}