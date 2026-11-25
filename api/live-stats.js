// GET /api/live-stats — public. Returns subscriber/follower counts and keeps them fresh:
//  - refreshes the YouTube subscriber count at most every 2 minutes (1 quota unit)
//  - triggers a full video + playlist sync at most every 30 minutes
const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sbh = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const rest = (path, opt = {}) => fetch(`${SB}/rest/v1/${path}`, { ...opt, headers: { ...sbh, ...(opt.headers || {}) } });
const getSet = async (k) => { const r = await rest(`site_settings?select=value&key=eq.${k}`); return r.ok ? ((await r.json())[0] || {}).value : null; };
const setSet = (k, v) => rest('site_settings?on_conflict=key', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ key: k, value: v }) });

async function handler(req, res) {
  if (!SB || !KEY) return res.status(200).json({});
  const now = Date.now();
  const stats = async () => {
    const r = await rest('social_stats?select=platform,count,manual,status');
    return r.ok ? await r.json() : [];
  };

  let rows = await stats();
  const yt = rows.find((x) => x.platform === 'youtube');
  const manualOnly = yt && yt.manual && yt.status === 'manual'; // admin typed a number by hand: do not overwrite

  if (process.env.YOUTUBE_API_KEY && !manualOnly && now - Number((await getSet('yt_subs_checked')) || 0) > 120000) {
    await setSet('yt_subs_checked', now);
    try {
      const q = new URLSearchParams({ part: 'statistics', forHandle: process.env.YOUTUBE_HANDLE || '@blindspidey', key: process.env.YOUTUBE_API_KEY });
      const r = await fetch(`https://www.googleapis.com/youtube/v3/channels?${q}`);
      const c = r.ok ? ((await r.json()).items || [])[0] : null;
      if (c && !c.statistics.hiddenSubscriberCount) {
        await rest('social_stats?platform=eq.youtube', {
          method: 'PATCH', body: JSON.stringify({ count: Number(c.statistics.subscriberCount), manual: false, status: 'synced', last_synced_at: new Date().toISOString() }),
        });
      }
    } catch (_) {}
  }

  if (process.env.CRON_SECRET && process.env.YOUTUBE_API_KEY && now - Number((await getSet('yt_full_sync')) || 0) > 1800000) {
    await setSet('yt_full_sync', now);
    try {
      const site = process.env.SITE_URL || `https://${req.headers.host}`;
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      await fetch(`${site}/api/sync-youtube`, { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` }, signal: ctl.signal });
      clearTimeout(t);
    } catch (_) {}
  }

  rows = await stats();
  const pick = (p) => { const x = rows.find((r) => r.platform === p); return x ? Number(x.count) : null; };
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
  return res.status(200).json({ youtube: pick('youtube'), instagram: pick('instagram') });
}

module.exports = async (req, res) => {
  try { return await handler(req, res); } catch (e) { console.error('live-stats failed', e.message); return res.status(200).json({}); }
};
