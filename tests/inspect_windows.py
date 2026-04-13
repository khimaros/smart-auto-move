#!/usr/bin/env python3
"""Dump all window details including window_type."""
import sys, json
sys.path.insert(0, '.')
from vmtest import WindowControlClient, _gdbus_call, _parse_gdbus_string

wc = WindowControlClient()
for w in wc.list_windows():
    raw = _gdbus_call("GetDetails", w["id"])
    full = json.loads(_parse_gdbus_string(raw))
    wt = full.get("window_type", "?")
    wc_name = full.get("wm_class", "?")
    title = full.get("title", "?")[:60]
    print(f"id={w['id']}  type={wt}  wm_class={wc_name}  title={title}")
