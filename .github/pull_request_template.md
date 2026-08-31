## What changed

<!-- Describe the user-visible outcome and the affected platforms. -->

## Release gates

- [ ] `npm run check` passes.
- [ ] Android CI passes when the shared room contract changes.
- [ ] New database migrations were applied to staging before the Worker.
- [ ] `/service/capabilities` exposes only complete RTC + messaging + file routes.
- [ ] No production secret, service-role key, signing key, or provider secret is committed.
- [ ] Rollback impact and quota impact were reviewed.
