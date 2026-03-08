# tokscale-hub

A local aggregation proxy for [tokscale](https://github.com/junhoyeo/tokscale). Instead of each device submitting directly to tokscale.ai, every device submits to this hub. The hub merges all device data and pushes a single combined submission upstream.

## How it works

1. Each device points `TOKSCALE_API_URL` at the hub and runs `tokscale submit` as normal.
2. The hub stores the submission, keyed by device.
3. When you are ready, trigger a push — the hub merges all device data and submits it to tokscale.ai under your account(s).

## Requirements

- Docker and Docker Compose

## Setup

### 1. Get your tokscale token

On any device that has run `tokscale login`:

```bash
cat ~/.config/tokscale/credentials.json
```

Copy the value of `"token"`. This is what the hub uses to push to tokscale.ai.

### 2. Configure the hub

```bash
cp .env.example .env
```

Edit `.env`:

```
HUB_TOKEN=your_tokscale_token_here
```

To push to multiple tokscale accounts simultaneously, pass a comma-separated list:

```
HUB_TOKEN=token_account1,token_account2
```

To restrict which devices can submit, set per-device secrets:

```
HUB_SECRET=secret-laptop,secret-desktop
```

If `HUB_SECRET` is left empty, any device on the network can submit.

### 3. Start the hub

```bash
docker compose up -d
```

The hub listens on port `7171` by default.

## Submitting from a device

On each device, set `TOKSCALE_API_URL` to point at the hub before running submit:

```bash
TOKSCALE_API_URL=http://<hub-ip>:7171 tokscale submit
```

To make this permanent, add it to your shell profile:

```bash
# ~/.zshrc or ~/.bashrc
export TOKSCALE_API_URL=http://<hub-ip>:7171
```

If you configured `HUB_SECRET`, the device's tokscale token must be listed there. Get it from `~/.config/tokscale/credentials.json` on that device and add it to the hub's `HUB_SECRET` list.

## Pushing to tokscale.ai

After your devices have submitted, push the merged data:

```bash
curl -X POST http://localhost:7171/api/hub/push
```

To push automatically after every device submission instead:

```
HUB_AUTO_PUSH=1
```

## API reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/api/hub/status` | List stored device submissions and last push time |
| GET | `/api/hub/preview` | Return the merged payload without pushing |
| POST | `/api/hub/push` | Merge all submissions and push to tokscale.ai |
| POST | `/api/submit` | Receive a submission from a device (called by the CLI) |
| DELETE | `/api/hub/device/:id` | Remove a specific device's submission |

## Configuration reference

All configuration is via environment variables, typically set in `.env`.

| Variable | Default | Description |
|----------|---------|-------------|
| `HUB_PORT` | `7171` | Port the hub listens on |
| `HUB_TOKEN` | — | Comma-separated tokscale bearer tokens for pushing upstream |
| `HUB_SECRET` | — | Comma-separated per-device secrets. Empty means open |
| `HUB_UPSTREAM` | `https://tokscale.ai` | Upstream API base URL |
| `HUB_AUTO_PUSH` | `0` | Set to `1` to push after every device submission |
| `HUB_STORE_PATH` | `/data/hub-store.json` | Path to the JSON store file inside the container |

## Logs

```bash
docker compose logs -f
```

## Stopping

```bash
docker compose down
```

Submissions are persisted in a Docker volume (`hub-data`) and survive restarts.
