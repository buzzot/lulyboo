#!/usr/bin/env python3
"""Send an RFQ email (one message per supplier) over SMTP.

Dry-run by default: composes and prints the message, sends nothing unless --send.
Credentials come from $HERMES_HOME/.env (EMAIL_* vars), same source the Hermes
email gateway adapter uses, so configuring one configures both.

Usage:
  send_rfq.py --to a@x.com --subject "RFQ: ..." --body-file rfq.txt
  send_rfq.py --recipients suppliers.json --subject "..." --body-file rfq.txt --send
"""
from __future__ import annotations

import argparse
import csv
import imaplib
import json
import mimetypes
import os
import smtplib
import ssl
import sys
import time
from datetime import datetime
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from pathlib import Path

HERMES_HOME = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
ENV_FILE = HERMES_HOME / ".env"
DEFAULT_LOG = Path.home() / "sourcing" / "rfq-log.csv"
# Supplier replies go here so the Lulyboo portal records them (override: --reply-to / EMAIL_REPLY_TO).
DEFAULT_REPLY_TO = "requests@in.lulyboo.space"
LOG_FIELDS = ["date", "product", "supplier", "contact", "email", "subject",
              "message_id", "status", "notes"]


def load_env(path: Path = ENV_FILE) -> dict:
    """Minimal .env reader: KEY=VALUE, ignores comments and blank lines."""
    vals: dict[str, str] = {}
    if not path.exists():
        return vals
    for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        vals[key.strip()] = value.strip().strip('"').strip("'")
    return vals


def resolve_creds(env: dict) -> dict:
    port = int(env.get("EMAIL_SMTP_PORT") or 587)
    security = (env.get("EMAIL_SMTP_SECURITY") or "").strip().lower()
    if security not in {"tls", "starttls", "plain"}:
        security = "tls" if port == 465 else "starttls"
    smtp_host = (env.get("EMAIL_SMTP_HOST") or "").strip()
    # IMAP host: explicit EMAIL_IMAP_HOST, else smtp.example.com -> imap.example.com
    imap_host = (env.get("EMAIL_IMAP_HOST") or "").strip()
    if not imap_host and smtp_host.lower().startswith("smtp."):
        imap_host = "imap." + smtp_host[5:]
    return {
        "address": (env.get("EMAIL_ADDRESS") or "").strip(),
        "password": env.get("EMAIL_PASSWORD") or "",
        "host": smtp_host,
        "port": port,
        "security": security,
        "reply_to": (env.get("EMAIL_REPLY_TO") or "").strip(),
        "imap_host": imap_host,
        "imap_port": int(env.get("EMAIL_IMAP_PORT") or 993),
        "sent_folder": (env.get("EMAIL_SENT_FOLDER") or "INBOX.Sent").strip(),
        "verify": (env.get("EMAIL_SMTP_TLS_VERIFY", "true").strip().lower()
                   not in {"0", "false", "no", "off"}),
    }


def missing_creds(creds: dict) -> list:
    return [k for k in ("address", "password", "host") if not creds[k]]


def build_message(creds: dict, to_addr: str, subject: str, body: str,
                  attachments: list[str], reply_to: str = "") -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = creds["address"]
    msg["To"] = to_addr
    msg["Subject"] = subject
    if reply_to:
        msg["Reply-To"] = reply_to
    msg["Date"] = formatdate(localtime=True)
    domain = creds["address"].split("@")[-1] if "@" in creds["address"] else "localhost"
    msg["Message-ID"] = make_msgid(domain=domain)
    msg.set_content(body, subtype="plain", charset="utf-8")
    for path in attachments:
        p = Path(path).expanduser()
        if not p.is_file():
            raise FileNotFoundError(f"attachment not found: {p}")
        ctype, _ = mimetypes.guess_type(p.name)
        maintype, _, subtype = (ctype or "application/octet-stream").partition("/")
        msg.add_attachment(p.read_bytes(), maintype=maintype, subtype=subtype,
                           filename=p.name)
    return msg


def smtp_send(creds: dict, msg: EmailMessage) -> None:
    ctx = ssl.create_default_context()
    if not creds["verify"]:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    if creds["security"] == "tls":
        server = smtplib.SMTP_SSL(creds["host"], creds["port"], context=ctx, timeout=30)
    else:
        server = smtplib.SMTP(creds["host"], creds["port"], timeout=30)
        if creds["security"] == "starttls":
            server.starttls(context=ctx)
    try:
        server.login(creds["address"], creds["password"])
        server.send_message(msg)
    finally:
        try:
            server.quit()
        except Exception:
            server.close()


def save_to_sent(creds: dict, msg: EmailMessage) -> str:
    """Upload a copy of the sent message to the Sent folder over IMAP.
    Returns "" on success, or a short reason on failure (never raises: the email is already sent)."""
    if not creds["imap_host"]:
        return "sent copy NOT saved: no IMAP host (set EMAIL_IMAP_HOST)"
    ctx = ssl.create_default_context()
    if not creds["verify"]:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    try:
        imap = imaplib.IMAP4_SSL(creds["imap_host"], creds["imap_port"], ssl_context=ctx, timeout=30)
        try:
            imap.login(creds["address"], creds["password"])
            typ, data = imap.append(creds["sent_folder"], "\\Seen",
                                    imaplib.Time2Internaldate(time.time()), msg.as_bytes())
            if typ != "OK":
                return f"sent copy NOT saved: IMAP {typ} {data}"
        finally:
            try:
                imap.logout()
            except Exception:
                pass
    except Exception as exc:  # noqa: BLE001
        return f"sent copy NOT saved: {type(exc).__name__}: {exc}"
    return ""


def load_recipients(args) -> list[dict]:
    out: list[dict] = []
    for addr in args.to or []:
        out.append({"email": addr.strip(), "supplier": "", "contact": ""})
    if args.recipients:
        data = json.loads(Path(args.recipients).expanduser().read_text(encoding="utf-8"))
        for row in data:
            if isinstance(row, str):
                out.append({"email": row.strip(), "supplier": "", "contact": ""})
            else:
                out.append({
                    "email": (row.get("email") or "").strip(),
                    "supplier": row.get("supplier") or row.get("company") or "",
                    "contact": row.get("contact") or row.get("person") or "",
                })
    return [r for r in out if r["email"]]


def append_log(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    new = not path.exists()
    with path.open("a", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=LOG_FIELDS)
        if new:
            writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in LOG_FIELDS})


def main() -> int:
    ap = argparse.ArgumentParser(description="Send RFQ email(s) over SMTP.")
    ap.add_argument("--to", action="append", default=[],
                    help="Recipient address; repeat for several suppliers.")
    ap.add_argument("--recipients", help="JSON file: [{supplier, contact, email}, ...]")
    ap.add_argument("--subject", required=True, help="Subject line.")
    ap.add_argument("--body-file", required=True, help="Path to the RFQ body (text).")
    ap.add_argument("--product", default="", help="Product label for the log.")
    ap.add_argument("--attach", action="append", default=[], help="Attachment path; repeatable.")
    ap.add_argument("--reply-to", default="",
                    help=f"Reply-To address (default: EMAIL_REPLY_TO or {DEFAULT_REPLY_TO}).")
    ap.add_argument("--no-save-copy", action="store_true",
                    help="Do not save a copy to the Sent folder over IMAP.")
    ap.add_argument("--send", action="store_true",
                    help="Actually send. Without it the run is a dry-run preview.")
    ap.add_argument("--log", default=str(DEFAULT_LOG), help=f"CSV log path (default {DEFAULT_LOG}).")
    ap.add_argument("--json", action="store_true", help="Emit JSON instead of text.")
    args = ap.parse_args()

    body_path = Path(args.body_file).expanduser()
    if not body_path.is_file():
        print(f"ERROR: body file not found: {body_path}", file=sys.stderr)
        return 2
    body = body_path.read_text(encoding="utf-8")

    recipients = load_recipients(args)
    if not recipients:
        print("ERROR: no recipients (use --to or --recipients)", file=sys.stderr)
        return 2

    env = load_env()
    creds = resolve_creds(env)
    gaps = missing_creds(creds)
    log_path = Path(args.log).expanduser()
    reply_to = (args.reply_to or creds["reply_to"] or DEFAULT_REPLY_TO).strip()

    results = []
    for rec in recipients:
        row = {
            "date": datetime.now().isoformat(timespec="seconds"),
            "product": args.product,
            "supplier": rec["supplier"],
            "contact": rec["contact"],
            "email": rec["email"],
            "subject": args.subject,
            "message_id": "",
            "status": "",
            "notes": "",
        }
        if gaps:
            row["status"] = "NOT_SENT"
            row["notes"] = "missing EMAIL_* config: " + ",".join(gaps)
            results.append(row)
            continue
        try:
            msg = build_message(creds, rec["email"], args.subject, body, args.attach, reply_to)
        except FileNotFoundError as exc:
            row["status"] = "NOT_SENT"
            row["notes"] = str(exc)
            results.append(row)
            continue
        row["message_id"] = msg["Message-ID"]
        if not args.send:
            row["status"] = "DRY_RUN"
            row["notes"] = "preview only; rerun with --send"
            results.append(row)
            continue
        try:
            smtp_send(creds, msg)
            row["status"] = "SENT"
        except Exception as exc:  # noqa: BLE001 - report any SMTP failure verbatim
            row["status"] = "FAILED"
            row["notes"] = f"{type(exc).__name__}: {exc}"
        if row["status"] == "SENT" and not args.no_save_copy:
            # The email is already sent; a failed copy is reported but never changes SENT.
            row["notes"] = save_to_sent(creds, msg)
        results.append(row)

    append_log(log_path, results)

    if args.json:
        print(json.dumps({"dry_run": not args.send, "results": results,
                          "log": str(log_path)}, indent=2))
        return 0 if all(r["status"] in {"SENT", "DRY_RUN"} for r in results) else 1

    mode = "SEND" if args.send else "DRY-RUN (nothing was sent)"
    print(f"=== RFQ {mode} ===")
    print(f"From:    {creds['address'] or '<EMAIL_ADDRESS not configured>'}")
    print(f"Reply-To: {reply_to}")
    print(f"Subject: {args.subject}")
    print(f"Body:    {body_path} ({len(body)} chars)")
    if args.attach:
        print(f"Attach:  {', '.join(args.attach)}")
    if gaps:
        print(f"\n!! SMTP not configured — missing: {', '.join(gaps)}")
        print("   Add EMAIL_ADDRESS / EMAIL_PASSWORD / EMAIL_SMTP_HOST to "
              f"{ENV_FILE} (or run: hermes gateway setup -> Email)")
    print()
    for row in results:
        print(f"[{row['status']}] {row['email']}  ({row['supplier'] or 'supplier'})"
              + (f"  {row['notes']}" if row["notes"] else ""))
    print(f"\nLog: {log_path}")
    return 0 if all(r["status"] in {"SENT", "DRY_RUN"} for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())