// POST /api/famgateway-webhook — verifies X-FamGateway-Signature (HMAC-SHA256 of the raw body,
// keyed with the merchant API key), then confirms the order server-to-server before crediting it.
const crypto = require('crypto');
// ---- shared helpers (inlined so this file has no local imports) ----
// Shared helpers for the donation functions (server-side only).
const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sbh = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

const rest = (path, opt = {}) =>
  fetch(`${SB}/rest/v1/${path}`, { ...opt, headers: { ...sbh, ...(opt.headers || {}) } });

// FamGateway timestamps look like "02-09-2026 14:31:12" (IST)
const ist = (s) => {
  const m = /(\d\d)-(\d\d)-(\d{4}) (\d\d):(\d\d):(\d\d)/.exec(s || '');
  return m ? new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}+05:30`).toISOString() : null;
};

// Authoritative server-to-server check (API key never leaves the server)
async function famVerify(orderId) {
  try {
    const r = await fetch(`https://famgateway.in/api/verify-order.php?order_id=${encodeURIComponent(orderId)}`, {
      headers: { 'X-Api-Key': process.env.FAMGATEWAY_API_KEY },
    });
    return await r.json();
  } catch (_) {
    return null;
  }
}

// Verify with FamGateway, then confirm/expire the donation. Safe to call repeatedly.
async function settle(orderId) {
  const j = await famVerify(orderId);
  const st = j && j.status;
  if (st === 'success') {
    const d = j.data || j;
    const r = await rest('rpc/confirm_donation', {
      method: 'POST',
      body: JSON.stringify({
        p_order: orderId, p_amount: Number(d.amount), p_txn: d.transaction_id || null,
        p_utr: d.utr || null, p_paid: ist(d.payment_time_ist || d.payment_time),
      }),
    });
    const result = r.ok ? await r.json() : 'rpc_error';
    return { status: 'success', result };
  }
  if (st === 'expired') {
    await rest(`donations?famgateway_order_id=eq.${encodeURIComponent(orderId)}&payment_status=eq.pending`, {
      method: 'PATCH', body: JSON.stringify({ payment_status: 'expired', updated_at: new Date().toISOString() }),
    });
    return { status: 'expired' };
  }
  return { status: st === 'pending' ? 'pending' : 'unknown' };
}
// ---- end shared helpers ----

const readRaw = (req) => new Promise((ok, no) => {
  const c = [];
  req.on('data', (x) => c.push(x));
  req.on('end', () => ok(Buffer.concat(c)));
  req.on('error', no);
});

const logEvent = (row) =>
  rest('payment_events', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) }).catch(() => {});

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');
  const raw = await readRaw(req);
  const sig = String(req.headers['x-famgateway-signature'] || '');
  const expected = crypto.createHmac('sha256', process.env.FAMGATEWAY_API_KEY).update(raw).digest('hex');
  const valid = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));

  if (!valid) {
    await logEvent({ event_type: 'invalid_signature', signature_verified: false, processing_status: 'rejected' });
    return res.status(401).send('Invalid signature');
  }

  let p;
  try { p = JSON.parse(raw.toString('utf8')); } catch (_) { return res.status(400).send('Bad JSON'); }
  const orderId = String(p.order_id || '');
  if (p.event !== 'payment.success' || !/^[A-Za-z0-9_]{4,40}$/.test(orderId)) {
    await logEvent({ order_id: orderId || null, event_type: String(p.event || 'unknown'), signature_verified: true, processing_status: 'ignored' });
    return res.status(200).json({ status: 'ignored' });
  }

  // Payload is not trusted for crediting: settle() re-verifies with FamGateway and the DB function is idempotent.
  const out = await settle(orderId);
  const result = out.status === 'success' ? out.result : out.status;
  await logEvent({
    order_id: orderId, event_type: p.event, transaction_id: p.transaction_id || null, utr: p.utr || null,
    signature_verified: true, processing_status: String(result), processed_at: new Date().toISOString(),
  });

  // Ask FamGateway to retry later if verification was unavailable
  if (out.status === 'unknown' || out.status === 'pending') return res.status(503).send('Verification unavailable');
  return res.status(200).json({ status: result });
};

module.exports.config = { api: { bodyParser: false } };
