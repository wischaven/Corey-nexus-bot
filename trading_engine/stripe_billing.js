'use strict';

require('dotenv').config();

const https = require('https');

const SECRET_KEY      = process.env.STRIPE_SECRET_KEY;
const WEBHOOK_SECRET  = process.env.STRIPE_WEBHOOK_SECRET;
const PRICE_PRO       = process.env.STRIPE_PRICE_PRO;
const PRICE_ELITE     = process.env.STRIPE_PRICE_ELITE;

const PLAN_PRICES = { pro: PRICE_PRO, elite: PRICE_ELITE };

// ─── Raw Stripe API call ───────────────────────────────────────────────────
function stripeRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    if (!SECRET_KEY) return reject(new Error('STRIPE_SECRET_KEY not set in .env'));
    const payload = body ? new URLSearchParams(body).toString() : '';
    const opts = {
      hostname: 'api.stripe.com',
      path: '/v1/' + path,
      method,
      headers: {
        'Authorization': 'Bearer ' + SECRET_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Create or retrieve Stripe customer ───────────────────────────────────
async function getOrCreateCustomer(email, userId) {
  const search = await stripeRequest('GET', `customers/search?query=metadata['userId']:'${userId}'&limit=1`);
  if (search.data && search.data.length > 0) return search.data[0];
  return stripeRequest('POST', 'customers', { email, 'metadata[userId]': userId });
}

// ─── Create a checkout session ────────────────────────────────────────────
async function createCheckoutSession({ email, userId, plan, successUrl, cancelUrl }) {
  const priceId = PLAN_PRICES[plan];
  if (!priceId) throw new Error(`No price ID configured for plan: ${plan}`);

  const customer = await getOrCreateCustomer(email, userId);

  return stripeRequest('POST', 'checkout/sessions', {
    customer: customer.id,
    mode: 'subscription',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    success_url: successUrl + '?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: cancelUrl,
    'subscription_data[metadata][userId]': userId,
    'subscription_data[metadata][plan]': plan,
    allow_promotion_codes: 'true',
  });
}

// ─── Create a billing portal session (manage/cancel subscription) ─────────
async function createPortalSession({ email, userId, returnUrl }) {
  const customer = await getOrCreateCustomer(email, userId);
  return stripeRequest('POST', 'billing_portal/sessions', {
    customer: customer.id,
    return_url: returnUrl,
  });
}

// ─── Verify Stripe webhook signature ─────────────────────────────────────
function verifyWebhookSignature(rawBody, sigHeader) {
  if (!WEBHOOK_SECRET) return null;
  const crypto = require('crypto');
  const parts = sigHeader.split(',').reduce((acc, part) => {
    const [k, v] = part.split('=');
    acc[k] = v;
    return acc;
  }, {});
  const timestamp = parts.t;
  const sig = parts.v1;
  if (!timestamp || !sig) return null;
  const tolerance = 300; // 5 min
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > tolerance) return null;
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  if (expected !== sig) return null;
  try { return JSON.parse(rawBody); }
  catch (e) { return null; }
}

module.exports = {
  createCheckoutSession,
  createPortalSession,
  verifyWebhookSignature,
  PLAN_PRICES,
};
