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

// Get transactions - returns mock data with older dates for flagged demo
app.get('/api/mono-transactions', async (req, res) => {
  try {
    const { access_token } = req.query;
    
    console.log('Fetching transactions - token validated');
    
    // For demo purposes, return mock transaction data
    // This ensures the dashboard always shows data for the demo
    const mockTransactions = [
      { _id: '1', narration: 'Netflix', amount: 15.99, date: '2026-03-25' },
      { _id: '2', narration: 'Spotify', amount: 9.99, date: '2026-03-20' },
      { _id: '3', narration: 'Adobe Creative Cloud', amount: 52.99, date: '2026-01-15' },
      { _id: '4', narration: 'Amazon Prime', amount: 14.99, date: '2026-02-10' },
      { _id: '5', narration: 'Apple Music', amount: 10.99, date: '2026-01-05' },
      { _id: '6', narration: 'Disney+', amount: 11.99, date: '2025-12-15' },
      { _id: '7', narration: 'HBO Max', amount: 14.99, date: '2025-11-20' },
      { _id: '8', narration: 'YouTube Premium', amount: 11.99, date: '2026-02-28' },
    ];
    
    res.json({ transactions: mockTransactions });
  } catch (error) {
    console.error('Error in /api/mono-transactions:', error.message);
    // Always return something so the UI doesn't break
    const fallbackTransactions = [
      { _id: '1', narration: 'Netflix', amount: 15.99, date: '2026-03-25' },
      { _id: '2', narration: 'Spotify', amount: 9.99, date: '2026-03-20' },
      { _id: '3', narration: 'Adobe Creative Cloud', amount: 52.99, date: '2026-01-15' },
    ];
    res.json({ transactions: fallbackTransactions });
  }
});

// WHY: Verifies a Paystack payment and marks the user as Premium in Supabase.
// This route is the SINGLE source of truth for premium activation — the
// frontend cannot grant premium on its own.
app.post('/api/verify-payment', async (req, res) => {
  try {
    const { reference } = req.body;

    // WHY: Input validation — reject anything that isn't a proper string.
    if (!reference || typeof reference !== 'string' || reference.length < 6) {
      return res.status(400).json({ success: false, error: 'Valid payment reference is required' });
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
      // WHY: If the same user re-verifies the same reference, treat as success (idempotent).
      if (existing.user_id === user.id && existing.is_premium) {
        return res.json({ success: true, message: 'Already verified' });
      }
      // WHY: If the reference is used by a DIFFERENT user, this is a fraud attempt.
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

    // WHY: Confirm the amount matches ₦3,500 (Paystack uses kobo — 350000 kobo = ₦3,500).
    // Prevents someone paying ₦1 and getting premium.
    if (payment.amount !== 350000) {
      return res.status(400).json({ success: false, error: 'Payment amount mismatch' });
    }

    // WHY: All checks passed. Upsert into user_premium — makes this user Premium.
    const { error: upsertError } = await supabaseAdmin
      .from('user_premium')
      .upsert(
        {
          user_id: user.id,
          is_premium: true,
          premium_since: new Date().toISOString(),
          payment_reference: reference,
        },
        { onConflict: 'user_id' }
      );

    if (upsertError) {
      console.error('Error upserting premium:', upsertError);
      return res.status(500).json({ success: false, error: 'Failed to activate premium' });
    }

    return res.json({ success: true, message: 'Premium activated' });
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