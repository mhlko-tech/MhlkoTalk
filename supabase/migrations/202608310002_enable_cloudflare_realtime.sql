-- Cloudflare Realtime SFU credentials are now provisioned. Its dedicated
-- Durable Object meters conservatively and fails closed before 60% of the
-- monthly 1,000 GB free allocation.

update public.rtc_provider_policies
set enabled = true,
    notes = 'Serverless SFU with a dedicated fail-closed egress guard; route stops before 600 GB of the 1,000 GB monthly free tier.',
    updated_at = now()
where provider = 'cloudflare-realtime';
