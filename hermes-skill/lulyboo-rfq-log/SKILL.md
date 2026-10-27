---
name: lulyboo-rfq-log
description: Record every RFQ you send to a supplier in the Lulyboo portal (supplier, message, products, channel). Use right after sending any RFQ or quotation request.
version: 1.0.0
required_environment_variables:
  - LULYBOO_API_KEY
---

# Log an RFQ in the Lulyboo portal

Use this **every time** you send an RFQ (request for quotation) to a supplier, on any channel
(Telegram, WhatsApp, WeChat, email). It writes a record into the Lulyboo portal so the team can see
what was asked, of whom, and when. It is **one-way**: you can add records but you cannot read anything
from the portal. Never try to look up suppliers, prices or products there.

## Steps
1. Send the RFQ to the supplier as usual.
2. Write the record as JSON to a temporary file, for example `/tmp/rfq.json`:

```json
{
  "supplier": {
    "name": "Shantou Dadi Plastic Toys Co., Ltd",
    "email": "lily@dadi.example",
    "contact_name": "Lily",
    "phone": "+86 …",
    "country": "China"
  },
  "title": "RFQ: silicone baby bottle",
  "message": "The exact text you sent to the supplier",
  "channel": "Telegram",
  "contact": "@lily_dadi",
  "products": [
    { "name": "Silicone baby bottle", "sku": "SB-01", "qty": 3000, "target_price": "$1.20", "notes": "BPA free" }
  ],
  "external_id": "<a unique id for THIS message, e.g. the Telegram chat id + message id>",
  "follow_up_days": 3
}
```

   - `supplier.name` and `title` are required. Everything else is optional but helpful; fill in what you know.
   - `channel` is one of: Telegram, WhatsApp, WeChat, Email, Phone, Other.
   - If the supplier is new, the portal creates it automatically. Do not check first.
   - `external_id` must be unique per message and the same when you retry, so retries never duplicate.
   - Attachments you sent can be added as `"attachments": [{"filename": "spec.pdf", "content_type": "application/pdf", "content_base64": "…"}]`.

3. Run: `python3 ${HERMES_SKILL_DIR}/scripts/log_rfq.py /tmp/rfq.json`
4. Success looks like `{"ok": true, "ref": "LB-1008", …}`. Mention the reference (LB-1008) when you report back.
   If the portal answers `"duplicate": true`, it was already recorded: nothing more to do.

## If something goes wrong
- `status 401`: the key is wrong. Stop and tell the user. Do not guess or try other keys.
- `status 429`: a limit was reached (calls per hour, or new suppliers per day). Do not retry in a loop: tell the user.
- `status 400`: read the `error` text, fix the JSON and run again.
- Network error: wait a minute and run once more with the same `external_id`.

## Rules
- Never print, log or repeat the value of `LULYBOO_API_KEY`.
- Record only RFQs you actually sent. Do not record drafts or messages you did not send.
- Do not send customer personal data; supplier business contact details only.
