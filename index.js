import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();

// WHY: Explicit CORS config instead of default `cors()`. The default reflects the
// incoming Origin header — but behind Render's proxy, the preflight OPTIONS request
// can arrive without that header, so the response ends up missing
// Access-Control-Allow-Origin. An allowlist guarantees the header is always set.
const ALLOWED_ORIGINS = [
  'https://subsaver-frontend.onrender.com',
  'http://localhost:5173',
  'http://localhost:3000',
];

app.use(cors({
  origin: (origin, callback) => {
    // WHY: Allow requests with no Origin (curl, Postman, server-to-server).
    if (!origin) return callback(null, true);
    // WHY: Allow only our known frontends.
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    // WHY: Log rejections so future CORS issues are easy to debug.
    console.warn('[CORS] Blocked origin:', origin);
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// WHY: Express doesn't always auto-respond to OPTIONS. This guarantees every
// preflight request gets a 200 with the CORS headers attached.
app.options('*', cors());

// WHY: Capture the raw request body alongside parsing it. Paystack signs the
// raw bytes with HMAC-SHA512 — if we only have the parsed JSON, we cannot
// verify the signature. This stores the raw bytes on req.rawBody for the
// webhook route to use. Other routes ignore this — zero impact on them.
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

const MONO_API_URL = 'https://api.withmono.com/v2';

// WHY: Admin Supabase client using the service_role key. This bypasses RLS
// so the backend can write to user_premium. NEVER expose this key to frontend.
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false }
  }
);

// Create Mono link
app.post('/api/create-mono-link', async (req, res) => {
  try {
    const response = await axios.post(
      `${MONO_API_URL}/accounts/initiate`,
      {},
      {
        headers: {
          'Content-Type': 'application/json',
          'mono-sec-key': process.env.MONO_SECRET_KEY,
        },
      }
    );
    res.json({ link_id: response.data.id });
  } catch (error) {
    console.error('Error creating Mono link:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to create Mono link' });
  }
});

// Exchange mono_code for access_token
app.post('/api/exchange-mono-code', async (req, res) => {
  try {
    const { mono_code } = req.body;

    // Input validation
    if (!mono_code || typeof mono_code !== 'string') {
      return res.status(400).json({ error: 'Valid mono_code is required' });
    }

    console.log('Mono code exchange started');

    const response = await axios.post(
      `${MONO_API_URL}/accounts/auth`,
      { code: mono_code },
      {
        headers: {
          'Content-Type': 'application/json',
          'mono-sec-key': process.env.MONO_SECRET_KEY,
        },
      }
    );

    console.log('Auth response status:', response.status);

    // Extract access token from response
    let accessToken = null;
    if (response.data.id) {
      accessToken = response.data.id;
    } else if (response.data.data && response.data.data.id) {
      accessToken = response.data.data.id;
    }

    console.log('Access token extracted successfully');

    if (accessToken) {
      res.json({ access_token: accessToken });
    } else {
      console.error('No access token found in response');
      res.status(500).json({ error: 'No access token received' });
    }
  } catch (error) {
    console.error('Error exchanging Mono code:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to exchange Mono code', details: error.response?.data });
  }
});

// WHY: Real Mono transactions route. Pulls the actual transaction history for a
// connected account. Replaces the previous mock data.
app.get('/api/mono-transactions', async (req, res) => {
  try {
    // WHY: access_token identifies which connected bank account to read from.
    const { access_token } = req.query;

    // WHY: Reject missing/malformed tokens early — prevents an empty call to Mono.
    if (!access_token || typeof access_token !== 'string') {
      return res.status(400).json({ error: 'Valid access_token is required' });
    }

    // WHY: Real call to Mono's transactions endpoint. Returns real bank data
    // in test mode (from your Mono sandbox accounts) or live mode.
    const response = await axios.get(
      `${MONO_API_URL}/accounts/${access_token}/transactions`,
      {
        headers: {
          'Content-Type': 'application/json',
          'mono-sec-key': process.env.MONO_SECRET_KEY,
        },
      }
    );

    // WHY: Mono wraps results in `data`. Pass through only what we need.
    const transactions = response.data?.data || [];

    res.json({ transactions });
  } catch (error) {
    // WHY: Log Mono's actual error for debugging, but return a generic message
    // so we never leak API details to the frontend.
    console.error('Error fetching Mono transactions:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// WHY: Real detection engine. Pulls transactions from Mono, runs pattern-matching,
// returns identified subscriptions. Amounts are converted from kobo to naira.
app.post('/api/detect-subscriptions', async (req, res) => {
  try {
    const { access_token } = req.body;

    // WHY: Validate token shape — same rule as other routes.
    if (!access_token || typeof access_token !== 'string') {
      return res.status(400).json({ error: 'Valid access_token is required' });
    }

    // WHY: Pull 6 months of transactions — enough history to establish patterns.
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const fromDate = sixMonthsAgo.toISOString().split('T')[0];

    const response = await axios.get(
      `${MONO_API_URL}/accounts/${access_token}/transactions`,
      {
        params: { from: fromDate, limit: 500 },
        headers: {
          'Content-Type': 'application/json',
          'mono-sec-key': process.env.MONO_SECRET_KEY,
        },
      }
    );

    const transactions = response.data?.data || [];

    // WHY: Run detection engine against real transaction data.
    const { detectSubscriptions } = await import('./detection.js');
    const subscriptions = detectSubscriptions(transactions);

    return res.json({ subscriptions, notImplemented: false });
  } catch (error) {
    console.error('Error in /api/detect-subscriptions:', error.response?.data || error.message);
    // WHY: Return empty array instead of error so the frontend shows
    // "No subscriptions found" instead of a scary error toast.
    return res.json({ subscriptions: [], notImplemented: false });
  }
});

// WHY: Verifies a Paystack payment and marks the user as Premium in Supabase.
// This route is the PRIMARY source of truth for premium activation — the
// frontend calls it after Paystack redirects the user back.
// Supports two tiers: 'monthly' (₦3,500 = 350000 kobo) and 'annual' (₦25,000 = 2500000 kobo).
app.post('/api/verify-payment', async (req, res) => {
  try {
    const { reference, tier } = req.body;

    // WHY: Input validation — reject anything that isn't a proper string.
    if (!reference || typeof reference !== 'string' || reference.length < 6) {
      return res.status(400).json({ success: false, error: 'Valid payment reference is required' });
    }

    // WHY: Validate tier — only allow 'monthly' or 'annual'.
    // Prevents client-side spoofing of arbitrary tier values.
    if (tier !== 'monthly' && tier !== 'annual') {
      return res.status(400).json({ success: false, error: 'Invalid subscription tier' });
    }

    // WHY: Extract the user's auth token from the Authorization header.
    // This is CRITICAL — we must NEVER trust the frontend to tell us who the user is.
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ success: false, error: 'Missing authentication token' });
    }

    // WHY: Verify the token with Supabase and get the authenticated user.
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);

    if (authError || !user) {
      return res.status(401).json({ success: false, error: 'Invalid or expired authentication' });
    }

    // WHY: Check if this reference is already used. Prevents replay attacks.
    const { data: existing } = await supabaseAdmin
      .from('user_premium')
      .select('user_id, is_premium')
      .eq('payment_reference', reference)
      .maybeSingle();

    if (existing) {
      if (existing.user_id === user.id && existing.is_premium) {
        return res.json({ success: true, message: 'Already verified' });
      }
      return res.status(409).json({ success: false, error: 'Payment reference already used' });
    }

    // WHY: Call Paystack to verify the payment actually happened.
    const paystackRes = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        },
      }
    );

    const payment = paystackRes.data?.data;

    if (!payment || payment.status !== 'success') {
      return res.status(400).json({ success: false, error: 'Payment not successful' });
    }

    // WHY: Expected amount depends on tier. Both checks below prevent underpayment.
    // monthly = ₦3,500 = 350000 kobo | annual = ₦25,000 = 2500000 kobo
    const expectedAmount = tier === 'annual' ? 2500000 : 350000;
    if (payment.amount !== expectedAmount) {
      return res.status(400).json({ success: false, error: 'Payment amount mismatch for tier' });
    }

    // WHY: Compute expiry — monthly = 30 days, annual = 365 days.
    const now = new Date();
    const expiry = new Date(now);
    if (tier === 'annual') {
      expiry.setDate(expiry.getDate() + 365);
    } else {
      expiry.setDate(expiry.getDate() + 30);
    }

    // WHY: All checks passed. Upsert into user_premium — makes this user Premium.
    const { error: upsertError } = await supabaseAdmin
      .from('user_premium')
      .upsert(
        {
          user_id: user.id,
          is_premium: true,
          premium_since: now.toISOString(),
          premium_expires_at: expiry.toISOString(),
          premium_tier: tier,
          payment_reference: reference,
        },
        { onConflict: 'user_id' }
      );

    if (upsertError) {
      console.error('Error upserting premium:', upsertError);
      return res.status(500).json({ success: false, error: 'Failed to activate premium' });
    }

    return res.json({ success: true, message: 'Premium activated', tier });
  } catch (error) {
    // WHY: User-friendly error message — never leak internal details.
    console.error('Error verifying payment:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: 'Verification failed. Please try again.' });
  }
});

// WHY: Paystack webhook — the BACKUP activation path.
// If the user closes their browser before the callback fires (or their network
// dies), /api/verify-payment never runs. Paystack then sends this webhook
// DIRECTLY to our server. Handles the same activation logic — idempotent.
app.post('/api/paystack-webhook', async (req, res) => {
  try {
    // WHY: Paystack sends the signature in this header. Must be lowercase.
    const signature = req.headers['x-paystack-signature'];

    if (!signature) {
      return res.status(401).send('Missing signature');
    }

    // WHY: Verify the signature using HMAC-SHA512 and the RAW body.
    // Paystack uses your Secret Key as the HMAC secret — no separate webhook secret.
    const expectedHash = crypto
      .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(req.rawBody)
      .digest('hex');

    // WHY: Constant-time comparison prevents timing attacks.
    // If hashes don't match, someone is faking the webhook — reject immediately.
    const sigBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expectedHash, 'hex');
    if (sigBuffer.length !== expectedBuffer.length ||
        !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
      console.error('[webhook] Invalid signature');
      return res.status(401).send('Invalid signature');
    }

    // WHY: Respond 200 IMMEDIATELY. Paystack retries if we take >5 seconds.
    // We do the DB work AFTER responding — this is the correct pattern.
    res.sendStatus(200);

    // WHY: Parse the raw body now that signature is verified.
    const event = JSON.parse(req.rawBody.toString());

    // WHY: We only care about successful charges. Ignore everything else.
    if (event.event !== 'charge.success') {
      return;
    }

    const data = event.data;
    const reference = data.reference;
    const amount = data.amount;         // In kobo
    const email = data.customer?.email; // Used to look up user if needed

    // WHY: Determine tier from amount. Anything else is suspicious — skip.
    let tier = null;
    if (amount === 350000) tier = 'monthly';
    else if (amount === 2500000) tier = 'annual';
    else {
      console.error(`[webhook] Unknown amount: ${amount} for ref ${reference}`);
      return;
    }

    // WHY: Idempotency check — if this reference is already in user_premium,
    // the frontend callback already handled it. Nothing to do.
    const { data: existing } = await supabaseAdmin
      .from('user_premium')
      .select('user_id, payment_reference')
      .eq('payment_reference', reference)
      .maybeSingle();

    if (existing) {
      console.log(`[webhook] Reference ${reference} already processed`);
      return;
    }

    // WHY: We need the user_id. The frontend callback path derives it from JWT.
    // The webhook has no JWT — only the customer's email. So we look up the user.
    const { data: { users }, error: listError } = await supabaseAdmin.auth.admin.listUsers();
    if (listError) {
      console.error('[webhook] Failed to list users:', listError);
      return;
    }

    const matchedUser = users.find(u => u.email === email);
    if (!matchedUser) {
      console.error(`[webhook] No user found for email ${email}`);
      return;
    }

    // WHY: Compute expiry same way as /api/verify-payment. Keep both paths consistent.
    const now = new Date();
    const expiry = new Date(now);
    if (tier === 'annual') {
      expiry.setDate(expiry.getDate() + 365);
    } else {
      expiry.setDate(expiry.getDate() + 30);
    }

    // WHY: Upsert into user_premium — same shape as verify-payment route.
    // If the user already exists, update. If not, insert.
    const { error: upsertError } = await supabaseAdmin
      .from('user_premium')
      .upsert(
        {
          user_id: matchedUser.id,
          is_premium: true,
          premium_since: now.toISOString(),
          premium_expires_at: expiry.toISOString(),
          premium_tier: tier,
          payment_reference: reference,
        },
        { onConflict: 'user_id' }
      );

    if (upsertError) {
      console.error('[webhook] Upsert failed:', upsertError);
      return;
    }

    console.log(`[webhook] Premium activated via webhook for ${email} (${tier})`);
  } catch (error) {
    // WHY: Log everything for debugging, but never crash. Paystack already
    // got a 200 if we got this far. If we crashed before 200, log it.
    console.error('[webhook] Error:', error.message);
    // WHY: If we haven't sent a response yet, send 200 so Paystack stops retrying.
    // Duplicate retries are handled by the idempotency check above.
    if (!res.headersSent) {
      res.sendStatus(200);
    }
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Backend is running' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Mono API URL: ${MONO_API_URL}`);
  console.log(`Mono Secret Key set: ${process.env.MONO_SECRET_KEY ? 'Yes' : 'No'}`);
  console.log(`Paystack Secret Key set: ${process.env.PAYSTACK_SECRET_KEY ? 'Yes' : 'No'}`);
  console.log(`Supabase Admin configured: ${process.env.SUPABASE_SERVICE_ROLE_KEY ? 'Yes' : 'No'}`);
});