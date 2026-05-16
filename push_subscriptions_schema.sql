-- Run this in Supabase SQL Editor:
-- Dashboard → SQL Editor → New Query → paste → Run

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  subscription text NOT NULL,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own push subscription"
  ON public.push_subscriptions
  FOR ALL USING (auth.uid() = user_id);
