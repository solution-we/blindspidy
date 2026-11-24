// GET /api/donate-status?order_id=... — browser polls this; the server verifies with FamGateway.
const { rest, settle } = require('./_lib/shared');

module.exports = async (req, res) => {
  const orderId = String(req.query.order_id || '');
  if (!/^[A-Za-z0-9_]{4,40}$/.test(orderId)) return res.status(400).json({ error: 'Bad order id' });

  const read = async () => {
    const r = await rest(`donations?select=payment_status,confirmed_amount,requested_amount,payable_amount,expires_at,fundraising_goals(title)&famgateway_order_id=eq.${orderId}`);
    return r.ok ? (await r.json())[0] : null;
  };

  let d = await read();
  if (!d) return res.status(404).json({ error: 'Order not found' });
  if (d.payment_status === 'pending') {
    await settle(orderId);
    d = (await read()) || d;
  }
  return res.status(200).json({
    status: d.payment_status, // pending | success | expired | failed
    amount: d.confirmed_amount || d.requested_amount,
    payable_amount: d.payable_amount,
    expires_at: d.expires_at,
    goal_title: d.fundraising_goals && d.fundraising_goals.title,
  });
};
