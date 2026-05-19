'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY       = process.env.SUPABASE_SERVICE_KEY;

const _supabaseReady = !!(SUPABASE_URL && SUPABASE_ANON_KEY);
if (!_supabaseReady) {
  console.warn('[supabase] SUPABASE_URL / SUPABASE_ANON_KEY not set — auth disabled, running in open mode');
}

// No-op stub so proxy.js calls never throw when Supabase is unconfigured
const _noop = { data: null, error: null };
const _noopChain = { select:()=>_noopChain, insert:()=>Promise.resolve(_noop), upsert:()=>Promise.resolve(_noop), update:()=>Promise.resolve(_noop), eq:()=>_noopChain, in:()=>_noopChain, order:()=>_noopChain, limit:()=>_noopChain, single:()=>Promise.resolve(_noop) };
const _supabaseStub = { from:()=>_noopChain, auth:{ signUp:()=>Promise.resolve(_noop), signInWithPassword:()=>Promise.resolve(_noop), getUser:()=>Promise.resolve(_noop) } };

// Public client — respects Row Level Security (use for user requests)
const supabase = _supabaseReady ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : _supabaseStub;

// Admin client — bypasses RLS (use only in server-side trusted code)
const supabaseAdmin = (SERVICE_KEY && _supabaseReady)
  ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : _supabaseStub;

// ─── Verify JWT from Authorization header ─────────────────────────────────
// Returns { user, error }
async function verifyToken(req) {
  if (!_supabaseReady) return { user: { id: 'local', email: process.env.OWNER_EMAIL || 'local' }, error: null };

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { user: null, error: 'Missing token' };
  }
  const token = authHeader.slice(7);
  if (!token) return { user: null, error: 'Empty token' };

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) return { user: null, error: error?.message || 'Invalid token' };
    return { user: data.user, error: null };
  } catch (e) {
    return { user: null, error: e.message };
  }
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
  if (!_supabaseReady) return { plan: 'elite', ticker: 'XRPUSD' };
  const { data } = await supabaseAdmin
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
