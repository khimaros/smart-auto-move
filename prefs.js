"use strict";

import GObject from "gi://GObject";
import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Pango from "gi://Pango";

import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";
import * as Common from "./common.js";
import { debug, setDebugEnabled } from "./lib/utils.js";

/**
 * Base class for chooser dialogs with search and list selection.
 * Subclasses must implement _loadItems() and _emitResponse().
 */
const BaseChooserDialog = GObject.registerClass(
  {
    GTypeName: "BaseChooserDialog",
    Properties: {
      "dialog-title": GObject.ParamSpec.string(
        "dialog-title",
        "Dialog Title",
        "The title of the dialog",
        GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
        ""
      ),
    },
  },
  class BaseChooserDialog extends Adw.Window {
    _init(props = {}) {
      super._init({
        modal: true,
        title: props.dialogTitle || "",
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

      this._searchEntry = new Gtk.SearchEntry({
        placeholder_text: "Search...",
        hexpand: true,
      });
      headerBar.set_title_widget(this._searchEntry);

      const scrolledWindow = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        hexpand: true,
        vexpand: true,
      });
      box.append(scrolledWindow);

      this._listBox = new Gtk.ListBox({
        selection_mode: Gtk.SelectionMode.SINGLE,
      });
      scrolledWindow.set_child(this._listBox);

      this._listBox.set_filter_func((row) => {
        const filterText = this._searchEntry.get_text().toLowerCase();
        if (!filterText) return true;
        return row._searchableText?.includes(filterText) ?? true;
      });

      this._searchEntry.connect("search-changed", () => {
        this._listBox.invalidate_filter();
      });

      const addButton = new Gtk.Button({
        label: "Add",
        css_classes: ["suggested-action"],
      });
      addButton.set_sensitive(false);
      headerBar.pack_end(addButton);

      const cancelButton = new Gtk.Button({ label: "Cancel" });
      headerBar.pack_start(cancelButton);

      this._listBox.connect("row-selected", () => {
        addButton.set_sensitive(this._listBox.get_selected_row() !== null);
      });

      this._listBox.connect("row-activated", (_list, row) => {
        if (row) {
          this._emitResponse(row);
          this.close();
        }
      });

      addButton.connect("clicked", () => {
        const selectedRow = this._listBox.get_selected_row();
        if (selectedRow) {
          this._emitResponse(selectedRow);
        }
        this.close();
      });

      cancelButton.connect("clicked", () => this.close());

      this._loadItems();
    }

    /** Override in subclass to populate list items */
    _loadItems() {}

    /** Override in subclass to emit response with appropriate values */
    _emitResponse(_row) {}
  },
);

const ApplicationChooserDialog = GObject.registerClass(
  {
    GTypeName: "ApplicationChooserDialog",
    Signals: {
      response: { param_types: [GObject.TYPE_STRING] },
    },
  },
  class ApplicationChooserDialog extends BaseChooserDialog {
    _init(props = {}) {
      super._init({ dialogTitle: "Add Application Override", ...props });
    }

    _loadItems() {
      const apps = Gio.AppInfo.get_all().sort((a, b) => {
        const nameA = a.get_name()?.toLowerCase() || "";
        const nameB = b.get_name()?.toLowerCase() || "";
        return nameA.localeCompare(nameB);
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

        this._listBox.append(row);
      }
    }

    _emitResponse(row) {
      this.emit("response", row._appId);
    }
  },
);

const SmartAutoMoveProxy = Gio.DBusProxy.makeProxyWrapper(
  Common.DBUS_INTERFACE,
);

const WindowChooserDialog = GObject.registerClass(
  {
    GTypeName: "WindowChooserDialog",
    Signals: {
      response: { param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING] },
    },
  },
  class WindowChooserDialog extends BaseChooserDialog {
    _init(props = {}) {
      this._dbus = new SmartAutoMoveProxy(
        Gio.DBus.session,
        Common.DBUS_NAME,
        Common.DBUS_PATH,
      );
      super._init({ dialogTitle: "Add Window Override", ...props });
    }

    _loadItems() {
      debug("prefs", "calling ListWindows");
      this._dbus.ListWindowsRemote((result, err) => {
        if (err) {
          debug("prefs", `ListWindows error: ${err}`, true);
          return;
        }
        const [windows_json] = result;
        debug("prefs", `ListWindows returned JSON: ${windows_json}`);
        const windows = JSON.parse(windows_json);
        windows.sort((a, b) => {
          const nameA = a.title?.toLowerCase() || "";
          const nameB = b.title?.toLowerCase() || "";
          return nameA.localeCompare(nameB);
        });

        for (const win of windows) {
          const row = new Adw.ActionRow({
            title: GLib.markup_escape_text(win.title, -1),
            subtitle: GLib.markup_escape_text(win.wsh, -1),
            activatable: true,
          });
          row._wsh = win.wsh;
          row._title = win.title;
          row._searchableText = (win.title + " " + win.wsh).toLowerCase();

          if (win.app_icon) {
            const icon = new Gtk.Image({
              gicon: Gio.icon_new_for_string(win.app_icon),
              pixel_size: 32,
              margin_end: 12,
            });
            row.add_prefix(icon);
          }
          this._listBox.append(row);
        }
      });
    }

    _emitResponse(row) {
      this.emit("response", row._wsh, row._title);
    }
  },
);

const TemplatesBox = GObject.registerClass(
  {
    GTypeName: "templates",
    Template: GLib.path_get_dirname(import.meta.url) + "/ui/templates-gtk4.ui",
    InternalChildren: [
      "section-header-label",
      "override-template-listboxrow",
      "override-label",
      "override-threshold-spin",
      "override-action-combo",
      "override-delete-button",
      "saved-window-template-listboxrow",
      "saved-window-label",
      "saved-window-delete-button",
      "saved-window-ignore-button",
      "saved-window-ignore-any-button",
    ],
  },
  class TemplatesBox extends Gtk.Box {},
);

/** Helper to disconnect all signals from a list of [widget, signalId] pairs */
function disconnectSignals(connections) {
  for (const [widget, signalId] of connections) {
    widget.disconnect(signalId);
  }
}

export default class SAMPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();
    setDebugEnabled(settings.get_boolean(Common.SETTINGS_KEY_DEBUG_LOGGING));

    const builder = new Gtk.Builder();

    try {
      builder.add_from_file(this.uiFile);
    } catch (e) {
      debug("prefs", `Failed to load UI file: ${e.message}`, true);
      throw e;
    }

    window.add(builder.get_object("general-page"));
    window.add(builder.get_object("saved-windows-page"));
    window.add(builder.get_object("overrides-page"));

    // Track signal handlers for cleanup
    this._signalHandlers = { overrides: null, savedWindows: null };

    /// GENERAL

    Common.SETTINGS_CONFIG.forEach((c) => {
      if (!c.widgetId) return;
      const widget = builder.get_object(c.widgetId);
      if (!widget) {
        debug("prefs", `Widget '${c.widgetId}' not found in UI file`, true);
        return;
      }
      settings.bind(c.key, widget, c.property, Gio.SettingsBindFlags.DEFAULT);
    });

    /// SAVED WINDOWS

    let saved_windows_list_widget = builder.get_object("saved-windows-listbox");
    let saved_windows_list_objects = [];
    let saved_windows_cleanup_widget = builder.get_object(
      "saved-windows-cleanup-button",
    );
    saved_windows_cleanup_widget.connect("clicked", () => {
      //console.log('CLEANUP BUTTON CLICKED');
      deleteNonOccupiedWindows(this);
    });

    let saved_windows_filter_widget = builder.get_object(
      "saved-windows-filter-entry",
    );
    const filter_func = (row) => {
      const filter_text = saved_windows_filter_widget.get_text().toLowerCase();
      if (!filter_text) return true;

      // Saved window rows have this property.
      if (row.searchable_text) {
        return row.searchable_text.includes(filter_text);
      }

      // Everything else (like the cleanup button row) is not filtered.
      return true;
    };
    saved_windows_list_widget.set_filter_func(filter_func);
    saved_windows_filter_widget.connect("search-changed", () => {
      saved_windows_list_widget.invalidate_filter();
    });

    loadSavedWindowsSetting(
      this,
      saved_windows_list_widget,
      saved_windows_list_objects,
    );
    this._signalHandlers.savedWindows = settings.connect(
      "changed::" + Common.SETTINGS_KEY_SAVED_WINDOWS,
      () => {
        loadSavedWindowsSetting(
          this,
          saved_windows_list_widget,
          saved_windows_list_objects,
        );
      },
    );

    /// OVERRIDES

    const overrides_list_objects = [];
    const overrides_list_widget = builder.get_object("overrides-listbox");
    const overrides_add_application_widget = builder.get_object(
      "overrides-add-application-button",
    );
    overrides_add_application_widget.connect("clicked", () => {
      const dialog = new ApplicationChooserDialog({
        transient_for: window.get_root(),
      });
      dialog.connect("response", (_source, appId) => {
        if (appId) {
          const normalizedAppId = appId.endsWith(".desktop")
            ? appId.slice(0, -".desktop".length)
            : appId;
          const overrides = JSON.parse(
            settings.get_string(Common.SETTINGS_KEY_OVERRIDES) || "{}",
          );
          if (!overrides[normalizedAppId]) {
            overrides[normalizedAppId] = [];
          }
          overrides[normalizedAppId].push({
            action: "IGNORE",
            threshold: settings.get_double(Common.SETTINGS_KEY_MATCH_THRESHOLD),
          });
          GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            settings.set_string(
              Common.SETTINGS_KEY_OVERRIDES,
              JSON.stringify(overrides),
            );
            return GLib.SOURCE_REMOVE;
          });
        }
      });
      dialog.present();
    });

    const overrides_add_window_widget = builder.get_object(
      "overrides-add-window-button",
    );
    overrides_add_window_widget.connect("clicked", () => {
      const dialog = new WindowChooserDialog({
        transient_for: window.get_root(),
      });
      dialog.connect("response", (_source, wsh, title) => {
        if (wsh && title) {
          const overrides = JSON.parse(
            settings.get_string(Common.SETTINGS_KEY_OVERRIDES) || "{}",
          );
          if (!overrides[wsh]) {
            overrides[wsh] = [];
          }
          overrides[wsh].unshift({
            title,
            action: "IGNORE",
          });
          GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            settings.set_string(
              Common.SETTINGS_KEY_OVERRIDES,
              JSON.stringify(overrides),
            );
            return GLib.SOURCE_REMOVE;
          });
        }
      });
      dialog.present();
    });
    loadOverridesSetting(
      settings,
      overrides_list_widget,
      overrides_list_objects,
      this._signalHandlers,
    );
    this._signalHandlers.overrides = settings.connect(
      "changed::" + Common.SETTINGS_KEY_OVERRIDES,
      () => {
        loadOverridesSetting(
          settings,
          overrides_list_widget,
          overrides_list_objects,
          this._signalHandlers,
        );
      },
    );
  }

  get uiFile() {
    return `${this.path}/ui/prefs-gtk4.ui`;
  }
}

function loadOverridesSetting(settings, list_widget, list_objects, signalHandlers) {
  const overrides = Common.parseOverrides(
    settings.get_string(Common.SETTINGS_KEY_OVERRIDES)
  );

  // The first row is the static 'Add' button, so we skip it when clearing.
  let current_row = list_widget.get_first_child();
  if (current_row) {
    current_row = current_row.get_next_sibling();
  }

  while (current_row !== null) {
    const prev_row = current_row;
    current_row = current_row.get_next_sibling();

    // Disconnect signals for all children (array of [widget, signalId] pairs)
    const connections = list_objects.shift();
    if (connections) {
      disconnectSignals(connections);
    }
    list_widget.remove(prev_row);
  }

  Object.keys(overrides).forEach((wsh) => {
    const header_templates = new TemplatesBox();
    const header = header_templates._section_header_label;
    header.unparent();
    header.set_label(wsh);
    list_widget.append(header);
    list_objects.push(null);

    const wshos = overrides[wsh];
    wshos.forEach((o, oi) => {
      const row_templates = new TemplatesBox();
      const row = row_templates._override_template_listboxrow;
      row.unparent();

      const label_widget = row_templates._override_label;
      label_widget.set_label(o.title ? o.title : "ANY");

      const threshold_widget = row_templates._override_threshold_spin;
      if (o.threshold !== undefined) threshold_widget.set_value(o.threshold);

      const action_widget = row_templates._override_action_combo;
      action_widget.set_active_id(Common.getActionId(o.action));

      const delete_widget = row_templates._override_delete_button;

      // Helper to save overrides with signal blocking
      const saveOverrides = (block = true) => {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
          if (block && signalHandlers.overrides) {
            settings.block_signal_handler(signalHandlers.overrides);
          }
          settings.set_string(Common.SETTINGS_KEY_OVERRIDES, JSON.stringify(overrides));
          if (block && signalHandlers.overrides) {
            settings.unblock_signal_handler(signalHandlers.overrides);
          }
          return GLib.SOURCE_REMOVE;
        });
      };

      const threshold_signal = threshold_widget.connect("value-changed", (spin) => {
        const value = spin.get_value();
        wshos[oi].threshold = value <= 0.01 ? undefined : Math.round(value * 100) / 100;
        saveOverrides();
      });

      const action_signal = action_widget.connect("changed", (combo) => {
        const actionId = combo.get_active_id();
        wshos[oi].action = actionId === "IGNORE" ? "IGNORE"
          : actionId === "RESTORE" ? "RESTORE"
          : undefined;
        saveOverrides();
      });

      const delete_signal = delete_widget.connect("clicked", () => {
        wshos.splice(oi, 1);
        if (wshos.length < 1) delete overrides[wsh];
        saveOverrides(false);
      });

      list_widget.append(row);

      // Store as array of [widget, signalId] pairs for easy cleanup
      list_objects.push([
        [threshold_widget, threshold_signal],
        [action_widget, action_signal],
        [delete_widget, delete_signal],
      ]);
    });
  });
}

function deleteNonOccupiedWindows(extension) {
  const settings = extension.getSettings();

  const doCleanup = () => {
    let saved_windows_data = JSON.parse(
      settings.get_string(Common.SETTINGS_KEY_SAVED_WINDOWS) || "[]",
    );

    if (Array.isArray(saved_windows_data)) {
      saved_windows_data = saved_windows_data.filter((sw_obj) => sw_obj.occupied);
    } else {
      Common.deleteNonOccupiedWindows(saved_windows_data);
    }

    settings.set_string(
      Common.SETTINGS_KEY_SAVED_WINDOWS,
      JSON.stringify(saved_windows_data),
    );
  };

  // Use the D-Bus service to refresh occupied status first
  const dbus = new SmartAutoMoveProxy(
    Gio.DBus.session,
    Common.DBUS_NAME,
    Common.DBUS_PATH,
  );

  dbus.RefreshFromCurrentActorsRemote((_result, err) => {
    if (err) {
      debug("prefs", `RefreshFromCurrentActors error: ${err}`, true);
      doCleanup();
      return;
    }

    // Wait for the state to be updated, then filter
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
      doCleanup();
      return GLib.SOURCE_REMOVE;
    });
  });
}

function loadSavedWindowsSetting(extension, list_widget, list_objects) {
  const settings = extension.getSettings();

  const saved_windows_data = JSON.parse(
    settings.get_string(Common.SETTINGS_KEY_SAVED_WINDOWS) || "[]",
  );

  // Convert new array format to the old object-of-arrays format for the UI
  const saved_windows = {};
  if (Array.isArray(saved_windows_data)) {
    saved_windows_data.forEach((sw_obj) => {
      const props = sw_obj.props;
      if (!props || !props.wm_class) return;
      const wsh = props.wm_class;
      if (!saved_windows[wsh]) {
        saved_windows[wsh] = [];
      }
      saved_windows[wsh].push({ ...props, occupied: sw_obj.occupied });
    });
  } else {
    Object.assign(saved_windows, saved_windows_data);
  }

  // Clear existing rows and disconnect signals
  let current_row = list_widget.get_first_child();
  while (current_row !== null) {
    const prev_row = current_row;
    current_row = current_row.get_next_sibling();

    const connections = list_objects.shift();
    if (connections) {
      disconnectSignals(connections);
    }
    list_widget.remove(prev_row);
  }

  Object.keys(saved_windows).forEach((wsh) => {
    const sws = saved_windows[wsh];
    sws.forEach((sw, swi) => {
      const row_templates = new TemplatesBox();
      const row = row_templates._saved_window_template_listboxrow;
      row.unparent();

      const label_widget = row_templates._saved_window_label;
      const label_text = `${wsh} - ${sw.title}`;
      label_widget.set_label(label_text);
      row.searchable_text = label_text.toLowerCase();

      const label_attrs = Pango.AttrList.new();
      if (!sw.occupied) {
        label_attrs.insert(Pango.attr_strikethrough_new(true));
      }
      label_widget.set_attributes(label_attrs);

      const delete_widget = row_templates._saved_window_delete_button;
      const ignore_widget = row_templates._saved_window_ignore_button;
      const ignore_any_widget = row_templates._saved_window_ignore_any_button;

      const delete_signal = delete_widget.connect("clicked", () => {
        sws.splice(swi, 1);
        if (sws.length < 1) delete saved_windows[wsh];
        settings.set_string(
          Common.SETTINGS_KEY_SAVED_WINDOWS,
          JSON.stringify(saved_windows),
        );
      });

      const ignore_signal = ignore_widget.connect("clicked", () => {
        const overrides = JSON.parse(
          settings.get_string(Common.SETTINGS_KEY_OVERRIDES) || "{}",
        );
        Common.ignoreSavedWindow(saved_windows, overrides, wsh, swi, 0, false);
        settings.set_string(Common.SETTINGS_KEY_OVERRIDES, JSON.stringify(overrides));
      });

      const ignore_any_signal = ignore_any_widget.connect("clicked", () => {
        const overrides = JSON.parse(
          settings.get_string(Common.SETTINGS_KEY_OVERRIDES) || "{}",
        );
        const threshold = settings.get_double(Common.SETTINGS_KEY_MATCH_THRESHOLD);
        Common.ignoreSavedWindow(saved_windows, overrides, wsh, swi, threshold, true);
        settings.set_string(Common.SETTINGS_KEY_OVERRIDES, JSON.stringify(overrides));
      });

      list_widget.append(row);

      // Store as array of [widget, signalId] pairs for easy cleanup
      list_objects.push([
        [delete_widget, delete_signal],
        [ignore_widget, ignore_signal],
        [ignore_any_widget, ignore_any_signal],
      ]);
    });
  });
}
