// common.js unit tests, run on host or guest with: gjs -m tests/common_test.js
//
// covers parseOverrides normalization: the prefs dialog and the matcher both
// expect each override value to be an array of rules, but values may be stored
// as a single rule object (legacy/convenience form, as written by the test
// harness and by hand-edited dconf). a non-array value crashed the prefs
// dialog at `wshos.forEach is not a function`.

import { parseOverrides } from '../common.js'

let failures = 0

function check(label, condition, detail = '') {
    if (condition) {
        console.log(`PASS: ${label}`)
    } else {
        failures++
        console.log(`FAIL: ${label}${detail ? ' -- ' + detail : ''}`)
    }
}

// every value must be an array so prefs.js `overrides[wsh].forEach` is safe
{
    const parsed = parseOverrides('{"firefox": {"action": "RESTORE"}}')
    check('single object value is normalized to an array',
        Array.isArray(parsed.firefox) && parsed.firefox.length === 1 &&
        parsed.firefox[0].action === 'RESTORE',
        JSON.stringify(parsed))
}

// array values are preserved unchanged
{
    const parsed = parseOverrides(
        '{"firefox": [{"title": "Choose Profile", "action": "IGNORE"}, {"action": "RESTORE"}]}')
    check('array value is preserved',
        Array.isArray(parsed.firefox) && parsed.firefox.length === 2 &&
        parsed.firefox[1].action === 'RESTORE',
        JSON.stringify(parsed))
}

// mixed object and array values across apps
{
    const parsed = parseOverrides(
        '{"a": {"action": "IGNORE"}, "b": [{"action": "RESTORE"}]}')
    check('mixed forms both normalize to arrays',
        Array.isArray(parsed.a) && Array.isArray(parsed.b))
}

// the exact prefs.js load pattern must not throw for any value form
{
    const parsed = parseOverrides('{"a": {"action": "IGNORE"}, "b": [{"action": "RESTORE"}]}')
    let threw = false
    try {
        Object.keys(parsed).forEach((wsh) => {
            parsed[wsh].forEach((o) => void o.action)
        })
    } catch (e) {
        threw = true
    }
    check('prefs loadOverridesSetting iteration does not throw', !threw)
}

// malformed and empty input degrade to an empty object
{
    check('invalid JSON returns empty object',
        Object.keys(parseOverrides('not json')).length === 0)
    check('empty string returns empty object',
        Object.keys(parseOverrides('')).length === 0)
    check('undefined returns empty object',
        Object.keys(parseOverrides(undefined)).length === 0)
}

if (failures > 0) {
    console.log(`${failures} check(s) failed`)
    imports.system.exit(1)
}
console.log('all checks passed')
