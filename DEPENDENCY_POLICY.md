# Dependency Policy

- Lock every production and build dependency with the repository lock mechanism.
- Use official registries and known maintainers; do not add abandoned or unnecessary packages.
- CI must install from lockfiles and run the applicable test/build/lint gates.
- Run `npm audit` for JavaScript repositories and pinned `pip-audit` for Python build requirements.
- Android dependencies must pass Gradle compilation/lint; add a compatible OSV or OWASP dependency scanner before production if CI does not already provide one.
- Rust must pass `cargo test` and format checks; run `cargo audit` in security CI when the tool is available.
- Critical/high advisories affecting a reachable production path block release. Dev-only findings require documented reachability analysis and prompt upgrade.
- Avoid blind major upgrades. Update in a branch, read upstream release/security notes, run the complete matrix, and use a rollback-ready release.
- Review Cloudflare, Supabase, LAVA, Patreon, Firebase, realtime-provider, PyInstaller, and yt-dlp changes monthly and before release.
- Store server secrets only in provider secret stores. Never place real secrets in source, examples, logs, desktop bundles, APKs, or issue text.
- Generate an SBOM or equivalent dependency export for signed production releases when the release pipeline supports it.
