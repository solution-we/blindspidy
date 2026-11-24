// POST /api/famgateway-webhook — verifies X-FamGateway-Signature (HMAC-SHA256 of the raw body,
// keyed with the merchant API key), then confirms the order server-to-server before crediting it.
const crypto = require('crypto');
const { rest, settle } = require('./_lib/shared');

const readRaw = (req) => new Promise((ok, no) => {
  const c = [];
  req.on('data', (x) => c.push(x));
  req.on('end', () => ok(Buffer.concat(c)));
  req.on('error', no);
});

const logEvent = (row) =>
  rest('payment_events', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) }).catch(() => {});

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');
  const raw = await readRaw(req);
  const sig = String(req.headers['x-famgateway-signature'] || '');
  const expected = crypto.createHmac('sha256', process.env.FAMGATEWAY_API_KEY).update(raw).digest('hex');
  const valid = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));

  if (!valid) {
    await logEvent({ event_type: 'invalid_signature', signature_verified: false, processing_status: 'rejected' });
    return res.status(401).send('Invalid signature');
  }

  let p;
  try { p = JSON.parse(raw.toString('utf8')); } catch (_) { return res.status(400).send('Bad JSON'); }
  const orderId = String(p.order_id || '');
  if (p.event !== 'payment.success' || !/^[A-Za-z0-9_]{4,40}$/.test(orderId)) {
    await logEvent({ order_id: orderId || null, event_type: String(p.event || 'unknown'), signature_verified: true, processing_status: 'ignored' });
    return res.status(200).json({ status: 'ignored' });
  }

  // Payload is not trusted for crediting: settle() re-verifies with FamGateway and the DB function is idempotent.
  const out = await settle(orderId);
  const result = out.status === 'success' ? out.result : out.status;
  await logEvent({
    order_id: orderId, event_type: p.event, transaction_id: p.transaction_id || null, utr: p.utr || null,
    signature_verified: true, processing_status: String(result), processed_at: new Date().toISOString(),
  });

  // Ask FamGateway to retry later if verification was unavailable
  if (out.status === 'unknown' || out.status === 'pending') return res.status(503).send('Verification unavailable');
  return res.status(200).json({ status: result });
};

module.exports.config = { api: { bodyParser: false } };
