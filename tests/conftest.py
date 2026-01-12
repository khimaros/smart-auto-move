"""
Pytest configuration and fixtures for smart-auto-move tests.

These tests are designed to run inside a VM with:
- GNOME Shell running with the smart-auto-move extension
- windowbot available at /srv/window-control/windowbot.py
- D-Bus session available

When tests fail, windows and processes are kept running so you can
manually inspect the state. Use `vm-test.sh wc-list` to see windows.
"""

import pytest
import subprocess
import time
import os
import sys

# Add parent directory for vmtest import
sys.path.insert(0, os.path.dirname(__file__))

from vmtest import WindowControlClient, ExtensionState, wait_for_settle


@pytest.hookimpl(tryfirst=True, hookwrapper=True)
def pytest_runtest_makereport(item, call):
    """Store test outcome on the item for use in fixtures."""
    outcome = yield
    rep = outcome.get_result()
    setattr(item, f"rep_{rep.when}", rep)


@pytest.fixture(scope="session")
def wc_client():
    """Provides a WindowControl D-Bus client for the test session."""
    return WindowControlClient()


@pytest.fixture(scope="session")
def ext_state():
    """Provides an ExtensionState manager for the test session."""
    return ExtensionState()


@pytest.fixture(autouse=True)
def clean_state(ext_state, wc_client, request):
    """Clean extension state before each test and close test windows after."""
    # Setup: Full cleanup as per TESTING.md

    # 1. Disable the extension
    ext_state.disable_extension()

    # 2. Reset the dconf settings entirely
    ext_state.reset_settings()

    # 3. Enable the extension
    ext_state.enable_extension()

    # Enable debug logging for easier troubleshooting
    ext_state.enable_debug_logging(True)

    yield

    # Skip cleanup on failure so user can inspect window state
    test_failed = hasattr(request.node, "rep_call") and request.node.rep_call.failed
    if test_failed:
        print("\n*** Test failed - keeping windows open for inspection ***")
        print("*** Use 'vm-test.sh wc-list' to see windows ***")
        return

    # Teardown: close any windowbot windows
    try:
        for win in wc_client.list_windows():
            details = wc_client.get_details(win['id'])
            # windowbot has wm_class "com.example.WindowBot"
            if 'WindowBot' in details.wm_class:
                wc_client.close(win['id'], force=True)
    except Exception:
        pass  # Ignore cleanup errors


@pytest.fixture
def windowbot_process(request):
    """Factory fixture to start windowbot processes."""
    processes = []

    def _start(config_name: str, timeout: float = 30.0):
        config_path = f"/srv/window-control/testdata/{config_name}"
        proc = subprocess.Popen(
            ["timeout", str(timeout), "python3", "/srv/window-control/windowbot.py", "-v", config_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        processes.append(proc)
        return proc

    yield _start

    # Skip cleanup on failure so user can inspect window state
    test_failed = hasattr(request.node, "rep_call") and request.node.rep_call.failed
    if test_failed:
        return  # Keep processes running

    # Cleanup: terminate any running processes
    for proc in processes:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()


