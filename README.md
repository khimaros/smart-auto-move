# smart-auto-move

## overview

smart-auto-move is a Gnome Shell extension which keeps track of all application windows and restores them to the previous position, size, and workspace on restart.

## limitations

window locations are not currently persisted to disk. when the extension is restarted (eg. on logout), window positions will need to be retrained.

terminals which include the current directory in the title may not reach the match threshold when restarted if they do not preserve the working directory across restarts.

## behavior

because there is no way to uniquely distinguish individual windows from an application across restarts, smart-auto-move uses a heuristic to uniquely identify them. this is primarily based on startup order and title. in cases where there are multiple windows with the same title, they are restored based on relative startup sequence.

titles are matched using Levenstein distance. the match bonus for title is calculated based on `(title length - distance) / title length`.

## installation

smart-auto-move is currently under active development. when it is fully functional, it will be uploaded to https://extensions.gnome.org.

in the meantime, if you'd like to test, see [#development](#development).

## development

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

# manual tests

## calculator

- open calculator
- move calculator position
- resize calculator
- close calculator
- open calculator
- quickly close calculator
- open calculator

## files

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

## firefox

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