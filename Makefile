ack: smart-auto-move@khimaros.com.shell-extension.zip
.PHONY: pack

clean:
	rm ./smart-auto-move@khimaros.com.shell-extension.zip ./smart-auto-move@khimaros.com/ui/*-gtk4.ui ./smart-auto-move@khimaros.com/schemas/gschemas.compiled
.PHONY: clean

smart-auto-move@khimaros.com/ui/%-gtk4.ui: smart-auto-move@khimaros.com/ui.in/%-gtk3.ui
	gtk4-builder-tool simplify --3to4 $< > $@

smart-auto-move@khimaros.com.shell-extension.zip: schemas ui ./smart-auto-move@khimaros.com/*
	gnome-extensions pack --force --extra-source=./lib/ --extra-source=./ui/ ./smart-auto-move@khimaros.com/

smart-auto-move@khimaros.com/schemas/gschemas.compiled: smart-auto-move@khimaros.com/schemas/*.gschema.xml
	glib-compile-schemas ./smart-auto-move@khimaros.com/schemas/

schemas: smart-auto-move@khimaros.com/schemas/gschemas.compiled
.PHONY: schemas

ui: smart-auto-move@khimaros.com/ui/prefs-gtk4.ui smart-auto-move@khimaros.com/ui/templates-gtk4.ui
.PHONY: ui

log:
	journalctl -f /usr/bin/gnome-shell
.PHONY: log

install: smart-auto-move@khimaros.com.shell-extension.zip
	#rsync -av ./smart-auto-move@khimaros.com/ $(HOME)/.local/share/gnome-shell/extensions/smart-auto-move@khimaros.com/
	gnome-extensions install --force $<
.PHONY: install

uninstall:
	rm -rf $(HOME)/.local/share/gnome-shell/extensions/smart-auto-move@khimaros.com/
.PHONY: uninstall

start: install
	MUTTER_DEBUG_DUMMY_MODE_SPECS=1600x900 dbus-run-session -- gnome-shell --nested --wayland
.PHONY: start
