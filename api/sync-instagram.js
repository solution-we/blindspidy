// GET (cron / live-stats) or POST (admin) /api/sync-instagram
// Uses the official Instagram API with Instagram Login (graph.instagram.com) for a professional account.
// POST { token } (admin only) stores a long-lived access token, then syncs.
const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sbh = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const rest = (path, opt = {}) => fetch(`${SB}/rest/v1/${path}`, { ...opt, headers: { ...sbh, ...(opt.headers || {}) } });
const GRAPH = 'https://graph.instagram.com';

async function who(req) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  if (!t) return null;
  if (process.env.CRON_SECRET && t === process.env.CRON_SECRET) return 'cron';
  const u = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${t}` } });
  if (!u.ok) return null;
  const { id } = await u.json();
  const p = await fetch(`${SB}/rest/v1/profiles?select=role&id=eq.${id}`, { headers: sbh });
  return p.ok && (await p.json())[0]?.role === 'admin' ? 'admin' : null;
}

async function ig(path, token, params = {}) {
  const q = new URLSearchParams({ ...params, access_token: token });
  const r = await fetch(`${GRAPH}/${path}?${q}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error((j.error && j.error.message) || `Instagram error ${r.status}`); e.code = j.error && j.error.code; throw e; }
  return j;
}

async function storedToken() {
  const r = await rest('integration_tokens?select=token,expires_at&provider=eq.instagram');
  const row = r.ok ? (await r.json())[0] : null;
  if (row) return row;
  return process.env.INSTAGRAM_ACCESS_TOKEN ? { token: process.env.INSTAGRAM_ACCESS_TOKEN, expires_at: null } : null;
}

// Long-lived tokens last 60 days and can be refreshed after 24 hours; renew when under 20 days remain.
async function maybeRefresh(row) {
  let token = row.token;
  const soon = !row.expires_at || new Date(row.expires_at) - Date.now() < 20 * 864e5;
  if (soon) {
    try {
      const j = await ig('refresh_access_token', token, { grant_type: 'ig_refresh_token' });
      token = j.access_token || token;
      await save(token, null, new Date(Date.now() + (j.expires_in || 5184000) * 1000).toISOString());
    } catch (_) { /* too new to refresh, or already fine */ }
  }
  return token;
}

async function save(token, username, expires) {
  await rest('integration_tokens?on_conflict=provider', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ provider: 'instagram', token, ...(username ? { username } : {}), ...(expires ? { expires_at: expires } : {}), updated_at: new Date().toISOString() }),
  });
}

async function viewsFor(id, token) {
  try {
    const j = await ig(`${id}/insights`, token, { metric: 'views' });
    return Number(j.data && j.data[0] && j.data[0].values && j.data[0].values[0] ? j.data[0].values[0].value : (j.data[0].total_value || {}).value || 0);
  } catch (_) { return 0; }
}

async function persistThumb(id, url, existing) {
  const have = existing[id];
  if (have && have.startsWith(SB)) return have;           // already copied (Instagram image links expire)
  if (!url) return have || null;
  try {
    const r = await fetch(url);
    if (!r.ok) return have || null;
    const buf = Buffer.from(await r.arrayBuffer());
    const path = `ig/${id}.jpg`;
    const up = await fetch(`${SB}/storage/v1/object/thumbnails/${path}`, {
      method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' }, body: buf,
    });
    return up.ok ? `${SB}/storage/v1/object/public/thumbnails/${path}` : (have || url);
  } catch (_) { return have || url; }
}

async function handler(req, res) {
  if (!SB || !KEY) return res.status(500).json({ error: 'Server is missing its Supabase settings.' });
  const role = await who(req);
  if (!role) return res.status(401).json({ error: 'Unauthorized' });

  let row;
  const body = req.body || {};
  if (req.method === 'POST' && body.token) {
    if (role !== 'admin') return res.status(403).json({ error: 'Only the admin can connect Instagram.' });
    try { await ig('me', String(body.token).trim(), { fields: 'user_id,username' }); }
    catch (e) { return res.status(400).json({ error: 'Instagram rejected this token: ' + e.message }); }
    await save(String(body.token).trim(), null, null);
  }
  row = await storedToken();
  if (!row) return res.status(400).json({ error: 'Instagram is not connected yet. Add an access token in Admin > Social.' });

  try {
    const token = await maybeRefresh(row);
    const me = await ig('me', token, { fields: 'user_id,username,followers_count' });
    await save(token, me.username, null);
    await rest('social_stats?platform=eq.instagram', {
      method: 'PATCH', body: JSON.stringify({ count: Number(me.followers_count || 0), manual: false, status: 'synced', last_synced_at: new Date().toISOString() }),
    });

    // Reels only (media_product_type REELS), newest 50
    let items = [];
    let page = await ig('me/media', token, { fields: 'id,caption,media_type,media_product_type,thumbnail_url,permalink,timestamp,like_count', limit: '50' });
    items = items.concat(page.data || []);
    if (page.paging && page.paging.next && items.length < 50) {
      try { const r = await fetch(page.paging.next); const j = await r.json(); items = items.concat(j.data || []); } catch (_) {}
    }
    const reels = items.filter((x) => x.media_product_type === 'REELS').slice(0, 40);

    const er = await rest('videos?select=external_id,thumbnail_url&platform=eq.instagram');
    const existing = Object.fromEntries((er.ok ? await er.json() : []).map((x) => [x.external_id, x.thumbnail_url || '']));
    const rows = [];
    for (let i = 0; i < reels.length; i += 5) {
      const chunk = reels.slice(i, i + 5);
      const out = await Promise.all(chunk.map(async (x) => ({
        platform: 'instagram', kind: 'reel', external_id: x.id,
        title: ((x.caption || 'Instagram Reel').split('\n')[0] || 'Instagram Reel').slice(0, 140),
        thumbnail_url: await persistThumb(x.id, x.thumbnail_url, existing),
        duration: null, view_count: await viewsFor(x.id, token),
        url: x.permalink, published_at: x.timestamp, manual: false,
      })));
      rows.push(...out);
    }
    if (rows.length) {
      const up = await rest('videos?on_conflict=platform,external_id', {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows),
      });
      if (!up.ok) throw new Error('Could not save reels');
    }
    return res.status(200).json({ ok: true, reels: rows.length, followers: me.followers_count, username: me.username });
  } catch (e) {
    await rest('social_stats?platform=eq.instagram', { method: 'PATCH', body: JSON.stringify({ status: 'error' }) }).catch(() => {});
    const msg = e.code === 190 ? 'The Instagram token expired or was revoked. Generate a new one in Admin > Social.' : e.message;
    return res.status(502).json({ error: msg });
  }
}

module.exports = async (req, res) => {
  try { return await handler(req, res); } catch (e) { console.error('sync-instagram failed', e.message); return res.status(500).json({ error: 'Unexpected server error.' }); }
};
