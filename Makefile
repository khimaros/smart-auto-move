clean:
	rm ./smart-auto-move@khimaros.com.shell-extension.zip
.PHONY: clean

pack: smart-auto-move@khimaros.com.shell-extension.zip
.PHONY: pack

smart-auto-move@khimaros.com.shell-extension.zip: schemas ./smart-auto-move@khimaros.com/*
	gnome-extensions pack --force ./smart-auto-move@khimaros.com/

smart-auto-move@khimaros.com/schemas/gschemas.compiled: smart-auto-move@khimaros.com/schemas/*.gschema.xml
	glib-compile-schemas ./smart-auto-move@khimaros.com/schemas/

schemas: smart-auto-move@khimaros.com/schemas/gschemas.compiled
.PHONY: schemas

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
