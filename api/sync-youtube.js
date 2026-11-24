// GET (Vercel cron) or POST (admin "Sync Now") /api/sync-youtube
// Pulls subscriber count and uploads from the official YouTube Data API into Supabase.
const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sbh = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

async function authorized(req) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  if (!t) return false;
  if (process.env.CRON_SECRET && t === process.env.CRON_SECRET) return true; // Vercel cron
  const u = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${t}` } });
  if (!u.ok) return false;
  const { id } = await u.json();
  const p = await fetch(`${SB}/rest/v1/profiles?select=role&id=eq.${id}`, { headers: sbh });
  return p.ok && (await p.json())[0]?.role === 'admin';
}

async function yt(path, params) {
  const q = new URLSearchParams({ ...params, key: process.env.YOUTUBE_API_KEY });
  const r = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${q}`);
  if (!r.ok) throw new Error(`YouTube API error ${r.status}`);
  return r.json();
}

function duration(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '') || [];
  const h = +m[1] || 0, mi = +m[2] || 0, s = +m[3] || 0;
  const pad = (x) => String(x).padStart(2, '0');
  return { sec: h * 3600 + mi * 60 + s, text: h ? `${h}:${pad(mi)}:${pad(s)}` : `${mi}:${pad(s)}` };
}

module.exports = async (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!(await authorized(req))) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const ch = await yt('channels', {
      part: 'statistics,contentDetails',
      forHandle: process.env.YOUTUBE_HANDLE || '@blindspidey',
    });
    const c = ch.items?.[0];
    if (!c) throw new Error('Channel not found. Check YOUTUBE_HANDLE.');
    const subs = c.statistics.hiddenSubscriberCount ? null : Number(c.statistics.subscriberCount);

    // Collect up to 200 latest uploads
    const uploads = c.contentDetails.relatedPlaylists.uploads;
    const ids = [];
    let token;
    for (let i = 0; i < 4; i++) {
      const pl = await yt('playlistItems', {
        part: 'contentDetails', playlistId: uploads, maxResults: '50', ...(token ? { pageToken: token } : {}),
      });
      ids.push(...pl.items.map((x) => x.contentDetails.videoId));
      token = pl.nextPageToken;
      if (!token) break;
    }

    const rows = [];
    for (let i = 0; i < ids.length; i += 50) {
      const v = await yt('videos', {
        part: 'snippet,contentDetails,statistics,liveStreamingDetails', id: ids.slice(i, i + 50).join(','),
      });
      for (const x of v.items) {
        const d = duration(x.contentDetails.duration);
        const live = !!x.liveStreamingDetails;
        const kind = live ? 'live' : d.sec <= 60 ? 'short' : 'video'; // Shorts are detected by length (<= 60s)
        const th = x.snippet.thumbnails;
        rows.push({
          platform: 'youtube', kind, external_id: x.id, title: x.snippet.title,
          thumbnail_url: (th.maxres || th.high || th.medium || th.default).url,
          duration: live && !d.sec ? null : d.text,
          view_count: Number(x.statistics.viewCount || 0),
          url: kind === 'short' ? `https://www.youtube.com/shorts/${x.id}` : `https://www.youtube.com/watch?v=${x.id}`,
          published_at: x.liveStreamingDetails?.actualStartTime || x.snippet.publishedAt,
          manual: false, // "visible" is left out so hidden videos stay hidden
        });
      }
    }

    if (rows.length) {
      const up = await fetch(`${SB}/rest/v1/videos?on_conflict=platform,external_id`, {
        method: 'POST', headers: { ...sbh, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows),
      });
      if (!up.ok) throw new Error('Could not save videos');
    }

    const stat = { manual: false, status: subs === null ? 'hidden' : 'synced', last_synced_at: new Date().toISOString() };
    if (subs !== null) stat.count = subs;
    await fetch(`${SB}/rest/v1/social_stats?platform=eq.youtube`, { method: 'PATCH', headers: sbh, body: JSON.stringify(stat) });

    return res.status(200).json({ ok: true, videos: rows.length, subscribers: subs });
  } catch (err) {
    await fetch(`${SB}/rest/v1/social_stats?platform=eq.youtube`, {
      method: 'PATCH', headers: sbh, body: JSON.stringify({ status: 'error' }),
    }).catch(() => {});
    return res.status(500).json({ error: err.message });
  }
};
