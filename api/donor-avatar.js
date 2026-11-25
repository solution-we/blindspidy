// POST /api/donor-avatar { order_id, token, image } — a donor adds a leaderboard avatar after a verified payment.
// The order's secret token proves who the donor is; the browser sends a small 256x256 JPEG.
const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sbh = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const rest = (path, opt = {}) => fetch(`${SB}/rest/v1/${path}`, { ...opt, headers: { ...sbh, ...(opt.headers || {}) } });

function kind(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ['jpg', 'image/jpeg'];
  if (buf[0] === 0x89 && buf.slice(1, 4).toString() === 'PNG') return ['png', 'image/png'];
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return ['webp', 'image/webp'];
  return null;
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SB || !KEY) return res.status(500).json({ error: 'Server is not configured.' });
  const { order_id = '', token = '', image = '' } = req.body || {};
  if (!/^[A-Za-z0-9_]{4,40}$/.test(String(order_id)) || !/^[a-f0-9]{48}$/.test(String(token))) return res.status(400).json({ error: 'Bad request' });
  const m = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(image));
  if (!m) return res.status(400).json({ error: 'Send a JPG, PNG or WebP image.' });
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 300000) return res.status(400).json({ error: 'Image is too large.' });
  const k = kind(buf);
  if (!k) return res.status(400).json({ error: 'That file is not a valid image.' });

  // Only a verified paying donor who shows their name publicly can set an avatar
  const dr = await rest(`donations?select=donor_id,payment_status,donors(show_publicly,name_hidden)&famgateway_order_id=eq.${order_id}&access_token=eq.${token}`);
  const d = dr.ok ? (await dr.json())[0] : null;
  if (!d || d.payment_status !== 'success') return res.status(403).json({ error: 'Payment not verified.' });
  if (!d.donors || !d.donors.show_publicly || d.donors.name_hidden) return res.status(403).json({ error: 'Avatars are shown only for public supporters.' });

  const path = `${d.donor_id}.${k[0]}`;
  const up = await fetch(`${SB}/storage/v1/object/avatars/${path}`, {
    method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': k[1], 'x-upsert': 'true' }, body: buf,
  });
  if (!up.ok) return res.status(500).json({ error: 'Could not store the image.' });
  const url = `${SB}/storage/v1/object/public/avatars/${path}?v=${Date.now()}`;
  await rest(`donors?id=eq.${d.donor_id}`, { method: 'PATCH', body: JSON.stringify({ avatar_url: url, updated_at: new Date().toISOString() }) });
  return res.status(200).json({ avatar_url: url });
}

module.exports = async (req, res) => {
  try { return await handler(req, res); } catch (e) { console.error('donor-avatar failed', e.message); return res.status(500).json({ error: 'Unexpected server error.' }); }
};
