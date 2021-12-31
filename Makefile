clean:
	rm ./smart-auto-move@khimaros.com.shell-extension.zip
.PHONY: clean

pack: smart-auto-move@khimaros.com.shell-extension.zip
.PHONY: pack

smart-auto-move@khimaros.com.shell-extension.zip: ./smart-auto-move@khimaros.com/*
	gnome-extensions pack --force ./smart-auto-move@khimaros.com/

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
