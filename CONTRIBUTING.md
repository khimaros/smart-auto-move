# CONTRIBUTING

NOTE: this process has only been tested with GNOME running on wayland.

clone this repository and run `make start`.

this will do the following:

- build the extension pack .zip
- install the extension pack
- launch a nested wayland Gnome-Shell session

after the nested instance is running, you will need to enable the extension:

```
$ gnome-extensions enable smart-auto-move@khimaros.com
```

if you make a change to the source code, you will need to exit the session and start a new one.

## adding new preferences

see commit 9edd9e3210a1541d5c2915943c7a2b238ce7a856 for an end-to-end example.

## publishing

1. update `metadata.json` to latest uploaded version + 1
1. generate the extension zip with `make`
1. upload the zip to extensions.gnome.org
1. repeat as needed if a version is rejected

## testing

see TESTING.md
