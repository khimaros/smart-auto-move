NAME = smart-auto-move
UUID = $(NAME)@khimaros.com

build:
	mkdir -p build/
	gnome-extensions pack -f \
		--extra-source=metadata.json \
		--extra-source=extension.js \
		--extra-source=prefs.js \
		--extra-source=common.js \
		--extra-source=migrations.js \
		--extra-source=lib/ \
		--extra-source=ui/ \
		-o build/
.PHONY: build

clean:
	rm -rf ./build/ ./src/schemas/gschemas.compiled
.PHONY: clean

install: uninstall build
	gnome-extensions install -f build/$(UUID).shell-extension.zip
.PHONY: install

uninstall:
	rm -rf  $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
.PHONY: uninstall

schemas: schemas/gschemas.compiled
.PHONY: schemas

schemas/gschemas.compiled: schemas/*.gschema.xml
	glib-compile-schemas ./schemas/

log:
	journalctl -f /usr/bin/gnome-shell /usr/bin/gjs
.PHONY: log

start: install
	MUTTER_DEBUG_DUMMY_MODE_SPECS=1600x900 dbus-run-session -- gnome-shell --nested --wayland
.PHONY: start

start-prefs: install
	gnome-extensions prefs $(UUID)
.PHONY: start-prefs
