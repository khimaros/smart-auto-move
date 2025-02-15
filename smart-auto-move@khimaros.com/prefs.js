"use strict";
import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gio from "gi://Gio";
import {
  ExtensionPreferences,
  gettext as _,
} from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

import * as Common from "./lib/common.js";

export default class SAMPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    window.search_enabled = true;
    window.set_default_size(675, 700);
    const builder = new Gtk.Builder();
    builder.add_from_file(this.path + "/ui/prefs-adw.ui");
    const page1 = builder.get_object("smartautomove_page1");
    window.add(page1);
    const page2 = builder.get_object("smartautomove_page2");
    window.add(page2);
    const page3 = builder.get_object("smartautomove_page3");
    window.add(page3);
    const matchthresholdspin = builder.get_object("match-threshold-spin");
    matchthresholdspin.set_climb_rate(0.1);
    matchthresholdspin.set_digits(2);
    matchthresholdspin.set_numeric(true);
    const syncfrequencyspin = builder.get_object("sync-frequency-spin");
    syncfrequencyspin.set_climb_rate(10);
    syncfrequencyspin.set_numeric(true);
    const savefrequencyspin = builder.get_object("save-frequency-spin");
    savefrequencyspin.set_climb_rate(50);
    savefrequencyspin.set_numeric(true);

    this._general(this.getSettings(), builder);
    this._savedwindows(this.getSettings(), builder);
    this._overrides(this.getSettings(), builder);
  }

  _general(settings, builder) {
    const generalBindings = [
      [Common.SETTINGS_KEY_DEBUG_LOGGING, "debug-logging-switch", "active"],
      [Common.SETTINGS_KEY_SYNC_MODE, "sync-mode-combo", "selected"],
      [Common.SETTINGS_KEY_MATCH_THRESHOLD, "match-threshold-spin", "value"],
      [Common.SETTINGS_KEY_SYNC_FREQUENCY, "sync-frequency-spin", "value"],
      [Common.SETTINGS_KEY_SAVE_FREQUENCY, "save-frequency-spin", "value"],
      [Common.SETTINGS_KEY_FREEZE_SAVES, "freeze-saves-switch", "active"],
      [
        Common.SETTINGS_KEY_ACTIVATE_WORKSPACE,
        "activate-workspace-switch",
        "active",
      ],
      [Common.SETTINGS_KEY_IGNORE_POSITION, "ignore-position-switch", "active"],
      [
        Common.SETTINGS_KEY_IGNORE_WORKSPACE,
        "ignore-workspace-switch",
        "active",
      ],
    ];

    generalBindings.forEach(([key, widgetId, property]) => {
      const widget = builder.get_object(widgetId);
      if (property === "selected") {
        widget[property] = settings.get_enum(key);

        widget.connect(`notify::${property}`, () => {
          settings.set_enum(key, widget[property]);
        });

        settings.connect(`changed::${key}`, () => {
          widget[property] = settings.get_enum(key);
        });
      } else {
        settings.bind(key, widget, property, Gio.SettingsBindFlags.DEFAULT);
      }
    });
  }

  _savedwindows(settings, builder) {
    const saved_windows_list_widget = builder.get_object(
      "saved-windows-listbox"
    );
    const saved_windows_list_objects = [];
    const saved_windows_cleanup_widget = builder.get_object(
      "saved-windows-cleanup-button"
    );
    saved_windows_cleanup_widget.connect("activated", () => {
      this._deleteNonOccupiedWindows(settings);
    });
    this._loadSavedWindowsSetting(
      settings,
      saved_windows_list_widget,
      saved_windows_list_objects
    );
    this.changedSavedWindowsSignal = settings.connect(
      "changed::" + Common.SETTINGS_KEY_SAVED_WINDOWS,
      () => {
        this._loadSavedWindowsSetting(
          settings,
          saved_windows_list_widget,
          saved_windows_list_objects
        );
      }
    );
  }

  _overrides(settings, builder) {
    const overrides_list_objects = [];
    const overrides_list_widget = builder.get_object("overrides-listbox");
    const overrides_add_application_widget = builder.get_object(
      "overrides-add-application-button"
    );
    overrides_add_application_widget.connect("clicked", () => {
      // TODO
    });
    this._loadOverridesSetting(
      settings,
      overrides_list_widget,
      overrides_list_objects
    );
    this.changedOverridesSignal = settings.connect(
      "changed::" + Common.SETTINGS_KEY_OVERRIDES,
      () => {
        this._loadOverridesSetting(
          settings,
          overrides_list_widget,
          overrides_list_objects
        );
      }
    );
  }

  _clearListWidget(list_widget, list_objects) {
    let current_row = list_widget.get_first_child();
    current_row = current_row.get_next_sibling(); // skip the first row
    while (current_row !== null) {
      let prev_row = current_row;
      current_row = current_row.get_next_sibling();

      let lo = list_objects.shift();
      if (lo !== null) {
        Object.values(lo).forEach(([signal, widget]) => {
          widget.disconnect(signal);
        });
      }

      list_widget.remove(prev_row);
    }
  }

  _loadOverridesSetting(settings, list_widget, list_objects) {
    const overrides = JSON.parse(
      settings.get_string(Common.SETTINGS_KEY_OVERRIDES)
    );
    this._clearListWidget(list_widget, list_objects);
    Object.keys(overrides).forEach((wsh) => {
      const adwexprow = new Adw.ExpanderRow();
      adwexprow.set_title(wsh);
      adwexprow.set_expanded(true);
      list_widget.add(adwexprow);
      list_objects.push(null);

      const wshos = overrides[wsh];
      wshos.forEach((o, oi) => {
        let query = _("ANY");
        const row = new Adw.ActionRow();

        if (o.query) query = JSON.stringify(o.query);
        row.set_title(query);
        adwexprow.add_row(row);

        const threshold_widget = Gtk.SpinButton.new_with_range(0, 1, 0.01);
        threshold_widget.set_numeric(true);
        threshold_widget.set_digits(2);
        threshold_widget.set_climb_rate(0.1);
        threshold_widget.set_valign(Gtk.Align.CENTER);
        row.add_suffix(threshold_widget);
        if (o.query !== undefined) threshold_widget.set_sensitive(false);
        if (o.threshold !== undefined) threshold_widget.set_value(o.threshold);
        const threshold_signal = threshold_widget.connect(
          "value-changed",
          (spin) => {
            let threshold = spin.get_value();
            if (threshold <= 0.01) threshold = undefined;
            wshos[oi].threshold = threshold;
            settings.set_string(
              Common.SETTINGS_KEY_OVERRIDES,
              JSON.stringify(overrides)
            );
          }
        );

        const action_widget = new Gtk.ComboBoxText();
        action_widget.append_text(_("IGNORE"), "IGNORE");
        action_widget.append_text(_("RESTORE"), "RESTORE");
        action_widget.append_text(_("DEFAULT"), "DEFAULT");
        action_widget.set_valign(Gtk.Align.CENTER);
        row.add_suffix(action_widget);
        if (o.action !== undefined) action_widget.set_active(o.action);
        else action_widget.set_active(2);
        let action_signal = action_widget.connect("changed", (combo) => {
          let action = combo.get_active();
          if (action === 2) action = undefined;
          wshos[oi].action = action;
          settings.set_string(
            Common.SETTINGS_KEY_OVERRIDES,
            JSON.stringify(overrides)
          );
        });

        const delete_widget = new Gtk.Button({
          valign: Gtk.Align.CENTER,
          css_classes: ["destructive-action"],
        });
        delete_widget.set_tooltip_text(_("Delete"));
        delete_widget.set_icon_name("user-trash-symbolic");
        row.add_suffix(delete_widget);
        let delete_signal = delete_widget.connect("clicked", () => {
          wshos.splice(oi, 1);
          if (wshos.length < 1) delete overrides[wsh];
          settings.set_string(
            Common.SETTINGS_KEY_OVERRIDES,
            JSON.stringify(overrides)
          );
        });

        list_widget.add(row);

        list_objects.push({
          threshold: [threshold_signal, threshold_widget],
          action: [action_signal, action_widget],
          delete: [delete_signal, delete_widget],
        });
      });
    });
  }

  _deleteNonOccupiedWindows(settings) {
    const saved_windows = JSON.parse(
      settings.get_string(Common.SETTINGS_KEY_SAVED_WINDOWS)
    );

    Object.keys(saved_windows).forEach((wsh) => {
      let sws = saved_windows[wsh];
      sws.forEach((sw, swi) => {
        if (!sw.occupied) {
          sws.splice(swi, 1);
          if (sws.length < 1) delete saved_windows[wsh];
        }
      });
    });

    settings.set_string(
      Common.SETTINGS_KEY_SAVED_WINDOWS,
      JSON.stringify(saved_windows)
    );
  }

  _loadSavedWindowsSetting(settings, list_widget, list_objects) {
    const saved_windows = JSON.parse(
      settings.get_string(Common.SETTINGS_KEY_SAVED_WINDOWS)
    );
    this._clearListWidget(list_widget, list_objects);
    Object.keys(saved_windows).forEach((wsh) => {
      let sws = saved_windows[wsh];
      sws.forEach((sw, swi) => {
        const row = new Adw.ActionRow();
        row.set_title(wsh);
        row.set_tooltip_text(wsh + " - " + sw.title);
        if (!sw.occupied) row.set_subtitle(_("Not occupied"));
        const delete_widget = new Gtk.Button({
          valign: Gtk.Align.CENTER,
          css_classes: ["destructive-action"],
        });
        delete_widget.set_tooltip_text(_("Delete"));
        delete_widget.set_icon_name("user-trash-symbolic");
        row.add_suffix(delete_widget);
        const delete_signal = delete_widget.connect("clicked", () => {
          sws.splice(swi, 1);
          if (sws.length < 1) delete saved_windows[wsh];
          settings.set_string(
            Common.SETTINGS_KEY_SAVED_WINDOWS,
            JSON.stringify(saved_windows)
          );
        });

        const ignore_widget = new Gtk.Button({
          valign: Gtk.Align.CENTER,
        });
        ignore_widget.set_tooltip_text(_("OVERRIDE"));
        ignore_widget.set_icon_name("application-add-symbolic");
        row.add_suffix(ignore_widget);
        const ignore_signal = ignore_widget.connect("clicked", () => {
          let o = { query: { title: sw.title }, action: 0 };
          let overrides = JSON.parse(
            settings.get_string(Common.SETTINGS_KEY_OVERRIDES)
          );
          if (!overrides.hasOwnProperty(wsh)) overrides[wsh] = [];
          overrides[wsh].unshift(o);
          settings.set_string(
            Common.SETTINGS_KEY_OVERRIDES,
            JSON.stringify(overrides)
          );
        });

        const ignore_any_widget = new Gtk.Button({
          label: _("ANY"),
          valign: Gtk.Align.CENTER,
          css_classes: ["suggested-action"],
        });
        ignore_any_widget.set_tooltip_text(_("OVERRIDE (ANY)"));
        ignore_any_widget.set_icon_name("application-add-symbolic");
        row.add_suffix(ignore_any_widget);
        const ignore_any_signal = ignore_any_widget.connect("clicked", () => {
          let o = {
            action: 0,
            threshold: settings.get_double(Common.SETTINGS_KEY_MATCH_THRESHOLD),
          };
          let overrides = JSON.parse(
            settings.get_string(Common.SETTINGS_KEY_OVERRIDES)
          );
          if (!overrides.hasOwnProperty(wsh)) overrides[wsh] = [];
          overrides[wsh].push(o);
          settings.set_string(
            Common.SETTINGS_KEY_OVERRIDES,
            JSON.stringify(overrides)
          );
        });

        list_widget.add(row);

        list_objects.push({
          delete: [delete_signal, delete_widget],
          ignore: [ignore_signal, ignore_widget],
          ignore_any: [ignore_any_signal, ignore_any_widget],
        });
      });
    });
  }
}
