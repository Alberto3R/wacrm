-- ============================================================
-- 027_account_switcher.sql — multi-brand account switching
--
-- The app is single-tenant-per-user: every table filters by the
-- caller's `profiles.account_id` through `is_account_member()`
-- (which checks `profiles.user_id = auth.uid() AND
-- profiles.account_id = target`). We KEEP that model and add a thin
-- switching layer so one login can operate several brands (Sales 3R,
-- AUGRA, Elas que Vendem), each its own account + WhatsApp number:
--
--   1. `account_members(account_id, user_id, role)` — the N:N roster
--      of which accounts a user may switch into. NOT used by the data
--      RLS (those still key off profiles.account_id); it's the
--      allow-list the switcher validates against.
--   2. `switch_account(target)` — moves `profiles.account_id` (and the
--      matching `account_role`) to a target the caller is a member of.
--      After the move, every existing policy naturally scopes the user
--      to the new account's data + WhatsApp config. Zero policy rewrites.
--   3. A SELECT policy on `accounts` so a member can read the *names*
--      of all accounts they belong to (the switcher needs them), not
--      just the active one.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- 0. Relax one-account-per-owner --------------------------------
-- Migration 017 created `idx_accounts_one_per_owner` and noted it
-- "drops automatically if we ever relax to many-to-many." That's now:
-- a single login (owner) operates several brand accounts.
DROP INDEX IF EXISTS public.idx_accounts_one_per_owner;

-- 1. Roster table -------------------------------------------------
CREATE TABLE IF NOT EXISTS public.account_members (
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       public.account_role_enum NOT NULL DEFAULT 'agent',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id)
);

ALTER TABLE public.account_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "members read own memberships" ON public.account_members;
CREATE POLICY "members read own memberships" ON public.account_members
  FOR SELECT USING (user_id = auth.uid());

-- Backfill: every existing profile is a member of its current account.
INSERT INTO public.account_members (account_id, user_id, role)
SELECT account_id, user_id, account_role FROM public.profiles
ON CONFLICT (account_id, user_id) DO NOTHING;

-- 2. Let members read the accounts they belong to -----------------
-- The 017 policies only expose the ACTIVE account (via
-- is_account_member → profiles.account_id). The switcher needs the
-- names of the others too. Additive (policies OR together).
DROP POLICY IF EXISTS "members can read their accounts" ON public.accounts;
CREATE POLICY "members can read their accounts" ON public.accounts
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.account_members m
      WHERE m.account_id = accounts.id AND m.user_id = auth.uid()
    )
  );

-- 3. switch_account — move the caller's active account ------------
CREATE OR REPLACE FUNCTION public.switch_account(target_account_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role account_role_enum;
BEGIN
  SELECT role INTO v_role
  FROM public.account_members
  WHERE user_id = auth.uid() AND account_id = target_account_id;

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'forbidden: not a member of account %', target_account_id;
  END IF;

  UPDATE public.profiles
  SET account_id = target_account_id,
      account_role = v_role,
      updated_at = now()
  WHERE user_id = auth.uid();
END;
$$;

GRANT EXECUTE ON FUNCTION public.switch_account(uuid) TO authenticated;

-- 4. Keep the roster in sync on new signups -----------------------
-- handle_new_user already creates the account + profile; mirror the
-- owner row into the roster so a fresh user is a member of their own
-- account (and the switcher works for them out of the box).
CREATE OR REPLACE FUNCTION public.add_owner_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.account_members (account_id, user_id, role)
  VALUES (NEW.account_id, NEW.user_id, NEW.account_role)
  ON CONFLICT (account_id, user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_sync_membership ON public.profiles;
CREATE TRIGGER profiles_sync_membership
  AFTER INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.add_owner_membership();
