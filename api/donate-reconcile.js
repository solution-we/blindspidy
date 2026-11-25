// GET /api/donate-reconcile — cron: re-verifies recent pending orders (catches missed webhooks).
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
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  if (!process.env.CRON_SECRET || t !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const since = new Date(Date.now() - 3 * 864e5).toISOString();
  const r = await rest(`donations?select=famgateway_order_id&payment_status=eq.pending&famgateway_order_id=not.is.null&created_at=gte.${since}&limit=100`);
  const rows = r.ok ? await r.json() : [];
  const counts = { checked: rows.length, success: 0, expired: 0, pending: 0, unknown: 0 };
  for (const x of rows) {
    const out = await settle(x.famgateway_order_id);
    counts[out.status] = (counts[out.status] || 0) + 1;
  }
  // Orders that never reached the gateway
  await rest(`donations?payment_status=eq.pending&famgateway_order_id=is.null&created_at=lt.${new Date(Date.now() - 36e5).toISOString()}`, {
    method: 'PATCH', body: JSON.stringify({ payment_status: 'failed' }),
  });
  return res.status(200).json({ ok: true, ...counts });
};
