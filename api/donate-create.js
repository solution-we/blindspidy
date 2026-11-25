// POST /api/donate-create — validates, finds/creates donor, creates pending donation, creates FamGateway order.
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

const FAM_HEADERS = () => ({
  'X-Api-Key': process.env.FAMGATEWAY_API_KEY,
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (compatible; BlindSpidyServer/1.0)',
});
async function famFetch(url, opt = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    return await fetch(url, { ...opt, headers: { ...FAM_HEADERS(), ...(opt.headers || {}) }, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}
const errDetail = (e) => String((e && e.cause && (e.cause.code || e.cause.message)) || (e && e.name) || 'error') + (e && e.message ? ': ' + e.message : '');

// Authoritative server-to-server check (API key never leaves the server)
async function famVerify(orderId) {
  try {
    const r = await famFetch(`https://famgateway.in/api/verify-order.php?order_id=${encodeURIComponent(orderId)}`);
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

const clean = (s, max) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: 'Server is missing its Supabase settings (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).' });
  if (!process.env.FAMGATEWAY_API_KEY) return res.status(500).json({ error: 'Server is missing FAMGATEWAY_API_KEY.' });
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
    const fr = await famFetch('https://famgateway.in/api/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount, customer_name: name, customer_email: email,
        redirect_url: `${site}/#home`, webhook_url: `${site}/api/famgateway-webhook`,
      }),
    });
    const text = await fr.text();
    let fj;
    try { fj = JSON.parse(text); } catch (_) { throw new Error('HTTP ' + fr.status + ' non-JSON reply: ' + text.replace(/\s+/g, ' ').slice(0, 80)); }
    if (!fr.ok || fj.status !== 'success') throw new Error('HTTP ' + fr.status + ': ' + (fj.message || fj.status || 'rejected'));
    order = fj.data;
  } catch (e) {
    const detail = String(e.message).startsWith('HTTP') ? e.message : errDetail(e);
    console.error('FamGateway create-order failed:', detail);
    await rest(`donations?id=eq.${donation.id}`, { method: 'PATCH', body: JSON.stringify({ payment_status: 'failed' }) });
    return res.status(502).json({ error: `Payment service is unavailable (${detail}). Please try again shortly.` });
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
}

module.exports = async (req, res) => {
  try {
    return await handler(req, res);
  } catch (e) {
    console.error('donate-create failed', e);
    return res.status(500).json({ error: 'Unexpected server error. Did you run donations.sql in Supabase?' });
  }
};
