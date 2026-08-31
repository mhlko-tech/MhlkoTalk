-- LiveKit remains configured, but its current Cloud allowance was exhausted.
-- Keep the route fail-closed until the provider dashboard confirms a reset.

update public.rtc_provider_policies
set enabled = false,
    notes = 'Credentials and adapters remain configured, but the current LiveKit allowance is exhausted. Re-enable only after a verified provider-side quota reset.',
    updated_at = now()
where provider = 'livekit';
