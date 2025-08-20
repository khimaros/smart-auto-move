// Window state constants and utility functions

// Window state constants
export const MAXIMIZED_NONE = 0
export const MAXIMIZED_HORIZONTAL = 1
export const MAXIMIZED_VERTICAL = 2
export const MAXIMIZED_BOTH = 3

// Window property extraction configuration
export const EXTRACTION_PROPS = {
    // Direct properties to extract from MetaWindow
    direct: [
        'id',
        'title',
        'wm_class',
        'wm_class_instance',
        'gtk_application_id',
        'sandboxed_app_id',
        'minimized',
    ],
    // Getter methods that return simple values
    getters: [
        'display',
        'monitor',
        'frame_rect',
        'buffer_rect',
    ],
    // Boolean check methods
    booleans: [
        'can_move',
        'can_resize',
        'can_maximize',
        'can_minimize',
        'can_close',
        'allows_move',
        'allows_resize',
    ],
}

/**
 * Check if window geometry is valid (fully initialized)
 * @param {Object} frameRect - Frame rectangle with x, y, width, height
 * @returns {boolean} True if geometry is valid
 */
export function isValidGeometry(frameRect) {
    return frameRect && frameRect.width > 0 && frameRect.height > 0
}

/**
 * Check if a window should be tracked based on its properties
 * @param {Object} details - Window details object
 * @returns {boolean} True if window should be tracked
 */
export function shouldTrackWindow(details) {
    // Must have wm_class
    if (!details.wm_class) {
        return false
    }

    // Check if window CAN move/resize (inherent capability, not current state)
    // Note: allows_move/allows_resize are false when maximized/fullscreen, but
    // can_move/can_resize reflect the window's inherent capabilities
    if (details.can_move !== undefined && !details.can_move) {
        return false
    }
    if (details.can_resize !== undefined && !details.can_resize) {
        return false
    }

    // Must be normal window type (0) or undefined (assume normal)
    if (details.window_type !== undefined && details.window_type !== 0) {
        return false
    }

    // Must have valid geometry if frame_rect is present
    if (details.frame_rect && !isValidGeometry(details.frame_rect)) {
        return false
    }

    return true
}

/**
 * Check if a window is a "normal" user-facing window
 * @param {Object} details - Window details object
 * @returns {boolean} True if window is normal
 */
export function isNormalWindow(details) {
    // Must have title and wm_class
    if (!details.title || !details.wm_class) {
        return false
    }

    // Must not skip taskbar
    if (details.skip_taskbar) {
        return false
    }

    // Must be normal window type
    if (details.window_type !== undefined && details.window_type !== 0) {
        return false
    }

    return true
}

// Events that should be processed immediately (not debounced)
const IMMEDIATE_EVENTS = new Set(['notify::title', 'destroy'])

/**
 * Determine if an event type should be debounced
 * @param {string} eventType - The event type (e.g., 'notify::title', 'size-changed')
 * @returns {boolean} True if the event should be debounced
 */
export const shouldDebounceEvent = (eventType) => !IMMEDIATE_EVENTS.has(eventType)
