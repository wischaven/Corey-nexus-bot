'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY       = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env');
  process.exit(1);
}

// Public client — respects Row Level Security (use for user requests)
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Admin client — bypasses RLS (use only in server-side trusted code)
const supabaseAdmin = SERVICE_KEY
  ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

// ─── Verify JWT from Authorization header ─────────────────────────────────
// Returns { user, error }
async function verifyToken(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { user: null, error: 'Missing token' };
  }
  const token = authHeader.slice(7);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return { user: null, error: error?.message || 'Invalid token' };
  return { user: data.user, error: null };
}

// ─── Express middleware — attaches req.user or returns 401 ────────────────
async function requireAuth(req, res, next) {
  const { user, error } = await verifyToken(req);
  if (!user) return res.status(401).json({ error: error || 'Unauthorized' });
  req.user = user;
  next();
}

// ─── Get user plan from user_settings ─────────────────────────────────────
async function getUserPlan(userId) {
  const { data } = await supabase
    .from('user_settings')
    .select('plan, ticker')
    .eq('user_id', userId)
    .single();
  return data || { plan: 'free', ticker: 'XRPUSD' };
}

// ─── Owner bypass — always elite ─────────────────────────────────────────
const OWNER_EMAIL = process.env.OWNER_EMAIL || '';

function isOwner(user) {
  return user?.email === OWNER_EMAIL;
}

module.exports = { supabase, supabaseAdmin, requireAuth, verifyToken, getUserPlan, isOwner };
