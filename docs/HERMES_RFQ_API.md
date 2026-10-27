# Recording RFQs from Hermes (one-way)

Hermes can **add** records to the Lulyboo portal. It cannot read anything back: no suppliers, products, prices or other requests.

## Setup
1. Make a key: `openssl rand -hex 24` (any random string of 32+ characters works).
2. Railway → service → Variables → add `INTEGRATION_API_KEY` = the key → Deploy.
3. Give the same key to Hermes (in its own secret/credential store, never in a chat or a file in a repo).

## Endpoint
`POST https://lulyboo.space/api/v1/rfq`
Headers: `Authorization: Bearer <INTEGRATION_API_KEY>` and `Content-Type: application/json`

```json
{
  "supplier": { "name": "Shantou Dadi Plastic Toys Co., Ltd", "email": "lily@dadi.example",
                "contact_name": "Lily", "phone": "+86 …", "website": "…", "country": "China" },
  "title": "RFQ: silicone baby bottle",
  "message": "The exact text that was sent to the supplier",
  "channel": "Telegram",
  "contact": "@lily_dadi",
  "products": [ { "name": "Silicone baby bottle", "sku": "SB-01", "qty": 3000, "target_price": "$1.20", "notes": "BPA free" } ],
  "attachments": [ { "filename": "spec.pdf", "content_type": "application/pdf", "content_base64": "…" } ],
  "sent_at": "2026-10-27T20:05:00Z",
  "external_id": "hermes-msg-12345",
  "follow_up_days": 3,
  "notes": "Internal note (optional)"
}
```
Required: `supplier.name`, and `title` (or at least one product). Everything else is optional.

| Field | Meaning |
|---|---|
| `supplier` | Matched by email first, then by company name (ignoring Co., Ltd, punctuation). **If no match, a new supplier is created** with status "Contacted". An existing supplier only has blank fields filled in; nothing is overwritten. |
| `channel` | Telegram, WhatsApp, WeChat, Email, Phone or Other |
| `external_id` | Hermes' own id for this message. Sending the same one again never creates a duplicate |
| `follow_up_days` | Days until the CRM follow-up task (default 3, `0` = none) |
| `sent_at` | When it was really sent (default: now) |

## Response
`201` `{ "ok": true, "ref": "LB-1008", "request_id": "…", "url": "https://lulyboo.space/admin/requests/…", "supplier_created": true }`
A retry with the same `external_id` returns `200` with `"duplicate": true`. Errors: `400` (bad input), `401` (wrong key), `503` (API not enabled).

## What appears in the portal
- **Requests** list: the RFQ with its channel, and its full content and attachments on the request page
- The supplier's **activity timeline**: "RFQ LB-1008 sent via Telegram: …"
- **CRM**: a follow-up task "Follow up RFQ LB-1008", due in 3 days, closed automatically when a reply is logged on that request

## Ready-to-paste instruction for Hermes
> After you send an RFQ to a supplier, record it by calling `POST https://lulyboo.space/api/v1/rfq` with the key in the `Authorization: Bearer` header. Send the supplier's company name (and email, contact name, phone, country if you know them), a short title, the exact message you sent, the channel (Telegram, WhatsApp, WeChat or Email), the products with quantities and target prices, and a unique `external_id` for this message. If the supplier is new, the portal creates it. Do not try to read anything back from the portal. Send the call once per RFQ, and retry only if it fails (the same `external_id` is safe to resend).

## Security
- HTTPS only; the key is checked in constant time. The API is write-only and returns no portal data.
- Limits (change in Railway if needed): `API_MAX_CALLS_PER_HOUR` (60), `API_MAX_NEW_SUPPLIERS_PER_DAY` (20), `API_MAX_FAILED_PER_15MIN` (10 bad keys per address).
- Every call is recorded in **Requests → integration log** (`/admin/api-log`): time, address, which key, result, request.
- Suppliers created by the API are marked **Review** until you press "mark as reviewed" on the supplier page.
- **Rotating the key without downtime:** 1) add `INTEGRATION_API_KEY_NEXT` in Railway (new random value) and deploy; 2) give Hermes the new value; 3) once the log shows calls with key `next`, set `INTEGRATION_API_KEY` to the new value, delete `INTEGRATION_API_KEY_NEXT`, deploy.

## Installing the ready-made Hermes skill (`hermes-skill/lulyboo-rfq-log`)
1. Copy the folder `lulyboo-rfq-log` to `~/.hermes/skills/` on the machine where Hermes runs.
2. Add the key to `~/.hermes/.env` (restrict it: `chmod 600 ~/.hermes/.env`): `LULYBOO_API_KEY=<your key>` and optionally `LULYBOO_API_URL=https://lulyboo.space`.
3. Restart the gateway (`hermes gateway restart`) and start a new session (`/reset`).
4. Test: ask Hermes to log a test RFQ, then look in the portal under Requests.
The script is `scripts/log_rfq.py` (Python standard library only). Check Hermes' own skills documentation if its SKILL.md fields differ.
