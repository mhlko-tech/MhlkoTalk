# MHTalk release runbook

## Required order

1. Create isolated Supabase, KV and Durable Object resources for staging. Copy
   `worker/wrangler.staging.example.toml` outside version control and replace
   every placeholder.
2. Apply all Supabase migrations to staging, including room attachments and RTC
   internal metering. Confirm the attachment bucket is private.
3. Configure Worker secrets with `wrangler secret put`. Never put service-role,
   provider, Firebase, invite-signing or routing-admin secrets in a TOML file.
4. Deploy the Worker to staging and verify `GET /service/capabilities`. A route
   is releasable only when RTC, messaging and file providers are all supported
   by the exact Windows and Android builds being tested.
5. Run a two-device matrix for Main and private rooms: join/leave, microphone,
   camera, screen share, profile events, chat, typing, attachment upload,
   download, delete and expiry. Repeat once with the active provider disabled to
   verify failover.
6. Require green Windows and Android CI. Build signed release candidates, test
   upgrade from the prior public version, then promote the database migrations,
   Worker and clients in that order.

## Production guardrails

- Keep pay-as-you-go and automatic top-ups disabled at every provider.
- Enable a provider policy only after its credentials, quota limit and reset
  date are verified in the provider dashboard.
- Keep unreleased providers `adapterReady = false`; credentials alone never make
  a provider routable.
- Review `rtc_provider_health_snapshot()` after deployment. Stream uses a
  conservative 4K price ceiling, participant-minute providers use signed
  one-minute heartbeats, and Cloudflare uses Durable Object egress accounting.
- Do not release Android Plus purchases through Google Play until Play Billing
  or an approved alternative-billing program is implemented.

## Rollback

1. Disable the affected provider in `rtc_provider_policies`; the scheduled
   health sync removes it from new routing assignments.
2. Roll the Worker back to the last known-good deployment. Database migrations
   are additive; do not drop attachment or usage tables during an incident.
3. Re-publish the previous signed client only if the shared capability contract
   is incompatible. Capability version 2 normally lets old clients fail closed
   without a forced rollback.
