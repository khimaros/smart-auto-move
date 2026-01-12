#!/usr/bin/env python3
"""
vmtest - Test library for smart-auto-move extension testing.

Uses gdbus and gsettings CLI tools (more reliable than Python GLib bindings
in VM/virtiofs environments where SIGTRAP issues can occur).
"""

import json
import os
import signal
import subprocess
import time
import re
from dataclasses import dataclass
from enum import Enum
from typing import Dict, List, Optional, Any

import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib


class TilePosition(Enum):
    """Window tiling positions."""
    LEFT = "left"
    RIGHT = "right"


DBUS_DEST = "org.gnome.Shell"
DBUS_PATH = "/org/gnome/Shell/Extensions/WindowControl"
DBUS_IFACE = "org.gnome.Shell.Extensions.WindowControl"

GSETTINGS_SCHEMA = "org.gnome.shell.extensions.smart-auto-move"

# Windowbot constants
WINDOWBOT_PATH = "/srv/window-control/windowbot.py"
WINDOWBOT_WM_CLASS = "com.example.WindowBot"
WINDOWBOT_TESTDATA = "/srv/window-control/testdata"

# Default screen geometry constants (used as fallback)
DEFAULT_SCREEN_WIDTH = 1280
DEFAULT_SCREEN_HEIGHT = 1024
TOP_BAR_HEIGHT = 32


@dataclass
class MonitorGeometry:
    """Represents monitor geometry from GNOME Shell."""
    index: int
    x: int
    y: int
    width: int
    height: int


# Cached monitor geometries (refreshed on demand)
_monitor_cache: Optional[List[MonitorGeometry]] = None


def _run_cmd(cmd: List[str], check: bool = True) -> str:
    """Run a command and return stdout."""
    result = subprocess.run(cmd, capture_output=True, text=True)
    if check and result.returncode != 0:
        raise RuntimeError(f"Command failed: {' '.join(cmd)}\nstderr: {result.stderr}")
    return result.stdout.strip()


def poll_until(predicate, timeout: float = 10.0, poll: float = 0.5, default=None):
    """Poll until predicate returns truthy value or timeout.

    Args:
        predicate: Callable that returns a value (truthy = success)
        timeout: Maximum time to wait in seconds
        poll: Poll interval in seconds
        default: Value to return if timeout reached

    Returns:
        Result of predicate if truthy, otherwise default
    """
    start = time.time()
    while time.time() - start < timeout:
        try:
            result = predicate()
            if result:
                return result
        except Exception:
            pass
        time.sleep(poll)
    return default


def _gdbus_call(method: str, *args) -> str:
    """Call a D-Bus method via gdbus."""
    cmd = [
        "gdbus", "call", "--session",
        "--dest", DBUS_DEST,
        "--object-path", DBUS_PATH,
        "--method", f"{DBUS_IFACE}.{method}",
        "--",  # Separates options from arguments (allows negative numbers)
    ]
    for arg in args:
        cmd.append(str(arg))
    return _run_cmd(cmd)


def _parse_gdbus_string(output: str) -> str:
    """Parse a string result from gdbus call like ('json...',) """
    # gdbus returns tuples like ('{"key": "value"}',)
    # Handle escaped quotes and newlines
    match = re.search(r"\('(.*)'\s*,?\s*\)$", output, re.DOTALL)
    if match:
        result = match.group(1)
        # Unescape
        result = result.replace("\'", "'")
        result = result.replace("\n", "\n")
        result = result.replace("\\", "\\")
        return result
    return output


def get_all_monitor_details(refresh: bool = False) -> List[MonitorGeometry]:
    """Get geometry for all monitors via D-Bus.

    Args:
        refresh: If True, force refresh of cached data.

    Returns:
        List of MonitorGeometry objects sorted by index.
    """
    global _monitor_cache

    if _monitor_cache is not None and not refresh:
        return _monitor_cache

    output = _gdbus_call("GetAllMonitorDetails")
    json_str = _parse_gdbus_string(output)
    monitors_data = json.loads(json_str)

    _monitor_cache = [
        MonitorGeometry(
            index=m['index'],
            x=m['x'],
            y=m['y'],
            width=m['width'],
            height=m['height'],
        )
        for m in sorted(monitors_data, key=lambda m: m['index'])
    ]
    return _monitor_cache


def get_monitor_geometry(monitor_index: int, refresh: bool = False) -> MonitorGeometry:
    """Get geometry for a specific monitor.

    Args:
        monitor_index: The monitor index (0, 1, etc.)
        refresh: If True, force refresh of cached data.

    Returns:
        MonitorGeometry for the specified monitor.

    Raises:
        ValueError: If monitor index is out of range.
    """
    monitors = get_all_monitor_details(refresh=refresh)
    for m in monitors:
        if m.index == monitor_index:
            return m
    raise ValueError(f"Monitor {monitor_index} not found (available: {[m.index for m in monitors]})")


def get_primary_monitor_index() -> int:
    """Get the index of the primary monitor using gdctl."""
    output = _run_cmd(["gdctl", "show"])
    lines = output.splitlines()
    in_logical_monitors = False
    monitor_index = -1

    for line in lines:
        if line.startswith("Logical monitors:"):
            in_logical_monitors = True
            continue

        if not in_logical_monitors:
            continue

        if "Logical monitor #" in line:
            monitor_index += 1

        if "Primary: yes" in line:
            return max(0, monitor_index)

    return 0


def clear_monitor_cache():
    """Clear the monitor geometry cache (call after monitor changes)."""
    global _monitor_cache
    _monitor_cache = None


def _dconf_reset(key: str):
    """Reset a dconf key."""
    _run_cmd(["dconf", "reset", f"/org/gnome/shell/extensions/smart-auto-move/{key}"])


def _dconf_read(key: str) -> str:
    """Read a dconf key."""
    return _run_cmd(["dconf", "read", f"/org/gnome/shell/extensions/smart-auto-move/{key}"], check=False)


def _dconf_write(key: str, value: str):
    """Write a dconf key."""
    _run_cmd(["dconf", "write", f"/org/gnome/shell/extensions/smart-auto-move/{key}", value])


@dataclass
class WindowDetails:
    """Represents window details from D-Bus GetDetails."""
    id: int
    wm_class: str
    title: str
    x: int
    y: int
    width: int
    height: int
    workspace: int
    monitor: int
    maximized: int
    fullscreen: bool

    @classmethod
    def from_dict(cls, data: Dict[str, Any], winid: int = 0) -> 'WindowDetails':
        # frame_rect is a nested object with x, y, width, height
        frame_rect = data.get('frame_rect', {})
        return cls(
            id=winid or data.get('id', 0),
            wm_class=data.get('wm_class', ''),
            title=data.get('title', ''),
            x=frame_rect.get('x', 0),
            y=frame_rect.get('y', 0),
            width=frame_rect.get('width', 0),
            height=frame_rect.get('height', 0),
            workspace=data.get('workspace', 0),
            monitor=data.get('monitor', 0),
            maximized=data.get('maximized', 0),
            fullscreen=data.get('fullscreen', False),
        )


class WindowControlClient:
    """D-Bus client for the WindowControl interface using gdbus CLI."""

    def list_windows(self) -> List[Dict[str, Any]]:
        """List all windows."""
        output = _gdbus_call("List")
        json_str = _parse_gdbus_string(output)
        return json.loads(json_str)

    def list_normal_windows(self) -> List[Dict[str, Any]]:
        """List only normal (non-modal, non-dialog) windows."""
        output = _gdbus_call("ListNormalWindows")
        json_str = _parse_gdbus_string(output)
        return json.loads(json_str)

    def get_details(self, winid: int) -> WindowDetails:
        """Get detailed information about a window."""
        output = _gdbus_call("GetDetails", winid)
        json_str = _parse_gdbus_string(output)
        data = json.loads(json_str)
        return WindowDetails.from_dict(data, winid)

    def place(self, winid: int, x: int, y: int, width: int, height: int):
        """Move and resize a window."""
        _gdbus_call("Place", winid, x, y, width, height)

    def move(self, winid: int, x: int, y: int):
        """Move a window without resizing."""
        _gdbus_call("Move", winid, x, y)

    def move_to_workspace(self, winid: int, workspace: int):
        """Move a window to a specific workspace."""
        _gdbus_call("MoveToWorkspace", winid, workspace)

    def move_to_monitor(self, winid: int, monitor: int):
        """Move a window to a specific monitor."""
        _gdbus_call("MoveToMonitor", winid, monitor)

    def maximize(self, winid: int, state: int = 3):
        """Maximize a window. state: 0=none, 1=horizontal, 2=vertical, 3=both."""
        _gdbus_call("Maximize", winid, state)

    def unmaximize(self, winid: int):
        """Unmaximize a window."""
        _gdbus_call("Unmaximize", winid)

    def minimize(self, winid: int):
        """Minimize a window."""
        _gdbus_call("Minimize", winid)

    def close(self, winid: int, force: bool = False):
        """Close a window."""
        _gdbus_call("Close", winid, "true" if force else "false")

    def set_fullscreen(self, winid: int, state: bool):
        """Set window fullscreen state."""
        _gdbus_call("SetFullscreen", winid, "true" if state else "false")

    def tile(self, winid: int, mode: int, monitor: int):
        """Tile window. mode: 0=none, 1=left, 2=right. monitor: -1 for current."""
        _gdbus_call("Tile", winid, mode, monitor)

    def get_physical_monitors(self) -> List[Dict[str, Any]]:
        """Get physical monitor mapping with stable indices sorted by connector name.

        Returns:
            List of dicts with physicalIndex, logicalIndex, connector, x, y, width, height
        """
        output = _gdbus_call("GetPhysicalMonitors")
        json_str = _parse_gdbus_string(output)
        return json.loads(json_str)

    def physical_to_logical(self, physical_index: int) -> int:
        """Convert physical monitor index to logical index.

        Args:
            physical_index: Stable physical index (0-based, sorted by connector name)

        Returns:
            GNOME's logical index, or -1 if invalid
        """
        output = _gdbus_call("PhysicalToLogical", physical_index)
        match = re.search(r'\((-?\d+),?\)', output)
        return int(match.group(1)) if match else -1

    def logical_to_physical(self, logical_index: int) -> int:
        """Convert logical monitor index to physical index.

        Args:
            logical_index: GNOME's internal logical index

        Returns:
            Stable physical index, or -1 if invalid
        """
        output = _gdbus_call("LogicalToPhysical", logical_index)
        match = re.search(r'\((-?\d+),?\)', output)
        return int(match.group(1)) if match else -1

    def get_connector_for_logical(self, logical_index: int) -> Optional[str]:
        """Get connector name for a logical monitor index."""
        monitors = self.get_physical_monitors()
        for m in monitors:
            if m.get('logicalIndex') == logical_index:
                return m.get('connector')
        return None

    def get_window_connector(self, win: WindowDetails) -> Optional[str]:
        """Get the connector name for a window's current monitor."""
        return self.get_connector_for_logical(win.monitor)

    def get_available_connectors(self) -> List[str]:
        """Get list of all available physical monitor connectors."""
        out = _run_cmd(["gdctl", "show"])
        connectors = re.findall(r"Monitor (\S+) \(", out)
        connectors.sort()
        return connectors

    def get_enabled_connectors(self) -> List[str]:
        """Get list of currently enabled (logical) monitor connectors.

        Uses GetPhysicalMonitors D-Bus call to get the list of monitors
        that are currently active in GNOME Shell.
        """
        monitors = self.get_physical_monitors()
        connectors = [m.get('connector') for m in monitors if m.get('connector')]
        return sorted(set(connectors))

    def set_monitors(self, connectors: List[str], primary: str = None):
        """
        Configure logical monitors with the specified connectors.

        Args:
            connectors: List of connector names to enable (e.g., ["Virtual-1", "Virtual-2"])
            primary: Which connector should be primary (defaults to first in list)

        Monitors are positioned side-by-side at y=0, each 1280 pixels wide.
        """
        if not connectors:
            raise ValueError("At least one connector must be specified")

        connectors = sorted(connectors)  # Ensure consistent ordering
        if primary is None:
            primary = connectors[0]

        cmd = ["gdctl", "set"]

        x_offset = 0
        for connector in connectors:
            is_primary = connector == primary
            cmd.extend(["--logical-monitor", "--monitor", connector])
            if is_primary:
                cmd.append("--primary")
            cmd.extend(["--x", str(x_offset), "--y", "0"])
            x_offset += 1280

        _run_cmd(cmd)

    def set_monitor_enabled(self, connector_or_index, enabled: bool):
        """
        Enable or disable a specific monitor by connector name or index.

        Args:
            connector_or_index: Either a connector name (e.g., "Virtual-2") or
                               an index (0, 1, 2) mapping to Virtual-1, Virtual-2, Virtual-3
            enabled: Whether to enable or disable this monitor
        """
        available = self.get_available_connectors()

        # Convert index to connector name if needed
        if isinstance(connector_or_index, int):
            if connector_or_index < 0 or connector_or_index >= len(available):
                raise ValueError(f"Monitor index {connector_or_index} out of range (0-{len(available)-1})")
            connector = available[connector_or_index]
        else:
            connector = connector_or_index
            if connector not in available:
                raise ValueError(f"Connector {connector} not found. Available: {available}")

        # Get currently enabled connectors
        current = set(self.get_enabled_connectors())

        # Ensure Virtual-1 is always included (it's the primary)
        if "Virtual-1" not in current:
            current.add("Virtual-1")

        if enabled:
            current.add(connector)
        else:
            # Don't allow disabling Virtual-1 (primary)
            if connector == "Virtual-1":
                raise ValueError("Cannot disable primary monitor (Virtual-1)")
            current.discard(connector)

        self.set_monitors(list(current), primary="Virtual-1")

    def get_primary_monitor_index(self) -> int:
        """Get the index of the primary monitor using gdctl."""
        return get_primary_monitor_index()

    def find_window_by_class(self, wm_class: str) -> Optional[WindowDetails]:
        """Find a window by WM_CLASS."""
        for win in self.list_windows():
            details = self.get_details(win['id'])
            if details.wm_class == wm_class:
                return details
        return None

    def find_window_by_title(self, title: str, partial: bool = False) -> Optional[WindowDetails]:
        """Find a window by title."""
        for win in self.list_windows():
            details = self.get_details(win['id'])
            if partial:
                if title in details.title:
                    return details
            else:
                if details.title == title:
                    return details
        return None

    def wait_for_window(self, wm_class: str = None, title: str = None,
                        timeout: float = 10.0, poll_interval: float = 0.5) -> Optional[WindowDetails]:
        """Wait for a window to appear."""
        if not wm_class and not title:
            raise ValueError("Must specify wm_class or title")

        def find():
            if wm_class:
                return self.find_window_by_class(wm_class)
            return self.find_window_by_title(title, partial=True)

        return poll_until(find, timeout=timeout, poll=poll_interval)


class ExtensionState:
    """Manages smart-auto-move extension state via dconf CLI."""

    def _read_json_setting(self, key: str) -> Dict[str, Any]:
        """Read a JSON setting from dconf.

        Args:
            key: The dconf key name

        Returns:
            Parsed JSON as dict, or empty dict on error
        """
        output = _dconf_read(key)
        if not output or output == "''":
            return {}
        try:
            return json.loads(output.strip("'"))
        except json.JSONDecodeError:
            return {}

    def clear_saved_windows(self):
        """Clear all saved window data."""
        _dconf_reset("saved-windows")

    def clear_overrides(self):
        """Clear all app overrides."""
        _dconf_reset("overrides")

    def clear_all(self):
        """Clear both saved windows and overrides, reloading extension to reset in-memory state."""
        self.disable_extension()
        self.clear_saved_windows()
        self.clear_overrides()
        self.enable_extension()

    def get_saved_windows(self) -> Dict[str, Any]:
        """Get current saved windows state."""
        return self._read_json_setting("saved-windows")

    def get_overrides(self) -> Dict[str, Any]:
        """Get current app overrides."""
        return self._read_json_setting("overrides")

    def set_override(self, wm_class: str, action: str = "RESTORE", **kwargs):
        """Set an override for an app.

        Args:
            wm_class: The WM_CLASS to match
            action: 'RESTORE' or 'IGNORE'
            **kwargs: Optional threshold, match_properties, title
        """
        overrides = self.get_overrides()
        # Extension expects 'action' key, can be object or array of rules
        overrides[wm_class] = {"action": action, **kwargs}
        # dconf needs the value in GVariant format: 'json-string'
        json_str = json.dumps(overrides)
        _dconf_write("overrides", f"'{json_str}'")

    def remove_override(self, wm_class: str):
        """Remove an override for an app."""
        overrides = self.get_overrides()
        if wm_class in overrides:
            del overrides[wm_class]
            json_str = json.dumps(overrides)
            _dconf_write("overrides", f"'{json_str}'")

    def get_sync_mode(self) -> str:
        """Get the default sync mode."""
        output = _dconf_read("sync-mode")
        return output.strip("'") if output else "RESTORE"

    def set_sync_mode(self, mode: str):
        """Set the default sync mode. 'RESTORE' or 'IGNORE'."""
        _dconf_write("sync-mode", f"'{mode}'")

    def enable_debug_logging(self, enable: bool = True):
        """Enable or disable debug logging."""
        _dconf_write("debug-logging", "true" if enable else "false")

    def disable_extension(self, uuid: str = "smart-auto-move@khimaros.com"):
        """Disable the extension."""
        _run_cmd(["gnome-extensions", "disable", uuid], check=False)

    def enable_extension(self, uuid: str = "smart-auto-move@khimaros.com"):
        """Enable the extension."""
        _run_cmd(["gnome-extensions", "enable", uuid])

    def reload_extension(self, uuid: str = "smart-auto-move@khimaros.com"):
        """Reload the extension to reset internal state."""
        self.disable_extension(uuid)
        self.enable_extension(uuid)

    def reset_settings(self):
        """Reset all extension settings (dconf tree)."""
        _run_cmd(["dconf", "reset", "-f", "/org/gnome/shell/extensions/smart-auto-move/"])


def start_windowbot(config_path: str = None, verbose: bool = True) -> int:
    """Start windowbot and return its PID.

    Args:
        config_path: Full path to config file, or just filename (looked up in testdata)
        verbose: Enable verbose output

    Returns:
        Process ID of the started windowbot
    """
    if config_path is None:
        config_path = f"{WINDOWBOT_TESTDATA}/single.conf"
    elif not config_path.startswith("/"):
        config_path = f"{WINDOWBOT_TESTDATA}/{config_path}"

    cmd = ["python3", WINDOWBOT_PATH]
    if verbose:
        cmd.append("-v")
    cmd.append(config_path)

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return proc.pid


def kill_windowbot(pid: int, wait_time: float = 1.0):
    """Kill a windowbot process by PID.

    Args:
        pid: Process ID to kill
        wait_time: Time to wait after sending SIGTERM
    """
    try:
        os.kill(pid, signal.SIGTERM)
        time.sleep(wait_time)
    except ProcessLookupError:
        pass  # Process already exited


def terminate_process(proc: subprocess.Popen, timeout: float = 5.0):
    """Safely terminate a subprocess.

    Args:
        proc: The subprocess.Popen instance to terminate
        timeout: Time to wait for graceful termination before killing
    """
    proc.terminate()
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
    time.sleep(1.0)


def find_windowbot_window(client: 'WindowControlClient', timeout: float = 10.0) -> Optional[WindowDetails]:
    """Find the windowbot window.

    Args:
        client: WindowControlClient instance
        timeout: Max time to wait for window

    Returns:
        WindowDetails if found, None otherwise
    """
    return client.wait_for_window(wm_class=WINDOWBOT_WM_CLASS, timeout=timeout)


def dump_window_details(client: 'WindowControlClient', win_id: int, label: str = ""):
    """Dump full window details for debugging.

    Args:
        client: WindowControlClient instance
        win_id: Window ID to dump
        label: Optional label for the dump
    """
    from datetime import datetime
    ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    details = client.get_details(win_id)
    monitors = get_all_monitor_details(refresh=True)

    print(f"[{ts}] === WINDOW DUMP{': ' + label if label else ''} ===")
    print(f"[{ts}]   window id: {details.id}")
    print(f"[{ts}]   wm_class: {details.wm_class}")
    print(f"[{ts}]   position: ({details.x}, {details.y})")
    print(f"[{ts}]   size: {details.width}x{details.height}")
    print(f"[{ts}]   monitor: {details.monitor}")
    print(f"[{ts}]   workspace: {details.workspace}")

    # Determine which monitor the position is actually within
    actual_monitor = None
    for mon in monitors:
        if (
            mon.x <= details.x < mon.x + mon.width and
            mon.y <= details.y < mon.y + mon.height
        ):
            actual_monitor = mon.index
            break

    print(f"[{ts}]   position-in-monitor: {actual_monitor} (based on x,y)")
    print(f"[{ts}]   monitors: {[(m.index, m.x, m.y, m.width, m.height) for m in monitors]}")

    # Check tiling status
    if details.monitor < len(monitors):
        mon = monitors[details.monitor]
        half_width = mon.width // 2
        rel_x = details.x - mon.x
        rel_y = details.y - mon.y
        print(f"[{ts}]   relative-to-monitor-{mon.index}: ({rel_x}, {rel_y})")

        if rel_x == 0 and details.width == half_width:
            print(f"[{ts}]   tiling: LEFT on monitor {mon.index}")
        elif rel_x == half_width and details.width == half_width:
            print(f"[{ts}]   tiling: RIGHT on monitor {mon.index}")
        else:
            print(f"[{ts}]   tiling: NONE (not half-width tiled)")

    return details


def wait_for_settle(seconds: float = 2.0):
    """Wait for the extension to settle after window operations."""
    time.sleep(seconds)


def wait_for_valid_geometry(client: 'WindowControlClient', win_id: int, timeout: float = 5.0) -> bool:
    """Wait until window has valid geometry (width > 1 and height > 1)."""
    def check():
        details = client.get_details(win_id)
        return details.width > 1 and details.height > 1

    return poll_until(check, timeout=timeout, poll=0.2, default=False)


def launch_app(client: 'WindowControlClient', command: List[str], wm_class: str,
               timeout: float = 15.0) -> tuple:
    """Launch an app and wait for its window.

    Args:
        client: WindowControlClient instance
        command: Command to run (e.g., ["gnome-calculator"])
        wm_class: WM_CLASS to wait for
        timeout: How long to wait for window

    Returns:
        Tuple of (WindowDetails, subprocess.Popen)

    Raises:
        AssertionError if window doesn't appear
    """
    proc = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    win = client.wait_for_window(wm_class=wm_class, timeout=timeout)
    assert win is not None, f"Failed to create window for {wm_class}"
    wait_for_valid_geometry(client, win.id)
    return win, proc


def place_and_settle(client: 'WindowControlClient', winid: int, x: int, y: int,
                     width: int, height: int, settle_time: float = 2.0,
                     monitor: int = None) -> 'WindowDetails':
    """Place a window and wait for it to settle.

    Args:
        client: WindowControlClient instance
        winid: Window ID
        x, y: Target position relative to target monitor's origin
        width, height: Target size
        settle_time: How long to wait after placement
        monitor: Target monitor index. If None, uses window's current monitor.

    Returns:
        WindowDetails after settling
    """
    # Use window's current monitor if not specified
    if monitor is None:
        details = client.get_details(winid)
        monitor = details.monitor

    # Convert relative coordinates to absolute
    mon_geom = get_monitor_geometry(monitor, refresh=True)
    abs_x = mon_geom.x + x
    abs_y = mon_geom.y + y

    client.place(winid, abs_x, abs_y, width, height)
    time.sleep(0.5)
    client.move(winid, abs_x, abs_y)
    wait_for_settle(settle_time)
    return client.get_details(winid)


def close_app(client: 'WindowControlClient', winid: int, proc: subprocess.Popen,
              wait_time: float = 1.0):
    """Close a window and terminate its process.

    Args:
        client: WindowControlClient instance
        winid: Window ID to close
        proc: Process to terminate
        wait_time: How long to wait after closing
    """
    client.close(winid, force=True)
    proc.terminate()
    time.sleep(wait_time)


def reset_app_state(dconf_path: str):
    """Reset an app's dconf state to prevent self-restore.

    Args:
        dconf_path: The dconf path to reset (e.g., "/org/gnome/calculator/")
    """
    subprocess.run(["dconf", "reset", "-f", dconf_path], check=False)


def tile_window(client: 'WindowControlClient', winid: int, position: TilePosition,
                monitor: int = -1):
    """Tile a window to the specified position using the extension's Tile method.

    Args:
        client: WindowControlClient instance
        winid: Window ID
        position: TilePosition.LEFT or TilePosition.RIGHT
        monitor: Target monitor index. Use -1 (default) to tile on current monitor.
    """
    mode = 1 if position == TilePosition.LEFT else 2 if position == TilePosition.RIGHT else 0
    client.tile(winid, mode, monitor)


def tile_left(client: 'WindowControlClient', winid: int):
    """Tile a window to the left half of the screen."""
    tile_window(client, winid, TilePosition.LEFT)


def tile_right(client: 'WindowControlClient', winid: int):
    """Tile a window to the right half of the screen."""
    tile_window(client, winid, TilePosition.RIGHT)


def move_to_monitor_and_tile(client: 'WindowControlClient', winid: int,
                              monitor: int, position: TilePosition,
                              settle_time: float = 2.0):
    """Move a window to a monitor and tile it.

    Args:
        client: WindowControlClient instance
        winid: Window ID
        monitor: Target monitor index
        position: TilePosition.LEFT or TilePosition.RIGHT
        settle_time: Time to wait after tiling
    """
    client.move_to_monitor(winid, monitor)
    wait_for_settle(1.0)
    tile_window(client, winid, position, monitor)
    wait_for_settle(settle_time)


def wait_for_details(client: 'WindowControlClient', winid: int, expected: 'WindowDetails',
                     timeout: float = 5.0, poll_interval: float = 0.5) -> 'WindowDetails':
    """Wait for window details to match expected values.

    Args:
        client: WindowControlClient instance
        winid: Window ID
        expected: WindowDetails with expected values
        timeout: Max time to wait
        poll_interval: Poll interval

    Returns:
        WindowDetails (may not match if timeout reached)
    """
    def check():
        d = client.get_details(winid)
        if (
            d.x == expected.x and d.y == expected.y and
            d.width == expected.width and d.height == expected.height and
            d.workspace == expected.workspace and d.monitor == expected.monitor
        ):
            return d
        return None

    result = poll_until(check, timeout=timeout, poll=poll_interval)
    return result if result else client.get_details(winid)


class PositionAssertion:
    """Helper for asserting window positions with exact match."""

    @staticmethod
    def assert_position(details: WindowDetails, expected_x: int, expected_y: int,
                       expected_width: int = None, expected_height: int = None):
        """Assert window is at exact expected position."""
        errors = []

        if details.x != expected_x:
            errors.append(f"x: expected {expected_x}, got {details.x}")
        if details.y != expected_y:
            errors.append(f"y: expected {expected_y}, got {details.y}")
        if expected_width is not None and details.width != expected_width:
            errors.append(f"width: expected {expected_width}, got {details.width}")
        if expected_height is not None and details.height != expected_height:
            errors.append(f"height: expected {expected_height}, got {details.height}")

        if errors:
            raise AssertionError(f"Position mismatch for window {details.id}: {', '.join(errors)}")

    @staticmethod
    def assert_monitor(details: WindowDetails, expected_monitor: int):
        """Assert window is on expected monitor."""
        if details.monitor != expected_monitor:
            raise AssertionError(
                f"Monitor mismatch for window {details.id}: "
                f"expected {expected_monitor}, got {details.monitor}"
            )

    @staticmethod
    def assert_workspace(details: WindowDetails, expected_workspace: int):
        """Assert window is on expected workspace."""
        if details.workspace != expected_workspace:
            raise AssertionError(
                f"Workspace mismatch for window {details.id}: "
                f"expected {expected_workspace}, got {details.workspace}"
            )

    @staticmethod
    def assert_maximized(details: WindowDetails, expected_state: int):
        """Assert window maximized state."""
        if details.maximized != expected_state:
            raise AssertionError(
                f"Maximized mismatch for window {details.id}: "
                f"expected {expected_state}, got {details.maximized}"
            )

    @staticmethod
    def assert_details(details: WindowDetails, expected: WindowDetails):
        """Assert all window details match expected values."""
        errors = []
        if details.x != expected.x:
            errors.append(f"x: expected {expected.x}, got {details.x}")
        if details.y != expected.y:
            errors.append(f"y: expected {expected.y}, got {details.y}")
        if details.width != expected.width:
            errors.append(f"width: expected {expected.width}, got {details.width}")
        if details.height != expected.height:
            errors.append(f"height: expected {expected.height}, got {details.height}")
        if details.workspace != expected.workspace:
            errors.append(f"workspace: expected {expected.workspace}, got {details.workspace}")
        if details.monitor != expected.monitor:
            errors.append(f"monitor: expected {expected.monitor}, got {details.monitor}")
        if details.maximized != expected.maximized:
            errors.append(f"maximized: expected {expected.maximized}, got {details.maximized}")
        if details.fullscreen != expected.fullscreen:
            errors.append(f"fullscreen: expected {expected.fullscreen}, got {details.fullscreen}")

        if errors:
            raise AssertionError(f"Details mismatch for window {details.id}: {', '.join(errors)}")

    @staticmethod
    def assert_tiled(details: WindowDetails, position: 'TilePosition',
                     monitor: int = None):
        """Assert window is tiled at the specified position using actual monitor geometry.

        Args:
            details: WindowDetails to check
            position: TilePosition.LEFT or TilePosition.RIGHT
            monitor: Expected monitor (optional, checked if provided)
        """
        errors = []

        # Check monitor if specified
        if monitor is not None and details.monitor != monitor:
            errors.append(f"monitor: expected {monitor}, got {details.monitor}")

        # Get actual monitor geometry
        try:
            mon_geom = get_monitor_geometry(monitor if monitor is not None else details.monitor)
        except ValueError:
            # Fallback to defaults if monitor geometry unavailable
            mon_geom = MonitorGeometry(
                index=monitor if monitor is not None else 0,
                x=0,
                y=0,
                width=DEFAULT_SCREEN_WIDTH,
                height=DEFAULT_SCREEN_HEIGHT,
            )

        half_width = mon_geom.width // 2

        # Calculate expected x position based on tile position and monitor geometry
        if position == TilePosition.LEFT:
            expected_x = mon_geom.x
        elif position == TilePosition.RIGHT:
            expected_x = mon_geom.x + half_width
        else:
            raise ValueError(f"Unknown tile position: {position}")

        if details.x != expected_x:
            errors.append(f"x (absolute): expected {expected_x}, got {details.x}")

        # Determine effective monitor index
        eff_monitor = monitor if monitor is not None else details.monitor

        # Check y position - only the primary monitor has the top bar
        primary = get_primary_monitor_index()
        y_offset = TOP_BAR_HEIGHT if eff_monitor == primary else 0
        expected_y = mon_geom.y + y_offset
        if details.y != expected_y:
            errors.append(f"y: expected {expected_y}, got {details.y}")

        # Check dimensions
        # Primary monitor has top bar, secondary typically does not (in this test env)
        usable_height = mon_geom.height - y_offset
        if details.width != half_width:
            errors.append(f"width: expected {half_width}, got {details.width}")
        if details.height != usable_height:
            errors.append(f"height: expected {usable_height}, got {details.height}")

        if errors:
            raise AssertionError(
                f"Window {details.id} not tiled {position.value}: {', '.join(errors)}"
            )


if __name__ == "__main__":
    # Quick test
    print("Testing vmtest library...")

    client = WindowControlClient()
    windows = client.list_windows()
    print(f"Found {len(windows)} windows")

    for win in windows[:3]:
        details = client.get_details(win['id'])
        title = details.title[:40] if details.title else "(no title)"
        print(f"  {details.id}: {details.wm_class} - {title}... @ ({details.x}, {details.y})")

    state = ExtensionState()
    print(f"\nSync mode: {state.get_sync_mode()}")
    print(f"Overrides: {state.get_overrides()}")