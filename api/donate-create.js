// POST /api/donate-create — validates, finds/creates donor, creates pending donation, creates FamGateway order.
const crypto = require('crypto');
const { rest, ist } = require('./_lib/shared');

const clean = (s, max) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const b = req.body || {};
  const name = clean(b.name, 80);
  const email = clean(b.email, 200).toLowerCase();
  const publicName = clean(b.public_name, 40);
  const showPublicly = b.show_publicly === true;
  const amount = Math.round(Number(b.amount) * 100) / 100;

  if (name.length < 2) return res.status(400).json({ error: 'Please enter your name.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email.' });
  if (showPublicly && publicName.length < 2) return res.status(400).json({ error: 'Enter a public display name or turn off public display.' });

  // Admin-configured limits
  const sr = await rest('site_settings?select=key,value&key=in.(donation_min,donation_max)');
  const st = Object.fromEntries(((await sr.json()) || []).map((x) => [x.key, Number(x.value)]));
  const min = st.donation_min || 10, max = st.donation_max || 10000;
  if (!Number.isFinite(amount) || amount < min || amount > max) {
    return res.status(400).json({ error: `Amount must be between INR ${min} and INR ${max}.` });
  }

  // Goal must be active and published
  const gr = await rest(`fundraising_goals?select=id,title&id=eq.${encodeURIComponent(String(b.goal_id))}&is_active=eq.true&is_published=eq.true`);
  const goal = gr.ok ? (await gr.json())[0] : null;
  if (!goal) return res.status(400).json({ error: 'This goal is not accepting donations.' });

  // Find or create donor by normalized email. Existing donors' public settings are NOT overwritten,
  // so nobody can change another supporter's leaderboard name by typing their email.
  const find = async () => (await (await rest(`donors?select=id&normalized_email=eq.${encodeURIComponent(email)}`)).json())[0];
  let donor = await find();
  if (!donor) {
    await rest('donors', {
      method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({ private_name: name, normalized_email: email, public_display_name: publicName || null, show_publicly: showPublicly }),
    });
    donor = await find();
  }
  if (!donor) return res.status(500).json({ error: 'Could not create donor record.' });

  // Basic abuse limit: max 5 pending orders per donor per 10 minutes
  const since = new Date(Date.now() - 600000).toISOString();
  const pend = await (await rest(`donations?select=id&donor_id=eq.${donor.id}&created_at=gte.${since}`)).json();
  if (Array.isArray(pend) && pend.length >= 5) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes.' });

  // Pending donation first, then the gateway order. access_token lets only this browser resume the session.
  const token = crypto.randomBytes(24).toString('hex');
  const ins = await rest('donations', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ donor_id: donor.id, goal_id: goal.id, requested_amount: amount, access_token: token }),
  });
  const donation = ins.ok ? (await ins.json())[0] : null;
  if (!donation) return res.status(500).json({ error: 'Could not start the donation.' });

  const site = process.env.SITE_URL || `https://${req.headers.host}`;
  let order;
  try {
    const fr = await fetch('https://famgateway.in/api/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': process.env.FAMGATEWAY_API_KEY },
      body: JSON.stringify({
        amount, customer_name: name, customer_email: email,
        redirect_url: `${site}/#home`, webhook_url: `${site}/api/famgateway-webhook`,
      }),
    });
    const fj = await fr.json();
    if (!fr.ok || fj.status !== 'success') throw new Error('gateway');
    order = fj.data;
  } catch (_) {
    await rest(`donations?id=eq.${donation.id}`, { method: 'PATCH', body: JSON.stringify({ payment_status: 'failed' }) });
    return res.status(502).json({ error: 'Payment service is unavailable. Please try again shortly.' });
  }

  const expires = ist(order.expires_at_ist);
  await rest(`donations?id=eq.${donation.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      famgateway_order_id: order.order_id, payable_amount: Number(order.payable_amount),
      checkout_url: order.checkout_url, qr_url: order.qr_url, upi_intent: order.upi_intent,
      expires_at: expires, updated_at: new Date().toISOString(),
    }),
  });

  // Never returns the donor's email
  return res.status(200).json({
    order_id: order.order_id, amount, payable_amount: Number(order.payable_amount),
    qr_url: order.qr_url, checkout_url: order.checkout_url, upi_intent: order.upi_intent,
    expires_at: expires, goal_title: goal.title, access_token: token,
  });
};
