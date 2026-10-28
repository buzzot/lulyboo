#!/usr/bin/env python3
"""Record an RFQ in the Lulyboo portal (one-way: this can only ADD a record, never read anything).

Usage:  python3 log_rfq.py rfq.json          (or:  cat rfq.json | python3 log_rfq.py -)
Reads the key from the environment variable LULYBOO_API_KEY and the site from LULYBOO_API_URL
(default https://lulyboo.space). Prints the portal's reply as JSON. Exit code 0 = recorded.
Only the Python standard library is used.
"""
import json, os, sys, urllib.request, urllib.error

def from_env_file(name):
    """If the variable was not passed to this process, read ONLY that one line from ~/.hermes/.env
    (or $HERMES_HOME/.env). Nothing else in the file is read or printed."""
    home = os.environ.get("HERMES_HOME") or os.path.join(os.path.expanduser("~"), ".hermes")
    try:
        with open(os.path.join(home, ".env"), encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("export "):
                    line = line[7:].strip()
                if line.startswith(name + "="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""

def main():
    key = os.environ.get("LULYBOO_API_KEY", "").strip() or from_env_file("LULYBOO_API_KEY")
    base = (os.environ.get("LULYBOO_API_URL", "").strip() or from_env_file("LULYBOO_API_URL") or "https://lulyboo.space").rstrip("/")
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
