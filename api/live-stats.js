// GET /api/live-stats — public, polled by the homepage every 3 seconds.
// Visitors share one cached answer. Upstream refresh rules (to respect API quotas):
//   YouTube subscribers : every YT_LIVE_SECONDS (default 10, minimum 3). Costs 1 quota unit per refresh.
//   Instagram followers : every 60 seconds.
//   Videos / playlists  : full YouTube sync at most every 30 min; Instagram reels at most every 30 min.
const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sbh = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const rest = (path, opt = {}) => fetch(`${SB}/rest/v1/${path}`, { ...opt, headers: { ...sbh, ...(opt.headers || {}) } });
const getSet = async (k) => { const r = await rest(`site_settings?select=value&key=eq.${k}`); return r.ok ? ((await r.json())[0] || {}).value : null; };
const setSet = (k, v) => rest('site_settings?on_conflict=key', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ key: k, value: v }) });

const YT_EVERY = Math.max(3, Number(process.env.YT_LIVE_SECONDS) || 10) * 1000;
// Remembered while this server instance stays warm
let lastYt = 0, ytPause = 0, lastIg = 0, lastFullYt = 0, lastFullIg = 0;

async function handler(req, res) {
  if (!SB || !KEY) return res.status(200).json({});
  const now = Date.now();
  const sr = await rest('social_stats?select=platform,count,manual,status,last_synced_at');
  const rows = sr.ok ? await sr.json() : [];
  const yt = rows.find((x) => x.platform === 'youtube');
  const ig = rows.find((x) => x.platform === 'instagram');
  const patch = (platform, body) => rest(`social_stats?platform=eq.${platform}`, { method: 'PATCH', body: JSON.stringify(body) });

  // ---- YouTube subscribers ----
  if (process.env.YOUTUBE_API_KEY && yt && !(yt.manual && yt.status === 'manual') && now > ytPause && now - lastYt >= YT_EVERY) {
    lastYt = now;
    try {
      const q = new URLSearchParams({ part: 'statistics', forHandle: process.env.YOUTUBE_HANDLE || '@blindspidey', key: process.env.YOUTUBE_API_KEY });
      const r = await fetch(`https://www.googleapis.com/youtube/v3/channels?${q}`);
      if (r.status === 403 || r.status === 429) ytPause = now + 5 * 60 * 1000;         // quota used up: back off 5 minutes
      else if (r.ok) {
        const c = ((await r.json()).items || [])[0];
        if (c && !c.statistics.hiddenSubscriberCount) {
          const n = Number(c.statistics.subscriberCount);
          const stale = now - new Date(yt.last_synced_at || 0).getTime() > 60000;
          if (n !== Number(yt.count) || stale) {
            await patch('youtube', { count: n, manual: false, status: 'synced', last_synced_at: new Date().toISOString() });
            yt.count = n;
          }
        }
      }
    } catch (_) {}
  }

  // ---- Instagram followers (every 60 s, only if a token is stored) ----
  if (ig && !(ig.manual && ig.status === 'manual') && now - lastIg >= 60000) {
    lastIg = now;
    try {
      const tr = await rest('integration_tokens?select=token&provider=eq.instagram');
      const tok = (tr.ok ? ((await tr.json())[0] || {}).token : null) || process.env.INSTAGRAM_ACCESS_TOKEN;
      if (tok) {
        const r = await fetch(`https://graph.instagram.com/me?fields=followers_count&access_token=${encodeURIComponent(tok)}`);
        const j = r.ok ? await r.json() : null;
        if (j && Number.isFinite(j.followers_count)) {
          if (j.followers_count !== Number(ig.count)) await patch('instagram', { count: j.followers_count, manual: false, status: 'synced', last_synced_at: new Date().toISOString() });
          ig.count = j.followers_count;
        }
      }
    } catch (_) {}
  }

  // ---- Full syncs (videos, playlists, reels) at most every 30 minutes ----
  const site = process.env.SITE_URL || `https://${req.headers.host}`;
  const kick = async (path) => {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
      await fetch(`${site}${path}`, { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` }, signal: ctl.signal });
      clearTimeout(t);
    } catch (_) {}
  };
  if (process.env.CRON_SECRET && process.env.YOUTUBE_API_KEY && now - lastFullYt >= 1800000) {
    lastFullYt = now;
    if (now - Number((await getSet('yt_full_sync')) || 0) > 1800000) { await setSet('yt_full_sync', now); await kick('/api/sync-youtube'); }
  }
  if (process.env.CRON_SECRET && now - lastFullIg >= 1800000) {
    lastFullIg = now;
    if (now - Number((await getSet('ig_full_sync')) || 0) > 1800000) { await setSet('ig_full_sync', now); await kick('/api/sync-instagram'); }
  }

  res.setHeader('Cache-Control', 's-maxage=2, stale-while-revalidate=2');
  return res.status(200).json({ youtube: yt ? Number(yt.count) : null, instagram: ig ? Number(ig.count) : null, ts: now });
}

module.exports = async (req, res) => {
  try { return await handler(req, res); } catch (e) { console.error('live-stats failed', e.message); return res.status(200).json({}); }
};
