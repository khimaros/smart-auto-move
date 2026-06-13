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
import hashlib
import os
import sys

# Add parent directory for vmtest import
sys.path.insert(0, os.path.dirname(__file__))

from vmtest import (
    WindowControlClient, ExtensionState, HarnessError, check_environment,
    wait_for_settle,
)


@pytest.hookimpl(tryfirst=True, hookwrapper=True)
def pytest_runtest_makereport(item, call):
    """Store test outcome on the item for use in fixtures and dump journal on failure."""
    outcome = yield
    rep = outcome.get_result()
    setattr(item, f"rep_{rep.when}", rep)

    # label harness/environment failures distinctly so a broken display config
    # or missing instrument is never mistaken for a product regression
    if rep.failed and getattr(call, "excinfo", None) is not None:
        if isinstance(call.excinfo.value, HarnessError):
            rep.sections.append((
                "HARNESS/ENVIRONMENT PROBLEM",
                "this failure originated in the test harness or environment "
                "(e.g. monitor/display configuration), NOT a product code "
                "regression. fix the environment and re-run "
                "('scripts/vm-test.sh preflight' diagnoses it)."
            ))

    # dump GNOME Shell journal on test failure during the call phase
    if rep.when == "call" and rep.failed:
        try:
            result = subprocess.run(
                ["journalctl", "--user", "-b", "--no-pager", "--since", "-120s"],
                capture_output=True, text=True, timeout=5
            )
            lines = [
                line for line in result.stdout.strip().split('\n')
                if 'gnome-shell' in line.lower() or 'gjs' in line.lower()
            ]
            if lines:
                rep.sections.append((
                    "GNOME Shell journal (last 120s)",
                    '\n'.join(lines[-50:])
                ))
        except Exception:
            pass


SOURCE_DIR = "/srv/smart-auto-move"
INSTALL_DIR = os.path.expanduser(
    "~/.local/share/gnome-shell/extensions/smart-auto-move@khimaros.com"
)
# JS files whose content must match between source and installed extension
VERIFIED_FILES = [
    "extension.js",
    "common.js",
    "lib/state-matcher.js",
    "lib/state-session.js",
    "lib/gnome-shell.js",
    "lib/window-state.js",
    "lib/utils.js",
]


def _hash_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        h.update(f.read())
    return h.hexdigest()


@pytest.fixture(scope="session", autouse=True)
def verify_extension_installed():
    """Fail fast if installed extension JS doesn't match source."""
    mismatches = []
    for rel in VERIFIED_FILES:
        src = os.path.join(SOURCE_DIR, rel)
        inst = os.path.join(INSTALL_DIR, rel)
        if not os.path.exists(src):
            continue
        if not os.path.exists(inst):
            mismatches.append(f"{rel}: not installed")
            continue
        src_hash = _hash_file(src)
        inst_hash = _hash_file(inst)
        if src_hash != inst_hash:
            mismatches.append(f"{rel}: source={src_hash[:12]} installed={inst_hash[:12]}")
    if mismatches:
        pytest.fail(
            "installed extension does not match source:\n  "
            + "\n  ".join(mismatches)
            + "\nrun 'scripts/vm-test.sh install && scripts/vm-test.sh reboot' to fix"
        )


@pytest.fixture(scope="session", autouse=True)
def verify_environment(verify_extension_installed):
    """Fail the whole session fast if the environment (not the product) is
    broken, with an unmistakable label.

    Depends on verify_extension_installed so the hash check runs first. A
    broken VM display config previously surfaced minutes into the run as a
    cluster of failures indistinguishable from regressions; this gate turns
    that into an immediate, clearly-labeled session abort.
    """
    problems = check_environment()
    if problems:
        pytest.exit(
            "ENVIRONMENT NOT READY (harness/environment problem, not a code "
            "regression):\n  " + "\n  ".join(problems),
            returncode=3,
        )


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

    # 3. Restore the single-monitor baseline while disabled, so a prior
    # monitor test that failed mid-reconfiguration cannot leak its layout
    # into this test (the extension sees no spurious monitors-changed event).
    wc_client.ensure_single_monitor_baseline()

    # 4. Enable the extension
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

    def _start(config_name: str, timeout: float = 30.0, extra_args: list = None):
        config_path = f"/srv/window-control/testdata/{config_name}"
        cmd = ["timeout", str(timeout), "python3", "/srv/window-control/windowbot.py", "-v"]
        if extra_args:
            cmd.extend(extra_args)
        cmd.append(config_path)
        proc = subprocess.Popen(
            cmd,
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


