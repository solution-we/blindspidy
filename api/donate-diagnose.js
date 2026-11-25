// GET /api/donate-diagnose — admin only. Reports which parts of the payment setup are working.
// Returns only pass/fail information, never secret values.
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
      const r = await famFetch('https://famgateway.in/api/verify-order.php?order_id=diag_none');
      out.famgateway.http_status = r.status;
      out.famgateway.reply_preview = (await r.text()).replace(/\s+/g, ' ').slice(0, 120);
      out.famgateway.api_key = r.status === 401 ? 'REJECTED' : r.status === 403 ? 'BLOCKED or SUSPENDED (see reply_preview)' : 'accepted';
    } catch (e) {
      out.famgateway.api_key = 'could not reach famgateway.in';
      out.famgateway.error = errDetail(e);
    }
  } else {
    out.famgateway.api_key = 'not set';
  }

  if (out.env.FAMGATEWAY_API_KEY === 'MISSING') out.hints.push('Add FAMGATEWAY_API_KEY in Vercel, then redeploy.');
  if (out.env.SUPABASE_SERVICE_ROLE_KEY === 'MISSING' || out.env.SUPABASE_URL === 'MISSING') out.hints.push('Add the Supabase variables in Vercel, then redeploy.');
  if (Object.values(out.database).some((v) => String(v).startsWith('FAILED'))) out.hints.push('Run donations.sql and ads_and_hardening.sql in the Supabase SQL Editor.');
  if (out.database.published_goal_exists === 'NO') out.hints.push('Publish at least one goal in Admin > Goals.');
  if (out.famgateway.error) out.hints.push('This server cannot connect to famgateway.in. Send the famgateway.error line to your developer.');
  if (out.famgateway.api_key === 'REJECTED') out.hints.push('FamGateway rejected the API key. Re-copy it from the FamGateway dashboard.');
  if (!out.hints.length) out.hints.push('Setup looks healthy. A real small payment is the remaining test.');
  return res.status(200).json(out);
};
