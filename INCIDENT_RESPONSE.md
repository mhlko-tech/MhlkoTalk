# Incident Response

## Severity

- **SEV-1:** confirmed secret/payment compromise, forged entitlements at scale, or unauthorized account access.
- **SEV-2:** exploitable authorization flaw, limited data disclosure, webhook bypass, or widespread service abuse.
- **SEV-3:** non-exploited weakness, dependency advisory, suspicious activity, or isolated availability problem.

## Immediate actions

1. Preserve relevant Cloudflare, Supabase, LAVA, Patreon, CI, and release evidence without copying secrets into tickets or chat.
2. Disable only the affected membership/provider path. Keep unrelated MHTalk call providers available when safe.
3. Revoke or rotate affected server secrets and OAuth credentials; invalidate affected link sessions and bearer tokens.
4. Reject webhook processing if signature trust is uncertain.
5. Reconcile subscription state directly against authoritative provider APIs.
6. Notify the owner with scope, time, affected versions/users, containment, and next update time.

## Recovery

- Patch and test in a non-production environment.
- Rebuild artifacts from a reviewed commit and re-run the complete release checklist.
- Restore the provider gradually while monitoring signature failures, link attempts, entitlement changes, and errors.
- Notify affected users when legally or operationally required.

## Post-incident

- Record timeline, root cause, detection gap, user impact, and corrective controls.
- Add a regression test for the exact failure.
- Review retention and remove incident copies containing personal data or credentials when no longer required.
- Review every credential that shared the same environment or release path.
