-- The authentication gateway updates a user's profile only after it verifies
-- that user's Supabase access token and recent one-time onboarding code.
-- RLS bypass alone does not grant table privileges, so grant the gateway's
-- service role the two operations used by onboarding and account repair.
grant select, update on table public.profiles to service_role;
