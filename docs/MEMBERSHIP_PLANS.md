# Unified Membership Plans

This is the naming and copy source of truth for MHTalk, MVDownloader, LAVA, and Patreon. Keep the English name, capitalization, price, billing interval, and badge label identical everywhere.

## Public plans

### Plus — $5/month

**Short description**

One membership for MHTalk and MVDownloader, with a verified Plus badge beside your MHTalk name.

**Benefits**

- MHTalk Plus badge on Windows and Android.
- MHTalk camera and screen sharing up to 1080p.
- MHTalk source-resolution recording up to 120 FPS.
- Unlimited MVDownloader audio and 720p downloads.
- Up to 10 Full HD downloads every 24 hours.

**LAVA/Patreon description**

Upgrade both apps with one Plus membership. Get the verified MHTalk Plus badge, camera and screen sharing up to 1080p, and source-quality screen recording up to 120 FPS on Windows and Android. In MVDownloader, enjoy unlimited audio and 720p downloads, plus up to 10 Full HD downloads every 24 hours.

### Pro — $7/month

**Short description**

The complete membership for both apps, with a verified Pro badge beside your MHTalk name.

**Benefits**

- MHTalk Pro badge on Windows and Android.
- Everything included with MHTalk Plus.
- MHTalk files up to 100 MB with seven-day retention.
- MHTalk animated profiles, banners, themes, frames and custom app icons.
- MHTalk custom emojis, soundboard, invite links and up to 20 saved rooms.
- Unlimited MVDownloader video up to 1080p.
- Unlimited high-quality MVDownloader audio.

**LAVA/Patreon description**

Get everything in Plus, then unlock the complete MHTalk experience with the verified Pro badge, 100 MB files, longer retention, animated profiles, themes, frames, custom emojis, soundboard, invites and more saved rooms. In MVDownloader, unlock unlimited 1080p, 720p and high-quality audio downloads.

### Ultimate — $10/month

**Short description**

Maximum MVDownloader quality with every MHTalk Pro feature and the exclusive Ultimate badge.

**Benefits**

- Unlimited MVDownloader video at every source quality, including 2K and 4K+.
- Unlimited MVDownloader 1080p and 720p video.
- Premium MVDownloader audio up to 320 kbps.
- Every MHTalk Pro feature on Windows and Android.
- Exclusive MHTalk Ultimate badge.

**LAVA/Patreon description**

Unlock every MVDownloader source quality, including 2K and 4K+, with unlimited video and premium audio up to 320 kbps. In MHTalk, get every Pro feature with the exclusive Ultimate badge.

### Max Supporter — $15/month

**Short description**

Every Ultimate benefit plus extra support for continued development and the exclusive Max Supporter badge in MHTalk.

**Benefits**

- Everything included with Ultimate in MVDownloader.
- Extra support for the continued development of MVDownloader.
- Every MHTalk Pro feature on Windows and Android.
- Exclusive MHTalk Max Supporter badge.

**LAVA/Patreon description**

Get every Ultimate MVDownloader benefit while giving extra support to continued development. In MHTalk, get every Pro feature with the exclusive Max Supporter badge.

## MHTalk entitlement rule

All four tiers are public monthly memberships shared with MVDownloader. Inside MHTalk, Plus unlocks 1080p camera/screen sharing and source-quality recording. Pro adds the complete customization, file and room feature set. Ultimate and Max Supporter inherit every Pro feature; only their exclusive badge differs.

## Internal IDs

| Display name | Internal plan ID | MHTalk feature entitlement | MHTalk badge |
| --- | --- | --- | --- |
| Plus | `plus` | HD media | Plus |
| Pro | `pro` | Complete | Pro |
| Ultimate | `ultimate` | Complete (same as Pro) | Ultimate |
| Max Supporter | `max_supporter` | Complete (same as Pro) | Max Supporter |

All four IDs are valid inputs to the public LAVA checkout. Every Patreon mapping requires its exact server-configured tier ID; pledge amount is only a defensive fallback.
