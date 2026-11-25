// POST /api/ad-enquiry — validates and stores an advertising enquiry, emails the owner (best effort).
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

const clean = (s, max) => String(s || '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, max);
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DURATIONS = ['1 week', '2 weeks', '1 month', '3 months', 'Other'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const b = req.body || {};
  if (b.website_hp) return res.status(200).json({ reference: 'AD-000000' }); // honeypot

  const brand = clean(b.brand, 100), name = clean(b.contact_name, 80), email = clean(b.email, 200).toLowerCase();
  const website = clean(b.website, 300), description = clean(b.description, 1500), message = clean(b.message, 2000);
  const budget = Number(b.budget), duration = DURATIONS.includes(b.duration) ? b.duration : null;
  const imagePath = /^[A-Za-z0-9._-]{5,120}$/.test(String(b.image_path || '')) ? String(b.image_path) : null;

  if (brand.length < 2) return res.status(400).json({ error: 'Enter your brand or company name.' });
  if (name.length < 2) return res.status(400).json({ error: 'Enter the contact person name.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (website && !/^https?:\/\//i.test(website)) return res.status(400).json({ error: 'Website must start with http:// or https://' });
  if (!(budget > 0 && budget <= 10000000)) return res.status(400).json({ error: 'Enter a budget in INR.' });
  if (!duration) return res.status(400).json({ error: 'Choose a duration.' });
  if (description.length < 10) return res.status(400).json({ error: 'Describe your advertisement (at least 10 characters).' });

  const since = new Date(Date.now() - 36e5).toISOString();
  const recent = await rest(`ad_enquiries?select=id&email=eq.${encodeURIComponent(email)}&created_at=gte.${since}`);
  if (recent.ok && (await recent.json()).length >= 3) return res.status(429).json({ error: 'Too many enquiries. Please try again later.' });

  const reference = 'AD-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  const ins = await rest('ad_enquiries', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ reference, brand, contact_name: name, email, website: website || null, budget_inr: budget, duration, description, message: message || null, image_path: imagePath }),
  });
  if (!ins.ok) return res.status(500).json({ error: 'Could not save your enquiry. Please try again.' });

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.CONTACT_FROM || 'Blind Spidy <onboarding@resend.dev>',
        to: [process.env.CONTACT_TO_EMAIL || 'blindspidy2@gmail.com'], reply_to: email,
        subject: `New ad enquiry ${reference}: ${brand}`,
        html: `<p><b>${esc(brand)}</b> (${esc(name)}, ${esc(email)})</p><p>Budget: INR ${budget} for ${duration}</p><p style="white-space:pre-wrap">${esc(description)}</p><p style="white-space:pre-wrap">${esc(message)}</p>`,
      }),
    });
  } catch (_) {}

  return res.status(200).json({ reference });
};
