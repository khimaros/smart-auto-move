#!/bin/bash
# VM Test Runner for smart-auto-move extension
# Uses QEMU guest agent to run commands in the debian-testing VM

set -e

VM_NAME="${VM_NAME:-debian-testing}"
EXTENSION_UUID="smart-auto-move@khimaros.com"
WC_EXTENSION_UUID="window-control@khimaros.com"
VM_EXT_PATH="/srv/smart-auto-move/build/smart-auto-move@khimaros.com.shell-extension.zip"
VM_WC_EXT_PATH="/srv/window-control/build/window-control@khimaros.com.shell-extension.zip"
VM_WINDOWBOT="/srv/window-control/windowbot.py"
VM_TESTS_PATH="/srv/smart-auto-move/tests"
GSETTINGS_SCHEMA="org.gnome.shell.extensions.smart-auto-move"

# Timestamped logging
ts_log() {
    echo "[$(date '+%H:%M:%S.%3N')] $*"
}

# Run a command in the VM and return its output
# Usage: vm_exec <cmd> [args...]
vm_exec() {
    local cmd="$1"
    shift
    local args_json=""

    # Build args array
    if [ $# -gt 0 ]; then
        args_json='"arg":['
        local first=true
        for arg in "$@"; do
            if [ "$first" = true ]; then
                first=false
            else
                args_json+=','
            fi
            args_json+="\"$arg\""
        done
        args_json+='],'
    fi

    # Execute command
    local result
    result=$(virsh qemu-agent-command "$VM_NAME" \
        "{\"execute\":\"guest-exec\",\"arguments\":{\"path\":\"$cmd\",${args_json}\"capture-output\":true}}" 2>&1)

    local pid
    pid=$(echo "$result" | jq -r '.return.pid')

    if [ -z "$pid" ] || [ "$pid" = "null" ]; then
        echo "ERROR: Failed to execute command: $result" >&2
        return 1
    fi

    # Wait for completion and get output (with timeout)
    local timeout="${VM_EXEC_TIMEOUT:-30}"
    local elapsed=0

    while [ $elapsed -lt $timeout ]; do
        local status
        status=$(virsh qemu-agent-command "$VM_NAME" \
            "{\"execute\":\"guest-exec-status\",\"arguments\":{\"pid\":$pid}}" 2>&1)

        local exited
        exited=$(echo "$status" | jq -r '.return.exited')

        if [ "$exited" = "true" ]; then
            local exitcode
            exitcode=$(echo "$status" | jq -r '.return.exitcode')

            # Decode and print stdout
            local out_data
            out_data=$(echo "$status" | jq -r '.return."out-data" // empty')
            if [ -n "$out_data" ]; then
                echo "$out_data" | base64 -d
            fi

            # Decode and print stderr
            local err_data
            err_data=$(echo "$status" | jq -r '.return."err-data" // empty')
            if [ -n "$err_data" ]; then
                echo "$err_data" | base64 -d >&2
            fi

            return "$exitcode"
        fi

        sleep 1
        elapsed=$((elapsed + 1))
    done

    echo "ERROR: Command timed out after ${timeout}s" >&2
    return 1
}

# Run a shell command in the VM (uses /bin/sh -c)
vm_shell() {
    vm_exec /bin/sh -c "$1"
}

# Run a command as the logged-in user (assumes user 'debian' or set VM_USER)
vm_user_shell() {
    local user="${VM_USER:-debian}"
    local uid="${VM_UID:-1000}"
    local script_name="cmd_$$_$(date +%s%N).sh"
    local host_dir="$(dirname "$0")/../tmp"
    local host_script="$host_dir/$script_name"
    local vm_script="/srv/smart-auto-move/tmp/$script_name"

    # Ensure tmp directory exists
    mkdir -p "$host_dir"

    # Write script to shared virtiofs mount
    cat > "$host_script" <<EOF
#!/bin/sh
export XDG_RUNTIME_DIR=/run/user/$uid
export WAYLAND_DISPLAY=wayland-0
export DISPLAY=:0
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus
export XAUTHORITY=\$(ls /run/user/$uid/.mutter-Xwaylandauth.* 2>/dev/null | head -1)
$1
EOF
    chmod +x "$host_script"

    # Execute as user in VM, then clean up
    vm_shell "runuser -u $user -- $vm_script"
    local rc=$?
    rm -f "$host_script"
    return $rc
}

# Check VM is running
check_vm() {
    local state
    state=$(virsh domstate "$VM_NAME" 2>/dev/null)
    if [ "$state" != "running" ]; then
        echo "ERROR: VM '$VM_NAME' is not running (state: $state)" >&2
        return 1
    fi
    echo "VM '$VM_NAME' is running"
}

# Build extension on host
build_extension() {
    echo "Building extension..."
    make -C "$(dirname "$0")/.." clean build
}

# Install/reload extension in VM
install_extension() {
    echo "Installing smart-auto-move extension in VM..."

    # Disable first (ignore errors if not enabled)
    vm_user_shell "gnome-extensions disable $EXTENSION_UUID 2>/dev/null || true"

    # Install from shared folder
    vm_user_shell "gnome-extensions install --force $VM_EXT_PATH"

    # Enable
    vm_user_shell "gnome-extensions enable $EXTENSION_UUID"

    echo "Extension installed and enabled"
}

# Install window-control extension (provides D-Bus interface for tests)
install_window_control() {
    echo "Installing window-control extension in VM..."

    # Build window-control extension on host first
    if [ -d "$(dirname "$0")/../../window-control" ]; then
        echo "Building window-control extension..."
        make -C "$(dirname "$0")/../../window-control" clean build 2>/dev/null || true
    fi

    # Disable first (ignore errors if not enabled)
    vm_user_shell "gnome-extensions disable $WC_EXTENSION_UUID 2>/dev/null || true"

    # Install from shared folder
    vm_user_shell "gnome-extensions install --force $VM_WC_EXT_PATH"

    # Enable
    vm_user_shell "gnome-extensions enable $WC_EXTENSION_UUID"

    echo "window-control extension installed and enabled"
}

# Reboot VM and wait for it to come back
reboot_vm() {
    echo "Rebooting VM..."
    virsh reboot "$VM_NAME"

    echo "Waiting for VM to come back..."
    sleep 10

    local timeout=120
    local elapsed=0
    while [ $elapsed -lt $timeout ]; do
        # Check if guest agent responds
        if virsh qemu-agent-command "$VM_NAME" '{"execute":"guest-ping"}' >/dev/null 2>&1; then
            echo "VM is back, waiting for GNOME session..."
            sleep 5
            # Wait for GNOME shell to start
            if vm_shell "pgrep gnome-shell" >/dev/null 2>&1; then
                echo "GNOME session is ready"
                return 0
            fi
        fi
        sleep 5
        elapsed=$((elapsed + 5))
        echo "  waiting... ($elapsed/${timeout}s)"
    done

    echo "WARNING: VM didn't come back within ${timeout}s"
    return 1
}

# Logout GNOME session and wait for auto-login (faster than reboot)
logout_session() {
    echo "Logging out GNOME session..."
    vm_user_shell "gnome-session-quit --no-prompt --logout" 2>/dev/null || true

    echo "Waiting for auto-login..."
    sleep 5

    local timeout=60
    local elapsed=0
    while [ $elapsed -lt $timeout ]; do
        # Wait for GNOME shell to start
        if vm_shell "pgrep gnome-shell" >/dev/null 2>&1; then
            echo "GNOME session is ready"
            return 0
        fi
        sleep 2
        elapsed=$((elapsed + 2))
        echo "  waiting... ($elapsed/${timeout}s)"
    done

    echo "WARNING: GNOME session didn't start within ${timeout}s"
    return 1
}

# Run windowbot test
run_test() {
    local config="${1:-slowtitle.conf}"
    local config_path="/srv/window-control/testdata/$config"
    local timeout="${2:-30}"

    echo "Running windowbot test: $config (timeout: ${timeout}s)"
    echo "---"

    # Inline the windowbot runner
    vm_shell "runuser -u debian -- /bin/sh -c 'export XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 DISPLAY=:0 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus; timeout ${timeout} /usr/bin/python3 ${VM_WINDOWBOT} -v ${config_path} 2>&1 || true'"

    echo "---"
    echo "Test complete"
}

# Show extension logs
show_logs() {
    local since="${1:-5 minutes ago}"
    echo "Recent extension logs (since: $since):"
    vm_shell "runuser -u debian -- journalctl --user --since '$since' 2>/dev/null | grep gnome-shell"
}

# Install required packages in VM
bootstrap_vm() {
    echo "Bootstrapping VM for testing..."
    vm_shell "apt-get update && apt-get install -y python3-pytest python3-gi gir1.2-gtk-4.0"
    vm_shell "python3 -m pytest --version"
    vm_shell "ls -la /srv/smart-auto-move /srv/window-control 2>&1 | head -5 || echo 'Shared folders not mounted!'"
}

# Install both extensions
install_all() {
    build_extension
    install_extension
    install_window_control
    echo ""
    echo "Both extensions installed. Reboot VM for changes to take effect:"
    echo "  $0 reboot"
}

# Clear extension saved windows state
clear_state() {
    echo "Clearing extension state..."
    vm_user_shell "dconf reset /org/gnome/shell/extensions/smart-auto-move/saved-windows"
    echo "State cleared"
}

# D-Bus Window Control helpers
wc_list() {
    vm_user_shell "gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Extensions/WindowControl --method org.gnome.Shell.Extensions.WindowControl.List"
}

wc_all_details() {
    vm_user_shell "/srv/window-control/wcc dump"
}

# Run pytest test suite in VM
run_pytest() {
    local test_filter="${1:-}"
    local pytest_args="-v -s --tb=short -p no:cacheprovider"

    if [ -n "$test_filter" ]; then
        # Check if the filter is a file path, if so use it directly
        if [[ "$test_filter" == *.py ]]; then
            pytest_args="$pytest_args $test_filter"
        else
            pytest_args="$pytest_args -k $test_filter"
        fi
    fi

    # Ensure test files are readable
    chmod -R a+rX "$(dirname "$0")/../tests" 2>/dev/null || true

    echo "Running pytest tests in VM..."
    echo "Test path: $VM_TESTS_PATH"
    echo "Filter: ${test_filter:-none}"
    echo "---"

    # Use longer timeout (5 minutes) for test runs
    VM_EXEC_TIMEOUT=300 vm_user_shell "cd $VM_TESTS_PATH && python3 -m pytest $pytest_args . 2>&1" || {
        echo "---"
        echo "Some tests failed. Check output above."
        return 1
    }

    echo "---"
    echo "All tests passed!"
}

# Main
case "${1:-help}" in
    check)
        check_vm
        ;;
    build)
        build_extension
        ;;
    install)
        check_vm
        install_all
        ;;
    install-wc)
        check_vm
        install_window_control
        ;;
    install-all)
        check_vm
        install_all
        ;;
    reboot)
        reboot_vm
        ;;
    logout)
        check_vm
        logout_session
        ;;
    test)
        check_vm
        run_test "${2:-slowtitle.conf}"
        ;;
    logs)
        check_vm
        if [ -n "${2:-}" ]; then
            show_logs "$2"
        else
            show_logs
        fi
        ;;
    full)
        # Full test cycle with logout
        check_vm
        install_all
        logout_session
        sleep 5  # Give extension time to initialize after login
        if [ -n "$2" ]; then
            run_pytest "$2"
        else
            run_test "${2:-slowtitle.conf}"
        fi
        show_logs
        ;;
    shell)
        # Interactive shell command
        shift
        check_vm
        vm_shell "$*"
        ;;
    user-shell)
        # Run command as logged-in user with GNOME session environment
        shift
        check_vm
        vm_user_shell "$*"
        ;;
    pytest)
        # Run pytest tests
        check_vm
        run_pytest "${2:-}"
        ;;
    clear-state)
        check_vm
        clear_state
        ;;
    wc-list)
        check_vm
        wc_list
        ;;
    wc-details)
        check_vm
        wc_all_details
        ;;
    list-monitors)
        check_vm
        vm_user_shell "gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Extensions/WindowControl --method org.gnome.Shell.Extensions.WindowControl.GetAllMonitorDetails"
        ;;
    enable-monitor)
        check_vm
        vm_user_shell "gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Extensions/WindowControl --method org.gnome.Shell.Extensions.WindowControl.SetMonitorEnabled 1 true"
        ;;
    disable-monitor)
        check_vm
        vm_user_shell "gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Extensions/WindowControl --method org.gnome.Shell.Extensions.WindowControl.SetMonitorEnabled 1 false"
        ;;
    bootstrap)
        check_vm
        bootstrap_vm
        ;;
    *)
        echo "Usage: $0 <command> [args]"
        echo ""
        echo "Commands:"
        echo "  check         - Check if VM is running"
        echo "  bootstrap     - Install required packages in VM (run once)"
        echo "  build         - Build extension on host"
        echo "  install       - Build and install smart-auto-move in VM"
        echo "  install-wc    - Install window-control extension (D-Bus API for tests)"
        echo "  install-all   - Install both extensions"
        echo "  reboot        - Reboot VM and wait for GNOME session"
        echo "  logout        - Logout GNOME session and wait for auto-login (faster)"
        echo "  test [conf]   - Run windowbot test (default: slowtitle.conf)"
        echo "  logs [since]  - Show extension logs (default: '5 minutes ago')"
        echo "  full          - Full test cycle: build, install, logout, test, logs"
        echo "  shell <cmd>   - Run a shell command in VM (as root)"
        echo "  user-shell <cmd> - Run a shell command as user with GNOME session env"
        echo ""
        echo "Test Commands:"
        echo "  pytest [filter]   - Run pytest test suite in VM"
        echo "  clear-state       - Clear extension saved windows state"
        echo ""
        echo "Debug Commands:"
        echo "  wc-list         - List windows via D-Bus"
        echo "  wc-details      - Show details for all windows"
        echo "  list-monitors   - List monitors via D-Bus"
        echo "  enable-monitor  - Enable secondary monitor via D-Bus"
        echo "  disable-monitor - Disable secondary monitor via D-Bus"
        echo ""
        echo "Examples:"
        echo "  $0 full"
        echo "  $0 pytest                    # Run all tests"
        echo "  $0 pytest test_story_5_monitors.py"
        echo "  $0 test simple.conf"
        echo "  $0 shell 'gnome-extensions list'"
        ;;
esac
