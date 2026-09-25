import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

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
// NOTE: This is NOT yet wired to detection — Session 1B adds the pattern matcher.
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
          'mono-sec-key': process.env.MONO_SECRET_KEY, // WHY: Auth for Mono's API — server-side only.
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

// WHY: Placeholder for the real detection engine (Session 1B).
// For now it returns an empty list so the frontend stops showing fabricated data.
// When Session 1B lands, this route will call the detection module, run pattern
// matching on real Mono transactions, and return actual subscriptions.
app.post('/api/detect-subscriptions', async (req, res) => {
  try {
    // WHY: Validate the access_token shape — same rule as the transactions route.
    const { access_token } = req.body;
    if (!access_token || typeof access_token !== 'string') {
      return res.status(400).json({ error: 'Valid access_token is required' });
    }

    // WHY: Detection engine not yet built — be honest, don't fabricate.
    // The frontend will show "no subscriptions found" until this is implemented.
    return res.json({
      subscriptions: [],
      notImplemented: true,
      message: 'Detection engine coming in next build.',
    });
  } catch (error) {
    console.error('Error in /api/detect-subscriptions:', error.message);
    res.status(500).json({ error: 'Failed to detect subscriptions' });
  }
});

// WHY: Verifies a Paystack payment and marks the user as Premium in Supabase.
// This route is the SINGLE source of truth for premium activation — the
// frontend cannot grant premium on its own.
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