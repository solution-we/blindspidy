// GET /api/donate-status?order_id=...&token=... — poll or resume a payment session.
// The token (returned only by donate-create) is required, so order IDs alone cannot be used to read a session.
const { rest, settle } = require('./_lib/shared');

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
