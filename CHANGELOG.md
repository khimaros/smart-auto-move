# CHANGELOG

## version 36

### New Features

- huge refactor to use event driven rather than timeout driven tracking
- fixed issues with windows which change their titles after startup
- better handling of multi-monitor
- track last seen and first seen times for each window
- automatic cleanup of old/unseen saved windows
- "Choose Window" button implemented

### Breaking Changes

**⚠️ IMPORTANT: Automatic Migration from v35**

When upgrading from v35 or earlier, the extension will automatically:
- **Clear all saved window positions** - The internal data structure has changed significantly and cannot be automatically converted
- **Preserve your overrides** - Window and application overrides (IGNORE/RESTORE rules and thresholds) will be migrated automatically
- **Preserve all settings** - Global preferences like sync mode, match threshold, and ignore options are maintained

Your saved windows will be re-learned as you use applications after the upgrade. If you had many windows configured, you may want to open and position them again to rebuild the saved state.

**Data Structure Changes:**
- Internal saved windows format completely redesigned for the new event-driven architecture
- New `config-version` setting added to track data format versions for future migrations
- Configuration timing parameters changed from `startup-delay`/`sync-frequency`/`save-frequency` to new event-driven parameters

## version 35

- persist the "Ignore Monitor" setting
- DRY the code around setting management and signals
- add "Startup Delay" setting

## version 34

- fix a crash when adjusting override threshold

## version 33

- prepare for internationalization
- add search/filter for saved windows
- add "Ignore Monitor" preference
- "Add Application" implemented
- cleanup old GTK3 UI files

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
