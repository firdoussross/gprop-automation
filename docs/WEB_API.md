# GProp Web App — reverse-engineered endpoints

The bot drives the GProp **website** (`https://www.gpropsystems.com`), a
CodeIgniter app that shares the mobile app's backend. The mobile app itself was
abandoned (native HTTP/3 / Cronet wall — see `API.md` / `CAPTURE_GUIDE.md`).
Send a desktop Chrome `User-Agent` on every request.

## Auth

CSRF token lives in the `/login` HTML as `csrf_token = '<hex>'` and equals the
cookie `_cmhsYhr8mfXz`. **CSRF regeneration is disabled**, so the login cookie's
value is reusable as the CSRF field — no per-request token fetch needed.

```
POST /login/login_data_submit   (urlencoded, X-Requested-With: XMLHttpRequest)
  is_ajax=1 & _co6sO0rpsfat=<csrf> & email=<id> & password=<pw> & remember=1
```

Sets `_cmhsYhr8mfXz`, `ci_session`, `user`. A single-property account (Ross's)
auto-logs-in. Multi-property accounts return `showOptions` + `propertyOptions`;
a second POST with `propertyId` + `roleId` finishes login.

## Create visitor

```
POST /visitor/add_new_visitor   (urlencoded; multipart also works)
  is_ajax=1
  formData=<JSON array of {name,value}>
  visitorImages=[]
  _co6sO0rpsfat=<csrf>
```

`formData` fields (the array, in order used):

| name | value |
|------|-------|
| fldUnitId | `1-186228` (RB-034B) |
| fldVisitorCategoryId | `1` Social, `5` Delivery |
| fldVisitorTypeId | see below |
| fldStartDate | `YYYY-MM-DD` |
| fldEndDate | **REQUIRED** — set equal to start for a single-day pass. An empty end date returns `"Add Failed"`. |
| fldVehicleNo | plate, or empty |
| fldVisitorName | name / company |
| fldRemarks | optional |
| _co6sO0rpsfat | csrf |

Do **not** send extra `date` / `direct_check_in` fields.

Success JSON: `{status:true, insertID:<id>, msg:"Successfully Added"}`. Note the
top-level `stat:false` is *not* the success flag — use `status` + `insertID`.

### Categories / types (confirmed from the live form)

- Social (cat `1`): `56405` Pedestrian, `56406` Vehicle.
- Delivery (cat `5`): `56777` Lalamove, `56778` Shopee, `56779` J&T, `56780`
  Others. No "Grab" type — Grab/Foodpanda/etc. use **Others** with the brand in
  the name field.

## Pass data / QR

```
GET /visitor/visitor_listing   ->  {"aaData":[ row, ... ]}  (newest first)
```

Each row carries `fldVisitorId`, `fldVisitorName`, `fldVisitorQr`,
`fldStartDate`, `fldEndDate`, `fldVehicleNo`, `fldUnitNumber`. **`fldVisitorQr`
is the QR content** (a plain number, e.g. `3711200271`) — the bot renders its own
pass PNG with a QR of that value (`bot/src/pass.js`), verified scannable.

## Other

- Cancel: `POST /visitor/cancel_visitor` `{is_ajax:1, targetId:<id>, _co6sO0rpsfat}`.
  Note: `targetId` from the record view is an encrypted token, not the raw
  `fldVisitorId`; passing the raw id returns success but does not take effect.
- Record view: `/visitor/view_details/<id>`.
- All visitor pages redirect to `/login?url=...` when unauthenticated.
