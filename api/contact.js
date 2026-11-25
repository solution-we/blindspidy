// POST /api/contact — validates, rate-limits, saves to Supabase, emails via Resend.
const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sbh = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { name = '', email = '', message = '', website = '' } = req.body || {};
  if (website) return res.status(200).json({ ok: true }); // honeypot: pretend success

  const n = String(name).trim(), e = String(email).trim(), m = String(message).trim();
  if (n.length < 2 || n.length > 100 || m.length < 10 || m.length > 4000 || e.length > 200 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  // Rate limit: max 3 messages per email address per 10 minutes
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const recent = await fetch(
    `${SB}/rest/v1/contact_messages?select=id&email=eq.${encodeURIComponent(e)}&created_at=gte.${since}`,
    { headers: sbh }
  );
  if (recent.ok && (await recent.json()).length >= 3) return res.status(429).json({ error: 'Too many messages' });

  const saved = await fetch(`${SB}/rest/v1/contact_messages`, {
    method: 'POST',
    headers: { ...sbh, Prefer: 'return=minimal' },
    body: JSON.stringify({ name: n, email: e, message: m }),
  });
  if (!saved.ok) return res.status(500).json({ error: 'Could not save message' });

  // Email is best effort: the message is already stored for the admin panel.
  try {
    const rr = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.CONTACT_FROM || 'Blind Spidy <onboarding@resend.dev>',
        to: [process.env.CONTACT_TO_EMAIL || 'blindspidy2@gmail.com'],
        reply_to: e,
        subject: `New message from ${n}`,
        html: `<p><b>${esc(n)}</b> (${esc(e)})</p><p style="white-space:pre-wrap">${esc(m)}</p>`,
      }),
    });
    if (!rr.ok) console.error('Resend rejected the email:', rr.status, await rr.text());
  } catch (e) { console.error('Resend request failed:', e.message); }

  return res.status(200).json({ ok: true });
};
