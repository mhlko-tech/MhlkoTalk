# MHTalk architecture

MHTalk keeps platform code, domain rules, stateful services, and React UI in
separate layers. Dependencies should point toward `core`; UI code may call a
service, but services must not import React components.

## Desktop client

- `src/core`: pure types, validation, moderation, and media-quality rules.
  Subscription entitlements and provider-routing contracts also live here.
- `src/components`: small presentation primitives shared by features.
- `src/features/auth`: account registration, recovery, and OAuth screens.
- `src/features/chat`: attachment rendering and chat-specific helpers.
- `src/features/profile`: profile-photo editing and cropping.
- `src/features/room`: participant and room presentation.
- `src/services`: long-lived account, room, recording, and updater boundaries.
- `src/App.tsx`: application orchestration and top-level dialog state.
- `src-tauri`: trusted native Windows capabilities and recording implementation.

## Backend

- `worker/src`: the Cloudflare authentication, social, notification, and
  LiveKit-token boundary. Secrets are read only from Worker bindings.
- `supabase/migrations`: the ordered database contract. Never edit an applied
  migration; add a new migration instead.
- `docs/SERVICE_ROUTING.md`: active provider routes, failover activation rules,
  and the Free/Plus entitlement contract.

## Change rules

1. Put reusable business rules in `core`, not in a component event handler.
2. Keep network, persistence, and LiveKit lifecycle ownership inside services.
3. Keep feature-local UI in its feature directory and shared primitives in
   `components`.
4. Treat `src-tauri/gen`, `dist`, `target`, and dependency folders as generated
   output. Do not hand-edit or commit local build caches.
5. Run `npm run check` before merging a desktop or backend change.
