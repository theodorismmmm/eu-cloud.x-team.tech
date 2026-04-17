# eu-cloud.x-team.tech

Self-hosted cloud storage with **100 GB free** per user, fully compatible with the iPad & iPhone **Files app → Connect Server** feature (WebDAV).

---

## Features

- 📱 **iPad / iPhone ready** – connects natively via Files app "Connect Server" (WebDAV)
- ☁️ **100 GB quota** per user (configurable)
- 🔒 Basic-Auth protected WebDAV endpoint
- 🌐 Web UI with setup guide and storage usage meter
- 🐳 Docker / docker-compose deployment included
- 🛡️ Path-traversal protection built in

---

## Quick Start

### 1. Clone & run locally

```bash
git clone https://github.com/theodorismmmm/eu-cloud.x-team.tech
cd eu-cloud.x-team.tech
npm install
PUBLIC_DOMAIN=mycloud.example.com REPO_NAME=my-cloud ADMIN_PASS=s3cr3t npm start
```

Open <http://localhost:3000> in a browser.

### 2. Docker Compose (recommended for production)

```bash
# copy and edit the env file
cp .env.example .env   # or set variables inline

PUBLIC_DOMAIN=mycloud.example.com \
REPO_NAME=my-cloud \
ADMIN_USER=admin \
ADMIN_PASS=s3cr3t \
docker compose up -d
```

Storage is persisted in a named Docker volume (`cloud-storage`).

---

## Connect from iPad / iPhone

1. Open the **Files** app.
2. Tap **⋯** (top-right of Browse tab) → **Connect to Server**.
3. Enter your WebDAV URL: `http://<your-domain>:3000/webdav`
4. Choose **Registered User** and enter your username & password.
5. Tap **Next** → **Connect**. Your drive appears under *Locations*.

The web UI at `/` also walks you through these steps and lets you enter the domain and repository name interactively.

---

## Environment variables

| Variable        | Default               | Description                              |
|-----------------|-----------------------|------------------------------------------|
| `PORT`          | `3000`                | HTTP port                                |
| `PUBLIC_DOMAIN` | `localhost`           | Publicly reachable domain                |
| `REPO_NAME`     | `my-cloud`            | Repository / bucket display name         |
| `ADMIN_USER`    | `admin`               | WebDAV / API username                    |
| `ADMIN_PASS`    | `changeme`            | WebDAV / API password (**change this!**) |
| `STORAGE_DIR`   | `./storage`           | Absolute path for file storage           |
| `MAX_BYTES`     | `107374182400` (100 GiB) | Per-user storage quota               |

---

## API endpoints

| Endpoint        | Auth | Description                                  |
|-----------------|------|----------------------------------------------|
| `GET /api/info` | No   | Server info: domain, repo, WebDAV URL, quota |
| `GET /api/usage`| Yes  | Storage usage for the authenticated user     |
| `/*` (WebDAV)   | Yes  | Full WebDAV mount at `/webdav`               |

---

## Development

```bash
npm run dev    # starts server with --watch
npm test       # runs all tests (Node built-in test runner)
```

---

## GitHub Action: generate username/password from a domain

This repo includes a manual workflow at:

- `.github/workflows/generate-cloud-access.yml`

How to use it:

1. Open **Actions** → **Generate Cloud Access**.
2. Click **Run workflow**.
3. Enter your domain (for example `eu-cloud.x-team.tech`) and optional port.
4. After it runs, open the workflow run and check the **Summary** tab.

The summary includes:

- generated username
- generated temporary password
- WebDAV URL for Files app "Connect Server"

Use the generated values to start the server with matching `PUBLIC_DOMAIN`, `ADMIN_USER`, and `ADMIN_PASS`.

---

## License

MIT
