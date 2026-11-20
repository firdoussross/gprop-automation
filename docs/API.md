# GProp API — findings

Reverse-engineered from the GProp Android app (`com.gprop.users`, a Flutter app).
Most of this comes from static analysis of the app's compiled Dart (`libapp.so`)
plus the backend's public CORS response. Items marked **(confirm)** still need a
live authenticated request/response to pin down exactly (see "Open items").

## Backend

- **Vendor / app:** GProp by gpropsystems.com (dev project name `gprop-user-app`).
- **Base URL:** `https://www.gpropsystems.com/api/`
  - Endpoints are appended to this, e.g. `…/api/visitor/addNewVisitor_API`.
  - Host is behind **Cloudflare**. The app talks to it via **Cronet over HTTP/3
    (QUIC)** — this is why proxy-based interception didn't work.
- **Framework:** Flutter + Shorebird code-push; networking via `cronet_http`.

## Auth / headers

The backend's CORS response advertises these request headers:

```
Content-Type, Authorization, Platform, User-Id, Accept, Version, device-os, app-version
```

So an authenticated request carries roughly:

| Header        | Value (example)              | Notes |
|---------------|------------------------------|-------|
| `Authorization` | `Bearer <token>`           | token from login **(confirm format)** |
| `User-Id`     | `<user id>`                  | returned by login |
| `Platform`    | `android` / `ios`            | |
| `Version` / `app-version` | app version string | |
| `device-os`   | `android`                    | |
| `Content-Type`| `application/json`           | |

## Endpoints (visitor flow)

| Purpose | Method | Path |
|---|---|---|
| Login | POST | `/api/login/getLoginDetails_API` |
| Logout | POST | `/api/login/logout_API` |
| Switch property | POST | `/api/login/switchProperty_API` |
| Visitor **types** (delivery/social/etc.) | POST | `/api/visitor/get_visitor_type_API` |
| Visitor categories | POST | `/api/visitor/get_visitor_category_API` |
| Valid date range | POST | `/api/visitor/vms_get_valid_date_range_api` |
| Check parking availability | POST | `/api/visitor/checkAvailableParking_API` |
| **Create visitor pass** | POST | `/api/visitor/addNewVisitor_API` |
| Edit visitor | POST | `/api/visitor/edit_visitor_API` |
| Delete visitor | POST | `/api/visitor/delete_visitor_API` |
| Visitor listing | POST | `/api/visitor/getVisitorListing_API` |
| **Visitor details (incl. QR)** | POST | `/api/visitor/getVisitorDetails_API` |
| **Share-pass text** | POST | `/api/visitor/get_share_pass_text_API` |
| Re-invite | POST | `/api/visitor/reinvite_API` |
| Update FCM token | POST | `/api/users/update_user_firebase_token_api` |
| Unit listing | POST | `/api/unit/getUnitListing_API` |

(The app has many more endpoints — bills, bookings, complaints, cards, airbnb,
etc. — but we're intentionally scoped to visitor management only.)

## Request fields (reconstructed from the binary — **confirm**)

Exact JSON keys still need one live authenticated capture to confirm. Candidate
fields seen in `libapp.so`:

- **Login** (`getLoginDetails_API`): `email` and/or `contact` (phone), `password`,
  `fcm_token`, `device_id`, `platform`. (Malaysian apps often log in by `contact`
  number — confirm which.)
- **Create pass** (`addNewVisitor_API`): visitor name (`guestName`/`visitor_name`),
  `visitor_type` (from get_visitor_type), contact/phone, `car_plate`, visit date
  (from the valid-date-range call), `unit_id`/`property_id`, `remark`/`purpose`.
- **QR**: response fields `qr_code` / `qr_image` / `qr_text` — the pass QR comes
  back from `getVisitorDetails_API` and/or `get_share_pass_text_API`, likely as a
  code/string the app renders (and/or an image URL under
  `https://www.gpropsystems.com/upload/`).

## Open items (need one authenticated sample each)

1. Exact **login request body** + response (where the token and User-Id live,
   token format/expiry).
2. Exact **addNewVisitor request body** (field names + the id/enum used for
   "delivery" vs "social" visitor type — fetch via `get_visitor_type_API`).
3. Exact **QR representation** in `getVisitorDetails_API` /
   `get_share_pass_text_API` (raw string vs image URL).

Because the app uses Cronet/HTTP-3, a normal proxy can't see these. Options to
capture them: (a) BoringSecretHunter byte-patterns fed to friTap to decode the
HTTP/3, or (b) confirm the fields by calling the endpoints from the bot with
Ross's own credentials and reading the real responses. We'll close these while
building the bot.
