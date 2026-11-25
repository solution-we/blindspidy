// GET /api/donate-status?order_id=...&token=... — poll or resume a payment session.
// The token (returned only by donate-create) is required, so order IDs alone cannot be used to read a session.
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

module.exports = async (req, res) => {
  const orderId = String(req.query.order_id || '');
  const token = String(req.query.token || '');
  if (!/^[A-Za-z0-9_]{4,40}$/.test(orderId) || !/^[a-f0-9]{48}$/.test(token)) {
    return res.status(400).json({ error: 'Bad request' });
  }

  const cols = 'id,goal_id,payment_status,confirmed_amount,requested_amount,payable_amount,expires_at,qr_url,checkout_url,upi_intent,fundraising_goals(title)';
  const read = async () => {
    const r = await rest(`donations?select=${cols}&famgateway_order_id=eq.${orderId}&access_token=eq.${token}`);
    return r.ok ? (await r.json())[0] : null;
  };

  let d = await read();
  if (!d) return res.status(404).json({ error: 'Order not found' });
  if (d.payment_status === 'pending') {
    await settle(orderId); // server-to-server verification with FamGateway
    d = (await read()) || d;
  }

  const out = {
    status: d.payment_status, // pending | success | expired | failed
    amount: d.confirmed_amount || d.requested_amount,
    payable_amount: d.payable_amount,
    expires_at: d.expires_at,
    goal_id: d.goal_id,
    goal_title: d.fundraising_goals && d.fundraising_goals.title,
  };
  if (d.payment_status === 'pending') Object.assign(out, { qr_url: d.qr_url, checkout_url: d.checkout_url, upi_intent: d.upi_intent });
  if (d.payment_status === 'success') {
    const r = await rest('rpc/donor_standing', { method: 'POST', body: JSON.stringify({ p_donation: d.id }) });
    const s = r.ok ? (await r.json())[0] : null;
    if (s) { out.lifetime_total = Number(s.lifetime_total); out.rank = s.rank ? Number(s.rank) : null; } // rank is null for anonymous donors
  }
  return res.status(200).json(out);
};
