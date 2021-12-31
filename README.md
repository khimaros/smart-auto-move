# smart-auto-move

## overview

smart-auto-move is a Gnome Shell extension which keeps track of all application windows and restores them to the previous position, size, and workspace on restart.
 
## limitations

window locations are not currently persisted to disk. when the extension is restarted (eg. on logout), window positions will need to be retrained.

there is a fixed delay of 2000ms between when a window is created and when smart-auto-move restores its position. this is due to a limitation of the `windows-changed` signal. changing a window's frame rect inside of this handler does not actually move the window, so it instead needs to happen in the Mainloop.

if a window's title changes even slightly across restart, the window will be forgotten. this is especially problematic for eg. GMail tabs where the unread count changes the title of the window.

if you have multiple windows with the same title, they will restore to the same exact location rather than using startup sequence as a secondary hint. this is problematic for eg. terminal windows which often start with the same title.

## future improvements

because there is no way to uniquely distinguish individual windows from an application across restarts, smart-auto-move needs a heuristic to uniquely identify them. this should be based on startup order and title. in cases where there are multiple windows with the same title, they should be restored based on relative startup sequence.

rather than using a fixed delay before restoring a window, it may be possible to poll the window's frame rect to determine if it is ready to be moved. this may be as simple as checking if the rect is currently set to all `0` values.

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
