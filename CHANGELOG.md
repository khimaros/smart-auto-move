# CHANGELOG

## version 14

- skip tooltips non-tasklist windows

## version 13

- prevent duplicating saved windows when ignored

## version 12

- default to global match threshold when adding override
- fix creating individual window overrides

## version 11

- simplify override flow when default IGNORE
- remove confusing toggle button
- save windows even when ignored, just don't restore

## version 10

preferences ui improvements:

- add switch to show "occupied" state in saved window list
- allow switching to "DEFAULT" action for overrides
- add threshold override spin button for apps
- add an "IGNORE (ANY)" button to ignore entire window class

## version 9

testing and stability improvements

- fix prefs crash on empty query
- refactor modules to make testing easier
- add unit tests for window/override matching
- allow threshold overrides per-app (dconf only)

## version 8

- code review cleanup

## version 7

- initial GUI for editing preferences

## version 6

- allow/block list for windows (dconf only)

## version 5

- null signals on extension disable

## version 4

- add dconf settings for debug logging, startup day, sync frequeny, save frequency, and match threshold

## version 3

- extension review fixes

## version 2 (prerelease)

- switch to timeout rather than app/window signal driven synchronization
- improve reliability with slow starting apps like firefox
- persist window state to disk (dconf)
- remove dead code

## version 1 (prerelease)

- initial prototype
