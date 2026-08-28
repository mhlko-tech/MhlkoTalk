# MHTalk accounts, friends, and presence

The social layer deliberately stores only accounts, profiles, avatars, friend requests, friendships, blocks, and push-device tokens. There is no messages or attachments table. Text, images, videos, voice notes, and files continue to travel live through LiveKit and disappear when the live session ends.

## 1. Supabase

1. Create a Supabase project and enable Google under **Authentication → Providers**.
2. Add `mhtalk://auth/callback` to the allowed redirect URLs.
3. Run the ordered files in `supabase/migrations`, including
   `202608280002_subscription_plans.sql`, in the SQL editor.
4. Put the project URL and publishable key in the desktop and Android build settings described by their `.env.example` files.

## 2. Cloudflare Worker secrets

From `worker/`, configure these values without committing them:

```text
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_PUBLISHABLE_KEY
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

The service-role key exists only in the Worker. Never add it to either application or GitHub.

## 3. Offline Android invitations (optional until Firebase is created)

Create a Firebase project with Cloud Messaging, then add these Worker secrets:

```text
npx wrangler secret put FIREBASE_PROJECT_ID
npx wrangler secret put FIREBASE_CLIENT_EMAIL
npx wrangler secret put FIREBASE_PRIVATE_KEY
```

Online presence and live invitations work through the Cloudflare Durable Object. FCM is used only when the invited friend has no open presence connection.

## Data lifetime

- Profiles and friendships persist until the account/user removes them.
- Room invitations expire after 10 minutes.
- Private room codes expire after 7 days.
- Chat and attachments are never written to Supabase or Cloudflare by this design.
