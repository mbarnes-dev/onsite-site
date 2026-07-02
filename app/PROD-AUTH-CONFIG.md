# onsite-prod — required Supabase Auth configuration (dashboard checklist)

The 1c app's login loop depends on dashboard settings that live outside the repo. This file makes them a
**versioned artifact** (review-2 T1-5): what must be set, why, and what is currently confirmed.

**Project:** `onsite-prod` (`btneqhrqnxmggwowboei`, eu-north-1) · **App origin:** `https://onsite-prod-app.vercel.app`
**Demo origin (must NOT be in any auth config):** `https://onsite-site.vercel.app`

---

## Required settings — Authentication → URL Configuration

| Setting | Required value | Why |
|---|---|---|
| **Site URL** | `https://onsite-prod-app.vercel.app` | Where magic links land when no explicit redirect matches. Must be the app origin — never the demo. |
| **Redirect URLs (allowlist)** | `https://onsite-prod-app.vercel.app/**` — and, for local dev only, `http://localhost:8788/**` | `signInWithOtp({ emailRedirectTo })` is **ignored unless allowlisted**; links then fall back to Site URL. The app sends `location.origin + location.pathname`. Keep this list to the app origin **only** (review-2 T1-1: origin isolation). |

## Required settings — Authentication → Providers / Email

| Setting | Required value | Why |
|---|---|---|
| Email provider (magic link / OTP) | **Enabled** (done — verified live 2026-07-01) | The only login method the app offers. |
| **Signups** | Client sends `shouldCreateUser:false` (gate item 2, in code). Dashboard "Allow new users to sign up" can stay on or off — the client refuses regardless; turning it **off** adds defense-in-depth for other clients/keys. | Invite-only until self-serve tenant creation ships (doc 78). |
| **Email OTP / magic-link expiry** | ≤ 3600 s (1 h) — default acceptable, shorter preferred | Limits the window a forwarded/leaked link is usable. |
| **Rate limits** (Auth → Rate Limits) | Keep defaults or tighter for "Email sent" | The login form is public; sending is our email quota. |
| **Leaked password protection** | **Enable** | Free; flagged by the Supabase security advisor. Moot for magic-link-only today, harmless to enable. |

## Verification steps (after saving the settings)

1. From `https://onsite-prod-app.vercel.app`: send a link to the admin email → the email's link must land back on **onsite-prod-app.vercel.app** (not the demo, not localhost) → buildings list renders.
2. Send to an unknown email → in-app message "Ingen konto for denne adressen…" and **no** new row in `auth.users`.
3. Open a consumed/expired link → the app shows "Innloggingslenken er utløpt…" (never a silent login screen).
4. (Shared-device check) Logg av → localStorage has no `sb-btneqhrqnxmggwowboei-auth-token` and no `onsite_prod_email`.

## Current as of

- **2026-07-02 (Claude, code side):** app deployed on the origin above; `shouldCreateUser:false` live; redirect-error surfacing live. Dashboard values below **unconfirmed** — fill in when set:
- **Site URL set:** ☐ _______  · **Redirect allowlist set:** ☐ _______  · **OTP expiry:** ☐ _______  · **Rate limits reviewed:** ☐ _______  · **Leaked-password protection on:** ☐ _______  (Martin: date + initial each)
