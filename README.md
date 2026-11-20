# GProp Automation

Personal automation for the **visitor / delivery pass** flow in the GProp property
management app, for Ross's own household (his GProp account, his credentials).

**Why:** GProp only allows one user account per unit, so when family members
(mom, brother) have a Grab/Lalamove rider or a visitor, they currently have to
wait for Ross to open the app and generate the entry QR. This project lets the
whole household self-serve through a Telegram bot.

## Scope (deliberately narrow)

- ✅ Register a visitor / delivery rider and generate the entry QR code
- ❌ Nothing else GProp can do (billing, facilities, complaints, etc.)
- 🔒 Uses Ross's own GProp login only. Credentials stay out of git.
- 🤝 Telegram bot restricted to a hard-coded allowlist of family Telegram IDs.
- 🐢 Calls the GProp backend gently — no polling loops, no bulk requests.

## Plan

1. **Phase 1 — Understand the API.** Trace how the GProp Android app logs in and
   calls its backend to create a visitor pass + QR. See
   [`docs/CAPTURE_GUIDE.md`](docs/CAPTURE_GUIDE.md). Findings go in
   [`docs/API.md`](docs/API.md).
2. **Phase 2 — Build the bot.** A Python Telegram bot that reproduces those
   calls, gated to the family allowlist. Lives in [`bot/`](bot/).

## Repo layout

```
docs/CAPTURE_GUIDE.md   Step-by-step phone traffic-capture instructions (Phase 1)
docs/API.md             API findings template — filled in from captures
bot/                    Telegram bot (Phase 2)
.gitignore              Keeps secrets / captures out of git
```
