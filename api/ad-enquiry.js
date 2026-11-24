// POST /api/ad-enquiry — validates and stores an advertising enquiry, emails the owner (best effort).
const crypto = require('crypto');
const { rest } = require('./_lib/shared');

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
