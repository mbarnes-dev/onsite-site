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
| **Custom SMTP** (`smtp_host`…) | A non-default sender — this is what lifts the Free-tier template lock | **LIVE 2026-07-21**: Resend — `smtp.resend.com:465`, user `resend`, sender `OnSite <onsite@nexorgroup.ae>`. Set by Martin. |
| **Magic Link email template** (`mailer_templates_magic_link_content` + `mailer_subjects_magic_link`) | Body must carry the code (`{{ .Token }}`) + keep `{{ .ConfirmationURL }}`; subject `Logg inn i OnSite` | **DONE 2026-07-21** ✅ — applied via Management API once custom SMTP landed (HTTP 200, read back verified). `mailer_otp_length` pinned **8 → 6** in the same PATCH so the app's «engangskode (6 siffer)» copy is true. This was the headline OTP-in-email goal; the app's `verifyOtp` path finally has a code to receive. |

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

- **2026-07-21 — RE-VERIFIED, still blocked.** Prompted by "why do I only get a link, never a code?" — the
  answer is unchanged and now re-confirmed against live config, not memory:

  | Check | Live value (2026-07-21) |
  |---|---|
  | Org plan (`onsite`, `ztvadezskcnyewsqqkiy`) | **`free`** |
  | Custom SMTP (`smtp_host`) | **`null`** — default Supabase sender |
  | `mailer_templates_magic_link_content` | link-only, **no `{{ .Token }}`** (`<h2>Your sign-in link</h2>…`) |
  | `mailer_subjects_magic_link` | `Your sign-in link` |
  | PATCH attempt (template + subject) | **HTTP 400** — *"Email template modification is not available for free tier projects using the default email provider."* |
  | `disable_signup` / `mailer_otp_exp` / `site_url` / allowlist | `true` / `3600` / app origin / app origin — all still correct ✅ |

  **The gate is the PLAN + SENDER, not the template text.** The dashboard template editor hits this same
  API, so editing `{{ .Token }}` in the UI cannot be saved either — it is not a 5-minute dashboard fix.
  **Cheapest unblock: custom SMTP (Resend), not a Pro upgrade** — configuring any custom SMTP sender lifts
  the template lock on Free. Resend values: host `smtp.resend.com`, port `465`, user `resend`, password =
  a Resend API key, sender on a Resend-verified domain. Once `smtp_host` is non-null, the staged PATCH
  below applies in ~2 minutes and the installed-iOS code login works.

  **Also reconcile in that same pass:** `mailer_otp_length` is **8**, but the app's login card says
  «engangskode (6 siffer)». Either PATCH `mailer_otp_length: 6` (makes the existing copy true; the input
  already accepts 6–8) or change the copy. Pinning to 6 is the shorter thing to type on a ladder.

- **2026-07-21 — UNBLOCKED. The OTP email finally carries a code.** Martin configured custom SMTP (Resend),
  which lifts the Free-tier template lock; the staged PATCH was applied the same day and read back verified:

  | Setting | Before | After (live, verified) |
  |---|---|---|
  | `smtp_host` / sender | `null` / Supabase default | **`smtp.resend.com`** / `OnSite <onsite@nexorgroup.ae>` ✅ |
  | `mailer_templates_magic_link_content` | link-only, no code | **carries `{{ .Token }}` + `{{ .ConfirmationURL }}`** ✅ |
  | `mailer_subjects_magic_link` | `Your sign-in link` | **`Logg inn i OnSite`** ✅ |
  | `mailer_otp_length` | `8` | **`6`** ✅ (matches the app's «6 siffer» copy; input still accepts 6–8) |
  | `disable_signup` / `site_url` / allowlist / `mailer_otp_exp` | — | untouched, still correct ✅ |

  Live template body:

  ```html
  <h2>Logg inn i OnSite</h2>
  <p>Skriv inn denne koden i appen:</p>
  <p style="font-size:30px;font-weight:700;letter-spacing:6px;margin:14px 0">{{ .Token }}</p>
  <p>&mdash; eller <a href="{{ .ConfirmationURL }}">trykk her for å logge inn</a> på denne enheten.</p>
  <p style="color:#666;font-size:0.9em">Koden og lenken gjelder i én time og kan brukes én gang. Var ikke dette deg? Da kan du se bort fra denne e-posten.</p>
  ```

  **Follow-up — CLOSED same day.** Martin confirmed code login works in the **installed app on the iPad**
  (no Safari detour). `A2HS_IOS_ENABLED` flipped to `true` and shipped (`e8e64cb`, SW cache
  **`onsite-app-v17`**, `app.js?v=17`), so the iOS «Legg til på Hjem-skjerm» hint is live again — it now
  invites an install whose login actually works. The flag is kept, not deleted: set it back to `false` for
  a one-token kill switch if the emailed code ever regresses. Pre-deploy suite green (core 12/12,
  `interleave.html` 0 fails, `fangst.html` 0 fails/32 asserts); live-verified SW v17 + flag true on origin.

  **The 2-Jul → 21-Jul login saga is now closed end to end:** invite-only signup (server-side) → emailed
  6-digit code → in-app `verifyOtp` → installed-PWA login → add-to-home invite. Nothing in this chain is
  gated on anything else now.

- **Martin — live proof after any settings change:** request login from the app; confirm existing-user sign-in still works with `disable_signup:true`. Date + initials: ______________
