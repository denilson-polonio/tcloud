# ☁️ TCloud

**Your own cloud storage, powered by Telegram. Self-hosted, open source, zero monthly fees.**

TCloud turns a private Telegram channel into the storage backend of a full personal cloud: a clean web app with folders, previews, sharing, multiple users, encryption and automatic backups — running on anything from a Raspberry Pi to a VPS. Your files live in *your* Telegram channel and in *your* database. No third-party server is ever involved.

> 🌐 Website: **https://tcloud.denilson.it**

---

## ✨ Features

- **Unlimited-style storage on Telegram** — files are chunked and stored in a private channel you own; the app streams them back seamlessly.
- **Real file manager** — folders, drag & drop uploads, previews (images, video, audio, PDF, text), search, starred items, direct management.
- **Multi-user with roles & permissions** — owner, admins and users with granular permissions; optional public registration for organizations.
- **Sharing** — share files/folders with links, optional password and expiry, view or upload-only modes.
- **TDrop** — people send files to your bot on Telegram and they land straight in your cloud (guests can be invited by @username, with deadlines).
- **At-rest encryption** — optional AES-256-GCM encryption of every chunk *before* it reaches Telegram.
- **Encrypted backups & snapshots** — full encrypted exports, plus automatic database snapshots pushed to your channel.
- **Two-factor login** (TOTP), session controls, rate-limiting and hardened headers.
- **Decentralized self-updates** — every instance checks this repository's GitHub Releases on its own schedule (default once a day) and can update itself. Your data and configuration are never touched. No central server, no telemetry, no phone-home.
- **Multi-language** — English and Italian included; add your own language by dropping one JSON file (see below).
- **PWA** — installable on phone and desktop.

## 🚀 Install

**One line (Linux/macOS)** — the installer is served from **tcloud.denilson.it**, not bundled in this repo:

```bash
curl -fsSL https://tcloud.denilson.it/install.sh | bash
```

On a brand-new machine this single command does **everything**: it installs Node.js and the build tools if they're missing, downloads this app's latest release from GitHub, compiles and installs it into `/opt/tcloud`, and registers a service that **starts TCloud automatically on every boot** (with auto-restart, which also lets the self-updater come back on its own). Re-running it later upgrades in place and never touches your `data/` or `.env`.

**Manual:**

```bash
git clone https://github.com/denilson-polonio/tcloud.git tcloud
cd tcloud
npm install --omit=dev
npm start
```

Then open `http://localhost:3000` — the **setup wizard** walks you through everything (creating the bot with @BotFather, creating the private channel, finding the IDs) with a "How do I do this?" helper on every field.

**Requirements:** Node.js ≥ 18, a Telegram account. That's it. Runs happily on a Raspberry Pi.

## ⚙️ Configuration

Everything important is configured in the setup wizard or in `.env` (see [`.env.example`](.env.example) — port, encryption, backups passphrase, session policy, update repo override and more). Code customizations are possible too — it's your copy — but prefer `.env`, since updates replace code files.

## 🔄 Updates

TCloud updates itself **directly from this repository's GitHub Releases** — fully decentralized:

- Each instance checks for a new release on its own schedule (default **once a day**; configurable in the app, or disable it and update manually).
- Updates can apply automatically (when the instance is idle, or at a scheduled time) or with one click.
- **Your `data/` folder (database + files) and your `.env` are never touched.** Before applying, the downloaded release is sanity-checked (`node --check` on every source file); the previous version is kept in `.update-rollback/` and restored automatically if anything fails.

To stay on your own fork, set `UPDATE_REPO=youruser/yourfork` in `.env`.

## 🗑 Uninstall

TCloud ships with its own uninstaller (`uninstall.sh`, installed alongside the app). One command removes everything:

```bash
sudo bash /opt/tcloud/uninstall.sh
```

It stops and removes the boot service (systemd / pm2 / restart loop) and deletes the app folder, including its local `data/` index. Add `--keep-data` to keep your `data/` and `.env`. You can also trigger it from the app — **Admin → Backup → Danger zone → Uninstall TCloud** (owner only; it asks for your password).

**Your files are never deleted** — they stay in your Telegram channel. To remove them too, delete that channel; to retire the bot, message @BotFather and send `/deletebot`.

## 🌍 Translations

The interface is translated through **[Crowdin](https://crowdin.com)** so anyone can help — no Git, no code. Just open the project and translate in the browser:

**→ Translate TCloud on Crowdin:** https://crowdin.com/project/tcloud

English is the **source** language; every other language is a translation of it, and any missing string falls back to English. When translations are ready, Crowdin opens a pull request here that the maintainer reviews and merges — then the new language appears in the app's language picker automatically (display names are built in for ~16 common languages).

<details>
<summary>Prefer to edit files directly?</summary>

Languages live in [`public/i18n/`](public/i18n) — one flat JSON file per language:

1. Copy `public/i18n/en.json` to `public/i18n/<code>.json` (e.g. `de.json`).
2. Translate the values (keys stay in English). Optionally add `"__name__": "Deutsch"` for the display name.
3. Restart — the language appears in the picker automatically.

Pull requests with new languages are welcome either way.
</details>

## 🧩 Extensions & plugins

TCloud can load **community extensions** — small client-side plugins that add sidebar pages and file actions. The owner installs them from **Admin → Settings → Extensions** by pasting a public GitHub repository URL; TCloud fetches the manifest and entry script from the repo's latest release, and they can be enabled, disabled, updated or removed at any time.

Want to build one? A complete, commented starter — the manifest format, the full `TCloudExt` API, a folder-based i18n pattern and the publish / auto-update flow — lives in its own repo:

**→ [tcloud-extension-example](https://github.com/denilson-polonio/tcloud-extension-example)**

> Extensions run in the browser with the signed-in user's session; only the owner can install them, and only from public GitHub repos. Install sources you trust.

## 🗂 Project layout

```
src/           backend (Express + better-sqlite3 + grammY)
public/        web app (vanilla JS PWA) + i18n
uninstall.sh   one-command uninstaller (the installer itself is served from tcloud.denilson.it, not here)
data/          YOUR database & files — created at runtime, never in git, never touched by updates
```

## 🔐 A note on trust & safety

- Files are stored in **your** Telegram channel through **your** bot; only the Telegram API is contacted.
- Optional at-rest encryption means Telegram only ever sees ciphertext.
- Updates are pulled over HTTPS from GitHub Releases of this repo — the same trust model as `git pull`, plus integrity checks and automatic rollback.

## 🤝 Contributing & forks

Issues and pull requests are welcome. Want to take it somewhere else? Fork it — and point `UPDATE_REPO` at your fork so your instances follow you.

## 📄 License

[MIT](LICENSE) — do what you want, just keep the notice.

---

Made with ❤️ by **Denilson** · [tcloud.denilson.it](https://tcloud.denilson.it)
