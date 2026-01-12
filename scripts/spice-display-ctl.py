#!/usr/bin/env python3
"""
SPICE Display Controller - Control VM display heads via SPICE protocol.

This script connects to a SPICE server and enables/disables display heads,
useful for testing monitor hotplug scenarios.

Requires: python3-spice-client-gtk (spice-gtk GObject introspection bindings)
"""

import argparse
import sys
import time

import gi
gi.require_version('SpiceClientGLib', '2.0')
from gi.repository import SpiceClientGLib, GLib, GObject


class SpiceDisplayController:
    """Controls SPICE display heads."""

    def __init__(self, uri: str = "spice://localhost:5900"):
        self.uri = uri
        self.session = None
        self.main_channel = None
        self.display_channels = {}  # channel_id -> SpiceDisplayChannel
        self.loop = None
        self.connected = False
        self.agent_connected = False
        self.error = None

    def _on_channel_new(self, session, channel):
        """Handle new channel creation."""
        if isinstance(channel, SpiceClientGLib.MainChannel):
            self.main_channel = channel
            # Use connect_after to avoid conflict with SpiceChannel.connect()
            channel.connect_after("channel-event", self._on_channel_event)
            channel.connect_after("main-agent-update", self._on_agent_update)
        elif isinstance(channel, SpiceClientGLib.DisplayChannel):
            channel_id = channel.get_property("channel-id")
            self.display_channels[channel_id] = channel
            # Connect the display channel to receive surface data
            channel.connect()

    def _on_channel_event(self, channel, event):
        """Handle channel events."""
        if event == SpiceClientGLib.ChannelEvent.OPENED:
            self.connected = True
            # Check if agent is already connected
            self.agent_connected = channel.get_property("agent-connected")
            if self.agent_connected and self.loop:
                # Agent already connected - wait for display channels then quit
                GLib.timeout_add(500, lambda: self.loop.quit() or False)
        elif event == SpiceClientGLib.ChannelEvent.ERROR_CONNECT:
            self.error = "Connection error"
            if self.loop:
                self.loop.quit()
        elif event == SpiceClientGLib.ChannelEvent.CLOSED:
            self.connected = False

    def _on_agent_update(self, channel):
        """Handle agent connection updates."""
        self.agent_connected = channel.get_property("agent-connected")
        if self.agent_connected and self.connected and self.loop:
            # Wait briefly for display channels to be enumerated
            GLib.timeout_add(500, lambda: self.loop.quit() or False)

    def do_connect(self, timeout: float = 5.0, wait_for_agent: bool = True) -> bool:
        """Connect to the SPICE server and optionally wait for agent."""
        self.session = SpiceClientGLib.Session(uri=self.uri)
        self.session.connect_after("channel-new", self._on_channel_new)

        self.loop = GLib.MainLoop()

        # Set up timeout
        def on_timeout():
            if not self.connected:
                self.error = "Connection timeout"
            elif wait_for_agent and not self.agent_connected:
                self.error = "Agent connection timeout (is spice-vdagent running in the VM?)"
            self.loop.quit()
            return False
        GLib.timeout_add(int(timeout * 1000), on_timeout)

        # For non-agent mode, quit shortly after connecting to allow channel enumeration
        def check_connected():
            if self.connected and not wait_for_agent:
                # Give a moment for display channels to be enumerated
                GLib.timeout_add(500, lambda: self.loop.quit() or False)
                return False
            return True  # Keep checking
        GLib.timeout_add(100, check_connected)

        # Start connection
        self.session.connect()

        # Run until connected (and agent ready if requested) or timeout
        self.loop.run()

        if self.error:
            print(f"Error: {self.error}", file=sys.stderr)
            return False

        if wait_for_agent and not self.agent_connected:
            print("Error: Agent not connected", file=sys.stderr)
            return False

        return self.connected

    def set_display_enabled(self, display_id: int, enabled: bool,
                            width: int = 1024, height: int = 768,
                            x: int = 0, y: int = 0) -> bool:
        """Enable or disable a specific display head."""
        if not self.main_channel:
            print("Error: Not connected to main channel", file=sys.stderr)
            return False

        if not self.agent_connected:
            print("Error: Agent not connected (required for display control)", file=sys.stderr)
            return False

        # Iterate over all known displays to sync their current state to MainChannel
        # This is crucial because MainChannel might not have the full current state,
        # and we must send a complete configuration for all monitors.
        for channel_id, channel in self.display_channels.items():
            # Determine state for this monitor
            if channel_id == display_id:
                # This is the target monitor - use requested values
                d_enabled = enabled
                d_width = width
                d_height = height
                d_x = x
                d_y = y
            else:
                # This is another monitor - preserve current state
                # Use properties from the DisplayChannel which reflect current guest state
                curr_width = channel.get_property("width")
                curr_height = channel.get_property("height")
                d_enabled = curr_width > 0 and curr_height > 0
                d_width = curr_width
                d_height = curr_height
                # We don't easily know the current X/Y from DisplayChannel alone as it's
                # a property of the unified desktop, but usually primary is 0,0.
                # For now, we assume simple layout or that MainChannel might have cached it.
                # WARNING: If we don't know X/Y, we might reset positions.
                # However, virt-viewer/spice-gtk often track this.
                # Let's assume a simple side-by-side if we can't determine it,
                # or just use 0,0 and hope the guest re-arranges if it overlaps?
                # Actually, simply not updating X/Y might be safer if we only update enable/disable?
                # No, update_display requires x, y.
                
                # Ideally we would query the current monitor config from the agent,
                # but that's complex.
                # For our test harness, we usually have:
                # Monitor 0: Enabled, 0,0
                # Monitor 1: The one we are toggling.
                
                # If we are toggling Monitor 1, we must ensure Monitor 0 stays at 0,0.
                if channel_id == 0:
                    d_x = 0
                    d_y = 0
                else:
                    # Best guess for others: place them to the right?
                    # This is a limitation of this simple script.
                    d_x = 0
                    d_y = 0
            
            # Apply update to MainChannel's internal state
            self.main_channel.update_display(channel_id, d_x, d_y, d_width, d_height, False)
            self.main_channel.update_display_enabled(channel_id, d_enabled, False)

        # Send monitor config immediately
        result = self.main_channel.send_monitor_config()
        if not result:
            print("Error: send_monitor_config failed", file=sys.stderr)
            return False

        # Run main loop briefly to ensure message is sent
        context = GLib.MainContext.default()
        for _ in range(10):
            context.iteration(False)
            time.sleep(0.05)

        return True

    def get_monitors(self) -> list:
        """Get list of monitors from all display channels."""
        all_monitors = []
        for channel_id, channel in sorted(self.display_channels.items()):
            # Use primary surface dimensions - more reliable than monitors array
            width = channel.get_property("width")
            height = channel.get_property("height")
            enabled = width > 0 and height > 0
            all_monitors.append({
                "channel": channel_id,
                "id": channel_id,  # Display ID typically matches channel ID
                "x": 0,
                "y": 0,
                "width": width,
                "height": height,
                "enabled": enabled,
            })
        return all_monitors

    def list_displays(self):
        """Print information about available displays."""
        print(f"Agent connected: {self.agent_connected}")
        print(f"Display channels: {len(self.display_channels)}")

        monitors = self.get_monitors()
        if not monitors:
            print("No monitors found")
            return

        print(f"\nMonitors ({len(monitors)}):")
        for mon in monitors:
            status = "enabled" if mon["enabled"] else "disabled"
            geom = f"{mon['width']}x{mon['height']}+{mon['x']}+{mon['y']}"
            print(f"  Display {mon['id']} (channel {mon['channel']}): {geom} [{status}]")

    def disconnect(self):
        """Disconnect from the SPICE server."""
        if self.session:
            self.session.disconnect()
            self.session = None
            self.main_channel = None
            self.connected = False


def main():
    parser = argparse.ArgumentParser(
        description="Control SPICE display heads for VM monitor hotplug testing"
    )
    parser.add_argument(
        "--uri", "-u",
        default="spice://localhost:5900",
        help="SPICE server URI (default: spice://localhost:5900)"
    )
    parser.add_argument(
        "--display", "-d",
        type=int,
        help="Display channel ID (0, 1, etc. - see --list output)"
    )
    parser.add_argument(
        "--enable", "-e",
        action="store_true",
        help="Enable the display"
    )
    parser.add_argument(
        "--disable", "-D",
        action="store_true",
        help="Disable the display"
    )
    parser.add_argument(
        "--list", "-l",
        action="store_true",
        help="List available displays"
    )
    parser.add_argument(
        "--timeout", "-t",
        type=float,
        default=5.0,
        help="Connection timeout in seconds (default: 5.0)"
    )
    parser.add_argument(
        "--width", "-W",
        type=int,
        default=1024,
        help="Display width when enabling (default: 1024)"
    )
    parser.add_argument(
        "--height", "-H",
        type=int,
        default=768,
        help="Display height when enabling (default: 768)"
    )

    args = parser.parse_args()

    # Validate arguments
    if args.list:
        # List mode - don't need display or enable/disable
        pass
    elif not args.enable and not args.disable:
        parser.error("Must specify --enable, --disable, or --list")
    elif args.enable and args.disable:
        parser.error("Cannot specify both --enable and --disable")
    elif args.display is None:
        parser.error("--display is required when using --enable or --disable")

    ctl = SpiceDisplayController(args.uri)

    # For --list, we don't need to wait for agent
    wait_for_agent = not args.list

    print(f"Connecting to {args.uri}{'...' if not wait_for_agent else ' (waiting for agent)...'}")
    if not ctl.do_connect(timeout=args.timeout, wait_for_agent=wait_for_agent):
        sys.exit(1)

    if args.list:
        ctl.list_displays()
        ctl.disconnect()
        sys.exit(0)

    enabled = args.enable
    if enabled:
        print(f"Agent connected. Enabling display {args.display} at {args.width}x{args.height}...")
    else:
        print(f"Agent connected. Disabling display {args.display}...")
    if not ctl.set_display_enabled(args.display, enabled, args.width, args.height):
        ctl.disconnect()
        sys.exit(1)

    print("Done.")
    ctl.disconnect()


if __name__ == "__main__":
    main()
