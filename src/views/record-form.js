'use strict';
// The record-only shipment form (new record, edit, and "Save as record only" from a forwarder update).
const { html, raw } = require('../lib/html');

/** v: { name, atd, ata, duty, fees, freight, entry_no, pos, notes } · customs: duty/fees come from the 7501 */
function recordFields(v = {}, { customs = false, files = false, id = 'rec' } = {}) {
  const inp = (name, label, extra = '', type = 'text') => html`<label class="rf-f"><span>${label}</span><input name="${name}" type="${type}" value="${v[name] ?? ''}" ${raw(extra)}></label>`;
  return html`<div class="rf">
    ${inp('name', 'Name', 'placeholder="e.g. ONE 011E · ONEYSZPGX1565502" maxlength="120"')}
    ${inp('entry_no', 'Customs entry no.', 'placeholder="optional" maxlength="40"')}
    ${inp('atd', 'Sailed', '', 'date')}${inp('ata', 'Arrived', '', 'date')}
    ${customs ? html`<p class="rf-note">Duty and fees are read from the 7501 into <b>Customs</b> and counted on this record.</p>` : html`${inp('duty', 'Customs duty (USD)', 'inputmode="decimal" placeholder="0.00"')}${inp('fees', 'Fees (USD)', 'inputmode="decimal" placeholder="MPF, HMF…"')}`}
    ${inp('freight', 'Freight (USD)', 'inputmode="decimal" placeholder="if known"')}
    <label class="rf-f rf-w"><span>POs in it</span><input name="pos" value="${v.pos ?? ''}" placeholder="e.g. 310002, 610000"></label>
    <label class="rf-chk rf-w"><input type="checkbox" name="mark_shipped" value="1"> Also mark these POs' open lines as shipped</label>
    <label class="rf-f rf-w"><span>Notes</span><input name="notes" value="${v.notes ?? ''}" maxlength="1000" placeholder="optional"></label>
    ${files ? html`<div class="rf-w mdrop small" data-filebox><div class="mdrop-box"><input type="file" name="file" multiple aria-label="${`Documents for ${id}`}"><span class="dz-main" data-main>Drop documents here, paste (⌘V) or <u>choose</u></span><span class="dz-hint">7501, invoices, B/L — optional</span></div><ul class="dz-list" data-list></ul><p class="dz-note" data-note role="status"></p></div>` : ''}
  </div>`;
}

module.exports = { recordFields };
