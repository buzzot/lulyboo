#!/usr/bin/env python3
"""Record an RFQ in the Lulyboo portal (one-way: this can only ADD a record, never read anything).

Usage:  python3 log_rfq.py rfq.json          (or:  cat rfq.json | python3 log_rfq.py -)
Reads the key from the environment variable LULYBOO_API_KEY and the site from LULYBOO_API_URL
(default https://lulyboo.space). Prints the portal's reply as JSON. Exit code 0 = recorded.
Only the Python standard library is used.
"""
import json, os, sys, urllib.request, urllib.error

def main():
    key = os.environ.get("LULYBOO_API_KEY", "").strip()
    base = os.environ.get("LULYBOO_API_URL", "https://lulyboo.space").rstrip("/")
    if not key:
        print(json.dumps({"ok": False, "error": "LULYBOO_API_KEY is not set"})); return 2
    src = sys.argv[1] if len(sys.argv) > 1 else "-"
    raw = sys.stdin.read() if src == "-" else open(src, encoding="utf-8").read()
    try:
        payload = json.loads(raw)
    except ValueError as e:
        print(json.dumps({"ok": False, "error": f"Input is not valid JSON: {e}"})); return 2
    req = urllib.request.Request(base + "/api/v1/rfq", data=json.dumps(payload).encode("utf-8"), method="POST",
                                 headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            print(r.read().decode("utf-8")); return 0
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        print(json.dumps({"ok": False, "status": e.code, "error": body[:500]})); return 1
    except Exception as e:  # network problems: safe to retry with the same external_id
        print(json.dumps({"ok": False, "error": f"Could not reach the portal: {e}"})); return 1

if __name__ == "__main__":
    sys.exit(main())
