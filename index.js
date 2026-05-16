import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const MONO_API_URL = 'https://api.withmono.com/v2';

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
    console.log('Mono code received:', mono_code);
    
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
    console.log('Auth response data:', response.data);
    
    // Extract access token from response
    let accessToken = null;
    if (response.data.id) {
      accessToken = response.data.id;
    } else if (response.data.data && response.data.data.id) {
      accessToken = response.data.data.id;
    }
    
    console.log('Extracted access token:', accessToken);
    
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
    console.log('Fetching transactions for access_token:', access_token);
    
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
    
    console.log('Returning', mockTransactions.length, 'mock transactions');
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

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Backend is running' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Mono API URL: ${MONO_API_URL}`);
  console.log(`Mono Secret Key set: ${process.env.MONO_SECRET_KEY ? 'Yes' : 'No'}`);
});