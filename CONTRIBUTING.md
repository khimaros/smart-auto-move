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

## manual tests

### calculator

- open calculator
- move calculator position
- resize calculator
- close calculator
- open calculator
- quickly close calculator
- open calculator

### files

- open Places => Home
- open a second Places => Home
- tile first window to the left
- move second Home window
- close first Home window
- change second Home window to Downloads
- close Downloads window
- open Places -> Downloads
- open Places -> Home
- move Downloads to workspace 2
- tile Downloads to the right

### firefox

- launch firefox
- navigate to Wikipedia.org
- open second window
- navigate to Mozilla.org
- move first window to workspace 2
- tile first window to left
- tile second window to right
- firefox Menu -> Quit
- launch firefox
- open new tab in Mozilla window
- navigate to Google.com
- firefox Menu -> Quit
- launch firefox
