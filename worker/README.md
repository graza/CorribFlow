# corrib-flow Worker

Cloudflare Worker that acts as a CORS proxy for waterlevel.ie CSVs and runs the Telegram alert bot for [@corribflow_bot](https://t.me/corribflow_bot).

## Prerequisites

- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- Cloudflare account (free tier sufficient)
- Telegram bot token from [@BotFather](https://t.me/BotFather)

## One-time setup

### 1. Create the KV namespace

```sh
npx wrangler kv namespace create FLOW_KV
```

Copy the `id` from the output into `wrangler.toml`.

### 2. Set secrets

```sh
npx wrangler secret put TELEGRAM_TOKEN     # from BotFather
npx wrangler secret put WEBHOOK_SECRET     # any random string, e.g. openssl rand -hex 32
```

`WEBHOOK_SECRET` must contain only `A-Z a-z 0-9 _ -` (no colons or slashes).

### 3. Deploy

```sh
npx wrangler deploy
```

### 4. Register the Telegram webhook

Run once in a browser or curl (substituting your values):

```
https://api.telegram.org/bot<TELEGRAM_TOKEN>/setWebhook?url=https://corrib-flow.graza.workers.dev/telegram&secret_token=<WEBHOOK_SECRET>
```

Expected response: `{"ok":true,"result":true,"description":"Webhook was set"}`

### 5. Register the bot command menu

Run once (and again whenever commands change) so commands appear in Telegram's `/` menu:

```sh
curl -s https://api.telegram.org/bot<TELEGRAM_TOKEN>/setMyCommands \
  -H 'Content-Type: application/json' \
  -d '{"commands":[
    {"command":"flow","description":"Current flow"},
    {"command":"chart","description":"Chart since the last summary"},
    {"command":"day","description":"Chart of the last 24 hours"},
    {"command":"week","description":"Chart of the last 7 days"},
    {"command":"month","description":"Chart of the last 30 days"},
    {"command":"web","description":"Open the website"},
    {"command":"start","description":"Subscribe to alerts and summaries"},
    {"command":"stop","description":"Unsubscribe"}
  ]}'
```

Expected response: `{"ok":true,"result":true}`

## Cron triggers

| Schedule | Dublin time | Purpose |
|---|---|---|
| `*/15 * * * *` | every 15 min | Threshold crossing alerts |
| `0 4,5,14,15 * * *` | 5am and 3pm (DST-aware) | Flow summary + chart since the previous summary |

The twice-daily trigger fires at four UTC hours to cover the DST boundary; the handler checks the Dublin local hour and exits early if it isn't 5 or 15.

## KV keys

| Key | Contents | TTL |
|---|---|---|
| `alertState` | JSON array of thresholds currently crossed | none |
| `subscribers` | JSON array of Telegram chat IDs | none |
| `latestFlow` | `{datetime, flowRate, smoothedFlow, pastFlow, series}` from last cron run (`series` is the last 24h of readings) | 15 min |
| `errors` | JSON array of last 10 errors: `{context, error, timestamp}` | none |

Keys shared with other projects live in a separate namespace, `SHARED_KV` (`07563ec612644de4b37cf418ea35e6bb`), so they can be bound without exposing the keys above:

| Key | Contents | TTL |
|---|---|---|
| `latest` | `{flow_m3s, observed_at}` for Slipside: smoothed flow, ISO 8601 UTC time. Shared contract with Slipside; change both together | none |

To inspect recent errors:

```sh
npx wrangler kv key get --binding FLOW_KV errors
```

The `context` field identifies where the error occurred: `broadcastPhoto`, `/chart`, `/day`, `/week`, `/month`, `telegram:webhook`, or `scheduled:<cron>` (e.g. `scheduled:*/15 * * * *`).

## Bot commands

| Command | Behaviour |
|---|---|
| `/start` | Subscribe (capped at 100 subscribers) |
| `/stop` | Unsubscribe |
| `/flow` | Reply with current flow (served from KV cache, 15 min max age) |
| `/chart` | Chart since the last scheduled summary (minimum 12 hours) |
| `/day` | Chart of the last 24 hours (15-min readings + moving average) |
| `/week` | Chart of the last 7 days (hourly averages) |
| `/month` | Chart of the last 30 days (6-hourly averages) |
| `/web` | Link to the website |

Charts are rendered by QuickChart and use rolling windows ending now, unlike the website's calendar-aligned periods. Captions show the 75-min moving average with the latest raw reading. Flow messages, charts and alerts carry an "Open website" button linking to the matching website view.

The bot works in group chats as well as direct messages.

## Alert thresholds

Alerts fire at 100, 150, 200, 250, 300, 350, 400, 450, 500 cumec.  
Downward alerts require flow to drop 10 cumec below the threshold (hysteresis) before firing.

## Deploying updates

```sh
npx wrangler deploy
```
