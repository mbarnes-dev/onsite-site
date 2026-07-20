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
| **Signups** | `disable_signup: true` — **set via Management API 2026-07-03.** Client also sends `shouldCreateUser:false` (gate item 2). | Server-side enforcement of invite-only (defense-in-depth beyond the client). Blocks new-user creation, **not** existing-user sign-in. |
| **Email OTP / magic-link expiry** | ≤ 3600 s (1 h) | `mailer_otp_exp: 3600` — **confirmed already compliant 2026-07-03**, left unchanged. |
| **Rate limits** (Auth → Rate Limits) | Keep defaults or tighter for "Email sent" | The login form is public; sending is our email quota. (`rate_limit_otp: 30`, default.) |
| **Leaked password protection** (`password_hibp_enabled`) | **Enable** — but **PRO-PLAN-GATED** | Attempted via Management API 2026-07-03 → **HTTP 402** "available on Pro Plans and up." Cosmetic for magic-link-only (no passwords to leak); the security-advisor WARN persists until Pro. |
| **Magic Link email template** (`mailer_templates_magic_link_content` + `mailer_subjects_magic_link`) | Body must carry the code (`{{ .Token }}`) + keep `{{ .ConfirmationURL }}`; subject `Logg inn i OnSite` | Attempted via Management API 2026-07-03 → **HTTP 400: "Email template modification is not available for free tier projects using the default email provider. Please upgrade your plan or configure a custom SMTP provider."** **BLOCKED** — this is the headline OTP-in-email goal. Until unblocked, the email is the default link-only template, so the app's `verifyOtp` code path has no code to enter and the standalone-iOS login fix is inert. Note: `mailer_otp_length` is **8** — when the template is unblocked, the emitted code is 8 digits (the app OTP input must accept 8, or set `mailer_otp_length: 6` in the same pass). |

## Verification steps (after saving the settings)

1. From `https://onsite-prod-app.vercel.app`: send a link to the admin email → the email's link must land back on **onsite-prod-app.vercel.app** (not the demo, not localhost) → buildings list renders.
2. Send to an unknown email → in-app message "Ingen konto for denne adressen…" and **no** new row in `auth.users`.
3. Open a consumed/expired link → the app shows "Innloggingslenken er utløpt…" (never a silent login screen).
4. (Shared-device check) Logg av → localStorage has no `sb-btneqhrqnxmggwowboei-auth-token` and no `onsite_prod_email`.

## Current as of

- **2026-07-02 (Claude, code side):** app deployed on the origin above; `shouldCreateUser:false` live; redirect-error surfacing live.

- **2026-07-03 (Claude, via Supabase Management API `PATCH /v1/projects/btneqhrqnxmggwowboei/config/auth`):** read the live config and applied what the Free plan allows. Access via a short-lived personal access token in `SUPABASE_ACCESS_TOKEN` (never committed).

  | Setting | API key | Before | After | How |
  |---|---|---|---|---|
  | Server-side signup lock | `disable_signup` | `false` | **`true`** ✅ | Management API — landed |
  | Magic-link expiry | `mailer_otp_exp` | `3600` | `3600` (unchanged) | already compliant |
  | Site URL | `site_url` | app origin | unchanged ✅ | already correct |
  | Redirect allowlist | `uri_allow_list` | `…/**` (app origin) | unchanged ✅ | already correct |
  | Leaked-password protection | `password_hibp_enabled` | `false` | **`false` (BLOCKED)** ⛔ | HTTP 402 — Pro plan only |
  | Magic-link subject | `mailer_subjects_magic_link` | default | **default (BLOCKED)** ⛔ | HTTP 400 — Free-tier + default provider |
  | Magic-link template (`{{ .Token }}`) | `mailer_templates_magic_link_content` | default (link-only) | **default (BLOCKED)** ⛔ | HTTP 400 — Free-tier + default provider |

  **Headline goal NOT achieved:** the emailed code (`{{ .Token }}`) requires **either a Pro plan upgrade or a custom SMTP provider** — email-template customization is disabled on Free tier with the default email sender. Until then the magic-link email is link-only, so the app's `verifyOtp` code path has no code and the installed-iOS login problem is unresolved. `mailer_otp_length` is **8** (reconcile with the app's OTP-input length when the template is unblocked). Advisor after this pass: the single security WARN is still `auth_leaked_password_protection` ([remediation](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)) — cosmetic for passwordless.

- **2026-07-03 — decision: DEFER the OTP-email unblock.** Martin chose not to upgrade to Pro or configure custom SMTP right now. Installed-iOS PWA login stays broken by design until then (normal-browser link login works); revisit when boards onboard. The template PATCH is staged below — a ~2-minute finish once either Pro is on or a custom SMTP sender is configured.

- **Staged magic-link template (review-3 ledger fix — committed here so the unblock pass is paste-ready; the `/tmp` copy was volatile and is gone).** PATCH keys: `mailer_templates_magic_link_content` = the HTML below (note the underscore key names — `magiclink` is silently ignored), `mailer_subjects_magic_link` = `Logg inn i OnSite`. The app's OTP input accepts 6–8 digits, so this works whether `mailer_otp_length` stays 8 or is pinned to 6 in the same PATCH.

  ```html
  <h2>Logg inn i OnSite</h2>
  <p><a href="{{ .ConfirmationURL }}">Trykk her for å logge inn</a> — på denne enheten.</p>
  <p>Eller skriv inn koden i appen: <strong style="font-size:1.3em;letter-spacing:2px">{{ .Token }}</strong></p>
  <p style="color:#666;font-size:0.9em">Koden og lenken gjelder i én time og kan brukes én gang. Var ikke dette deg? Da kan du se bort fra denne e-posten.</p>
  ```

- **Martin — live proof after any settings change:** request login from the app; confirm existing-user sign-in still works with `disable_signup:true`. Date + initials: ______________
