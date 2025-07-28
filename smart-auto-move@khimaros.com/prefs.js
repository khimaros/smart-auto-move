'use strict';

import GObject from "gi://GObject";
import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Pango from "gi://Pango";

import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";
import * as Common from "./lib/common.js";

const ApplicationChooserDialog = GObject.registerClass({
    GTypeName: 'ApplicationChooserDialog',
    Signals: {
        'response': {
            param_types: [GObject.TYPE_STRING],
        },
    },
}, class ApplicationChooserDialog extends Adw.Window {
    _init(props) {
        super._init({
            modal: true,
            title: 'Add Application Override',
            width_request: 450,
            height_request: 600,
            destroy_with_parent: true,
            ...props,
        });

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
        });
        this.set_content(box);

        const headerBar = new Adw.HeaderBar({});
        box.append(headerBar);

        const searchEntry = new Gtk.SearchEntry({
            placeholder_text: 'Search...',
            hexpand: true,
        });
        headerBar.set_title_widget(searchEntry);

        const scrolledWindow = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            hexpand: true,
            vexpand: true,
        });
        box.append(scrolledWindow);

        const listBox = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.SINGLE,
        });
        scrolledWindow.set_child(listBox);

        const apps = Gio.AppInfo.get_all().sort((a, b) => {
            const nameA = a.get_name()?.toLowerCase() || '';
            const nameB = b.get_name()?.toLowerCase() || '';
            if (nameA < nameB) return -1;
            if (nameA > nameB) return 1;
            return 0;
        });

        for (const app of apps) {
            if (!app.get_name()) continue;

            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(app.get_name(), -1),
                activatable: true,
            });
            row._appId = app.get_id();
            row._searchableText = app.get_name().toLowerCase();

            const icon = new Gtk.Image({
                gicon: app.get_icon(),
                pixel_size: 32,
                margin_end: 12,
            });
            row.add_prefix(icon);

            listBox.append(row);
        }

        const filterFunc = (row) => {
            const filterText = searchEntry.get_text().toLowerCase();
            if (!filterText) return true;
            return row._searchableText.includes(filterText);
        };

        listBox.set_filter_func(filterFunc);
        searchEntry.connect('search-changed', () => {
            listBox.invalidate_filter();
        });

        const addButton = new Gtk.Button({
            label: 'Add',
            css_classes: ['suggested-action'],
        });
        addButton.set_sensitive(false);
        headerBar.pack_end(addButton);

        const cancelButton = new Gtk.Button({ label: 'Cancel' });
        headerBar.pack_start(cancelButton);

        listBox.connect('row-selected', () => {
            addButton.set_sensitive(listBox.get_selected_row() !== null);
        });

        listBox.connect('row-activated', (_list, row) => {
            if (row) {
                this.emit('response', row._appId);
                this.close();
            }
        });

        addButton.connect('clicked', () => {
            const selectedRow = listBox.get_selected_row();
            if (selectedRow) {
                this.emit('response', selectedRow._appId);
            }
            this.close();
        });

        cancelButton.connect('clicked', () => this.close());
    }
});

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
        let settings = this.getSettings();

        let builder = new Gtk.Builder();

        builder.add_from_file(this.uiFile);

        window.add(builder.get_object('general-page'));
        window.add(builder.get_object('saved-windows-page'));
        window.add(builder.get_object('overrides-page'));

        /// GENERAL

        Common.SETTINGS_CONFIG.forEach(c => {
            if (!c.widgetId) return;
            const widget = builder.get_object(c.widgetId);
            settings.bind(
                c.key,
                widget,
                c.property,
                Gio.SettingsBindFlags.DEFAULT
            );
        });

        /// SAVED WINDOWS

        let saved_windows_list_widget = builder.get_object('saved-windows-listbox');
        let saved_windows_list_objects = [];
        let saved_windows_cleanup_widget = builder.get_object('saved-windows-cleanup-button');
        saved_windows_cleanup_widget.connect('clicked', () => {
            //console.log('CLEANUP BUTTON CLICKED');
            deleteNonOccupiedWindows(this);
        });

        let saved_windows_filter_widget = builder.get_object('saved-windows-filter-entry');
        const filter_func = (row) => {
            const filter_text = saved_windows_filter_widget.get_text().toLowerCase();
            if (!filter_text)
                return true;

            // Saved window rows have this property.
            if (row.searchable_text) {
                return row.searchable_text.includes(filter_text);
            }
            
            // Everything else (like the cleanup button row) is not filtered.
            return true;
        };
        saved_windows_list_widget.set_filter_func(filter_func);
        saved_windows_filter_widget.connect('search-changed', () => {
            saved_windows_list_widget.invalidate_filter();
        });

        loadSavedWindowsSetting(this, saved_windows_list_widget, saved_windows_list_objects);
        changedSavedWindowsSignal = settings.connect('changed::' + Common.SETTINGS_KEY_SAVED_WINDOWS, () => {
            loadSavedWindowsSetting(this, saved_windows_list_widget, saved_windows_list_objects);
        });

        /// OVERRIDES

        let overrides_list_objects = [];
        let overrides_list_widget = builder.get_object('overrides-listbox');
        let overrides_add_application_widget = builder.get_object('overrides-add-application-button');
        overrides_add_application_widget.connect('clicked', () => {
            const dialog = new ApplicationChooserDialog({ transient_for: window.get_root() });
            dialog.connect('response', (_source, appId) => {
                if (appId) {
                    if (appId.endsWith('.desktop')) {
                        appId = appId.slice(0, -'.desktop'.length);
                    }
                    let overrides = JSON.parse(settings.get_string(Common.SETTINGS_KEY_OVERRIDES));
                    if (!overrides.hasOwnProperty(appId)) {
                        overrides[appId] = [];
                    }

                    // Add a default "ignore any" override for this app
                    let o = { action: Common.SYNC_MODE_IGNORE, threshold: settings.get_double(Common.SETTINGS_KEY_MATCH_THRESHOLD) };
                    overrides[appId].push(o);
                    settings.set_string(Common.SETTINGS_KEY_OVERRIDES, JSON.stringify(overrides));
                }
            });
            dialog.present();
        });
        loadOverridesSetting(this, overrides_list_widget, overrides_list_objects);
        changedOverridesSignal = settings.connect('changed::' + Common.SETTINGS_KEY_OVERRIDES, () => {
            loadOverridesSetting(this, overrides_list_widget, overrides_list_objects);
        });
    }

    get uiFile() {
        return `${this.path}/ui/prefs-gtk4.ui`;
    }
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
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    settings.set_string(Common.SETTINGS_KEY_OVERRIDES, JSON.stringify(overrides));
                    return GLib.SOURCE_REMOVE;
                });
            });

            let action_widget = row_templates._override_action_combo
            if (o.action !== undefined) action_widget.set_active(o.action);
            else action_widget.set_active(2);
            let action_signal = action_widget.connect('changed', function (combo) {
                let action = combo.get_active();
                if (action === 2) action = undefined;
                //console.log('COMBO CHANGED ACTIVE: ' + combo.get_active());
                wshos[oi].action = action;
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    settings.set_string(Common.SETTINGS_KEY_OVERRIDES, JSON.stringify(overrides));
                    return GLib.SOURCE_REMOVE;
                });
            });

            let delete_widget = row_templates._override_delete_button;
            let delete_signal = delete_widget.connect('clicked', function () {
                //console.log('DELETE OVERRIDE: ' + JSON.stringify(o));
                wshos.splice(oi, 1);
                if (wshos.length < 1) delete (overrides[wsh]);
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    settings.set_string(Common.SETTINGS_KEY_OVERRIDES, JSON.stringify(overrides));
                    return GLib.SOURCE_REMOVE;
                });
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
            const label_text = wsh + ' - ' + sw.title;
            label_widget.set_label(label_text);
            row.searchable_text = label_text.toLowerCase();
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
