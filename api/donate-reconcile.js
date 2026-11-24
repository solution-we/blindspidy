// GET /api/donate-reconcile — cron: re-verifies recent pending orders (catches missed webhooks).
const { rest, settle } = require('./_lib/shared');

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
