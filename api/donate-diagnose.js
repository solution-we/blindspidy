// GET /api/donate-diagnose — admin only. Reports which parts of the payment setup are working.
// Returns only pass/fail information, never secret values.
const { SB, KEY, sbh, rest } = require('./_lib/shared');

async function isAdmin(req) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  if (!t || !SB || !KEY) return false;
  const u = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${t}` } }).catch(() => null);
  if (!u || !u.ok) return false;
  const { id } = await u.json();
  const p = await fetch(`${SB}/rest/v1/profiles?select=role&id=eq.${id}`, { headers: sbh });
  return p.ok && (await p.json())[0]?.role === 'admin';
}

module.exports = async (req, res) => {
  if (!(await isAdmin(req))) return res.status(401).json({ error: 'Unauthorized (check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set)' });
  const out = { env: {}, database: {}, famgateway: {}, hints: [] };

  for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'FAMGATEWAY_API_KEY', 'RESEND_API_KEY', 'YOUTUBE_API_KEY', 'CRON_SECRET']) {
    out.env[k] = process.env[k] ? 'set' : 'MISSING';
  }

  for (const t of ['donors', 'fundraising_goals', 'donations', 'payment_events', 'ad_enquiries', 'ad_campaigns']) {
    const r = await rest(`${t}?select=*&limit=1`).catch(() => null);
    out.database[t] = r && r.ok ? 'ok' : `FAILED${r ? ' (' + r.status + ')' : ''}`;
  }
  const rpc = await rest('rpc/confirm_donation', {
    method: 'POST', body: JSON.stringify({ p_order: 'diag_none', p_amount: 1, p_txn: null, p_utr: null, p_paid: null }),
  }).catch(() => null);
  out.database.confirm_donation = rpc && rpc.ok ? 'ok' : 'FAILED';
  const g = await rest('fundraising_goals?select=id&is_active=eq.true&is_published=eq.true&limit=1').catch(() => null);
  out.database.published_goal_exists = g && g.ok && (await g.json()).length ? 'yes' : 'NO';

  if (process.env.FAMGATEWAY_API_KEY) {
    try {
      const r = await fetch('https://famgateway.in/api/verify-order.php?order_id=diag_none', { headers: { 'X-Api-Key': process.env.FAMGATEWAY_API_KEY } });
      out.famgateway.http_status = r.status;
      out.famgateway.api_key = r.status === 401 ? 'REJECTED' : r.status === 403 ? 'ACCOUNT SUSPENDED' : 'accepted';
    } catch (_) {
      out.famgateway.api_key = 'could not reach famgateway.in';
    }
  } else {
    out.famgateway.api_key = 'not set';
  }

  if (out.env.FAMGATEWAY_API_KEY === 'MISSING') out.hints.push('Add FAMGATEWAY_API_KEY in Vercel, then redeploy.');
  if (out.env.SUPABASE_SERVICE_ROLE_KEY === 'MISSING' || out.env.SUPABASE_URL === 'MISSING') out.hints.push('Add the Supabase variables in Vercel, then redeploy.');
  if (Object.values(out.database).some((v) => String(v).startsWith('FAILED'))) out.hints.push('Run donations.sql and ads_and_hardening.sql in the Supabase SQL Editor.');
  if (out.database.published_goal_exists === 'NO') out.hints.push('Publish at least one goal in Admin > Goals.');
  if (out.famgateway.api_key === 'REJECTED') out.hints.push('FamGateway rejected the API key. Re-copy it from the FamGateway dashboard.');
  if (!out.hints.length) out.hints.push('Setup looks healthy. A real small payment is the remaining test.');
  return res.status(200).json(out);
};
