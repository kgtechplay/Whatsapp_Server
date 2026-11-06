# WhatsApp Gateway

Service that keeps one WhatsApp account linked through the WhatsApp Web protocol and exposes an authenticated HTTP API for connection management and outbound text messages.

Outbound sends use the Baileys socket already owned by `ConnectionManager`. Sending does not open a second socket or reload authentication. The gateway does not store chats, accept inbound messages, or provide a web dashboard.

## Stack

| Piece | Choice |
|---|---|
| Runtime | Node.js 22 or newer |
| Language | TypeScript, strict mode |
| WhatsApp | `@whiskeysockets/baileys` 6.7.24 |
| HTTP | Express 4 |
| Logs | Pino |
| Tests | Vitest |
| Deploy | Docker, Railway |

Baileys 6.7.24 is the newest stable 6.x release checked for this project (published 2026-07-29). It requires Node.js 20 or newer. Baileys 7.0.0 is still a release candidate, so it is not used here. The 6.7.24 package depends on `libsignal` through a GitHub URL; `package-lock.json` pins that dependency for repeatable installs. Docker therefore needs `git` while installing dependencies.

`useMultiFileAuthState` stores credentials and Signal keys as JSON files. Baileys documents that helper as unsuitable as a long-term production database. Phase 1 wraps it in `FileSessionStore` so a later version can replace the files without rewriting the connection manager or the HTTP API.

## What you need locally

- Node.js 22 LTS or newer (`node --version`)
- npm 10 or newer, which ships with that Node.js release
- A WhatsApp account you are allowed to link, preferably a dedicated test account
- For a container build: Docker, plus network access to GitHub during `npm ci`

## Local setup (Windows PowerShell)

From this directory:

```powershell
node --version
npm install
Copy-Item .env.example .env
```

Edit `.env` and replace `API_KEY` with a random secret of at least 16 characters. Do not commit `.env`.

```powershell
npm run dev
```

`npm run dev` loads `.env`, validates configuration, and listens on `0.0.0.0` at `PORT` (3000 by default). The HTTP API stays up even when WhatsApp is disconnected.

In a second PowerShell window, from the same directory:

```powershell
npm run qr
```

That command calls `GET /api/session/qr` and prints a terminal QR. It does not write the payload to a file. On the phone open WhatsApp, then **Settings → Linked devices → Link a device**, and scan the code.

Baileys refreshes the QR while the pairing socket is open. If `npm run qr` says no code is available yet, run it again. After a successful scan, WhatsApp often closes the socket once and the gateway reconnects with the saved credentials. That restart is expected.

Check status:

```powershell
$headers = @{ Authorization = "Bearer $env:API_KEY" }
Invoke-RestMethod http://127.0.0.1:3000/api/session/status -Headers $headers
```

`status` should become `CONNECTED`. `account.id` is the phone number without the WhatsApp device suffix. The response does not include credentials or keys.

Stop the process with Ctrl+C. That sends `SIGINT`. The gateway closes the socket and does **not** log the WhatsApp account out. Start it again:

```powershell
npm run dev
```

With the same `WHATSAPP_AUTH_PATH` and intact files, it should return to `CONNECTED` without a new QR. Confirm with the status command above.

The default auth directory is `./data/baileys-auth`. It is gitignored.

### Production build on the same machine

```powershell
npm run build
npm start
```

`npm start` runs `node dist/server.js`. Provide the same environment variables, either through `.env` (loaded by the process) or the shell. Example:

```powershell
$env:NODE_ENV = "production"
$env:PORT = "3000"
$env:WHATSAPP_AUTH_PATH = ".\data\baileys-auth"
$env:AUTO_RECONNECT = "true"
$env:API_KEY = "replace_with_a_strong_random_secret"
$env:LOG_LEVEL = "info"
npm start
```

### Tests and typecheck

```powershell
npm test
npm run typecheck
npm run build
```

Tests mock Baileys. They do not use a real WhatsApp account.

## HTTP API

Public:

| Method | Path | Auth |
|---|---|---|
| GET | `/health` | none |

Protected with `Authorization: Bearer <API_KEY>`:

| Method | Path | Result |
|---|---|---|
| GET | `/api/session/status` | Current connection snapshot |
| GET | `/api/session/qr` | Current pairing payload, or 404/409 |
| POST | `/api/session/connect` | Start or resume a connection. 202 if a new attempt starts, 200 if one is already active |
| POST | `/api/session/logout` | Log out the active socket, then delete local auth files |
| POST | `/api/messages/send` | Send one text message to 1–10 phone numbers |

`/api/session/qr` sends `Cache-Control: no-store`. It does not create a connection by itself. Startup already attempts a connection. Call `POST /api/session/connect` after a logout, after `AUTO_RECONNECT=false` left the gateway disconnected, or when the saved session was rejected.

`POST /api/session/logout` returns HTTP 200 only when the logout workflow finished. If the socket cannot confirm a remote logout, the response is HTTP 502, retries are stopped, and the saved credentials are kept.

Session routes are limited to 30 requests per minute per client IP. In production the app trusts one proxy hop so Railway's forwarded client address is used for that limit. Message sends use a separate in-process quota, described below.

There is no CORS middleware. Do not put the API key in a query string.

### PowerShell

```powershell
$headers = @{ Authorization = "Bearer $env:API_KEY" }
$base = "http://127.0.0.1:3000"

Invoke-RestMethod "$base/health"
Invoke-RestMethod "$base/api/session/status" -Headers $headers
Invoke-RestMethod "$base/api/session/qr" -Headers $headers
Invoke-RestMethod "$base/api/session/connect" -Method POST -Headers $headers
Invoke-RestMethod "$base/api/session/logout" -Method POST -Headers $headers
```

### curl.exe

On Windows PowerShell, use `curl.exe` so the command is not aliased to `Invoke-WebRequest`.

```powershell
curl.exe http://127.0.0.1:3000/health
curl.exe -H "Authorization: Bearer $env:API_KEY" http://127.0.0.1:3000/api/session/status
curl.exe -H "Authorization: Bearer $env:API_KEY" http://127.0.0.1:3000/api/session/qr
curl.exe -X POST -H "Authorization: Bearer $env:API_KEY" http://127.0.0.1:3000/api/session/connect
curl.exe -X POST -H "Authorization: Bearer $env:API_KEY" http://127.0.0.1:3000/api/session/logout
```

### Status values

`INITIALIZING`, `QR_REQUIRED`, `CONNECTING`, `CONNECTED`, `DISCONNECTED`, `RECONNECTING`, `LOGGED_OUT`, `ERROR`.

`CONNECTED` is set only after Baileys reports the socket open. Saved files alone do not mark the gateway connected.

Recoverable disconnects retry with a 2 second initial delay, doubling until 60 seconds, with ±20% jitter, and never above the configured maximum. Logout, a bad session, and a multi-device mismatch stop automatic retries. `POST /api/session/connect` after logout or a rejected session deletes the local auth files and starts pairing again.

`AUTO_RECONNECT=false` still attempts one connection at startup. Later drops stay in `DISCONNECTED` until `POST /api/session/connect`.

## Send a text message

`POST /api/messages/send` submits the same text to each listed number through the active session. The gateway must already be `CONNECTED`. A phone number that passes validation is not proof that the number uses WhatsApp.

```json
{
  "recipients": ["919876543210", "+14155552671"],
  "message": "Hello from my WhatsApp Gateway!"
}
```

Headers:

```http
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json
Idempotency-Key: order-1001
```

`Idempotency-Key` is optional. Use letters, numbers, `.`, `_`, `:`, or `-`, up to 200 characters. The same key and the same payload return the stored result for 10 minutes and do not send again. The same key with a different payload returns HTTP 409 `IDEMPOTENCY_CONFLICT`. A repeat while the first request is still running returns HTTP 409 `REQUEST_IN_PROGRESS`. This store is in memory. A restart or Railway deploy forgets it. That is not exactly-once delivery.

Numbers must include the country code. A leading `+` is optional and is removed internally. `9876543210` is rejected because the country code is missing. Duplicate numbers, extensions, and more than `MAX_RECIPIENTS_PER_REQUEST` numbers reject the whole request before any send. The message must be nonempty and at most 4,000 characters.

With the defaults, `ALLOW_ALL_RECIPIENTS=false` and an empty `ALLOWED_RECIPIENTS` list, every send is rejected. For a test, set `ALLOWED_RECIPIENTS` to the normalized digits you will message, for example `919876543210,14155552671`. Set `ALLOW_ALL_RECIPIENTS=true` only when you intentionally allow any valid number.

A completed request returns HTTP 200 even when some recipients fail. Inspect `results`.

| Result | Meaning |
|---|---|
| `sent` | Baileys accepted the send and returned a message id. This is not a delivery or read receipt. |
| `failed` | The send was attempted and failed while the socket was still connected. |
| `not_sent` | This recipient was not submitted, usually because the connection dropped or an earlier send is unresolved. |
| `unknown` | The outcome cannot be determined, for example a timeout. The gateway does not retry it. |

If Baileys returns no message id, the recipient is `unknown`. The gateway does not invent an id.

Other responses:

| HTTP | Code | When |
|---|---|---|
| 400 | `INVALID_REQUEST`, `INVALID_RECIPIENT`, `RECIPIENT_NOT_ALLOWED` | Body, number, or allowlist problem. Nothing is sent. |
| 401 | | Missing or wrong API key |
| 409 | `REQUEST_IN_PROGRESS`, `IDEMPOTENCY_CONFLICT` | Idempotency key |
| 413 | `PAYLOAD_TOO_LARGE` | Body above 64 KB |
| 429 | `RATE_LIMIT_EXCEEDED` | Request or hourly message quota |
| 503 | `WHATSAPP_DISCONNECTED`, `SEND_TIMEOUT` | Socket is down, or a previous send is still unresolved |
| 500 | `INTERNAL_ERROR` | Unexpected failure. No stack trace |

Sends run one batch at a time. The default pause between messages is 1,500 ms. Defaults also cap the gateway at 10 send requests per minute and 30 outbound messages per hour. These are application safeguards, not WhatsApp's official limits. A request that would exceed the quota is rejected and nothing in that request is sent. There is no waiting queue.

A per-recipient timeout defaults to 30 seconds. On timeout that recipient is `unknown`, later recipients in the same request are `not_sent`, and new requests receive HTTP 503 until the original Baileys call settles.

### PowerShell

```powershell
$headers = @{
  Authorization = "Bearer $env:API_KEY"
  "Idempotency-Key" = "order-1001"
}
$body = @{
  recipients = @("919876543210")
  message = "Hello from my WhatsApp Gateway!"
} | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:3000/api/messages/send -Method POST -Headers $headers -ContentType "application/json" -Body $body
```

### curl.exe

```powershell
curl.exe -X POST http://127.0.0.1:3000/api/messages/send `
  -H "Authorization: Bearer $env:API_KEY" `
  -H "Content-Type: application/json" `
  -H "Idempotency-Key: order-1001" `
  -d "{\"recipients\":[\"919876543210\"],\"message\":\"Hello from my WhatsApp Gateway!\"}"
```

### Python

```python
import json
import urllib.request

request = urllib.request.Request(
    "http://127.0.0.1:3000/api/messages/send",
    data=json.dumps({
        "recipients": ["919876543210", "14155552671"],
        "message": "Hello from my WhatsApp Gateway!",
    }).encode(),
    headers={
        "Authorization": "Bearer YOUR_API_KEY",
        "Content-Type": "application/json",
        "Idempotency-Key": "order-1001",
    },
    method="POST",
)
with urllib.request.urlopen(request) as response:
    print(response.read().decode())
```

Example completed body:

```json
{
  "requestId": "req_12345",
  "status": "completed",
  "summary": { "total": 1, "sent": 1, "failed": 0, "notSent": 0, "unknown": 0 },
  "results": [
    { "number": "919876543210", "status": "sent", "messageId": "BAILEYS_MESSAGE_ID" }
  ]
}
```

## Configuration

See `.env.example`.

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | no | `development`, `test`, or `production`. Default `development` |
| `PORT` | no | Integer 1–65535. Default `3000`. Railway injects this |
| `WHATSAPP_AUTH_PATH` | yes | Directory for Baileys auth files |
| `AUTO_RECONNECT` | no | `true` or `false`. Default `true` |
| `RECONNECT_INITIAL_DELAY_MS` | no | Positive integer, default `2000`, must be ≤ max |
| `RECONNECT_MAX_DELAY_MS` | no | Positive integer, default `60000` |
| `API_KEY` | yes | At least 16 characters. Rotate by changing the variable and restarting |
| `LOG_LEVEL` | no | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` |
| `SHUTDOWN_TIMEOUT_MS` | no | Default `10000` |
| `MAX_RECIPIENTS_PER_REQUEST` | no | 1–10. Default `10` |
| `MAX_MESSAGE_LENGTH` | no | 1–4000. Default `4000` |
| `SEND_DELAY_MS` | no | 0–60000. Default `1500` |
| `SEND_TIMEOUT_MS` | no | 1000–120000. Default `30000` |
| `MAX_SEND_REQUESTS_PER_MINUTE` | no | Default `10` |
| `MAX_OUTBOUND_MESSAGES_PER_HOUR` | no | Default `30` |
| `ALLOW_ALL_RECIPIENTS` | no | Default `false`. Set `true` only to allow any valid number |
| `ALLOWED_RECIPIENTS` | no | Comma-separated numbers with country codes. Compared after normalization |

Invalid values are listed together on stderr and the process exits before it listens. The API key value is not printed.

Production path used with the Railway volume:

```dotenv
NODE_ENV=production
WHATSAPP_AUTH_PATH=/data/baileys-auth
AUTO_RECONNECT=true
LOG_LEVEL=info
```

Set `API_KEY` in the host's secret environment, not in the image.

## Logging

Logs are single-line JSON with `timestamp`, `level`, `event`, and `connectionState` when the event has one. Retry logs include `reconnectAttempt` and `errorCategory`.

The process does not log the API key, QR payload, credential material, Signal keys, raw authorization headers, or message text. Phone numbers in send logs keep only the last four digits. Baileys' own logger is held at `warn` so a debug application level does not print connection payloads. `printQRInTerminal` is set to `false`.

## Docker

The image is not built by the application process. From a machine with Docker:

```powershell
docker build -t whatsapp-gateway .
docker run --rm -p 3000:3000 `
  -e NODE_ENV=production `
  -e API_KEY=replace_with_a_strong_random_secret `
  -e WHATSAPP_AUTH_PATH=/data/baileys-auth `
  -e AUTO_RECONNECT=true `
  -e LOG_LEVEL=info `
  -v "${PWD}/data:/data" `
  whatsapp-gateway
```

The image listens on `0.0.0.0` and uses `PORT` when the platform sets it. It does not copy `.env` or auth files into the image. The build runs `npm ci` (git is required for the Baileys `libsignal` dependency) and then `npm run build`.

A local Docker build was **not** run in the environment that produced this repository because the `docker` command was not installed there.

## Railway

Use one service instance. A Railway volume cannot be shared safely by multiple replicas, and this process allows only one Baileys socket.

1. Push this repository to GitHub.
2. In Railway, create a project and a service from that repository.
3. Railway reads `railway.json`. The service builds with the Dockerfile and uses `GET /health` as the deployment healthcheck. The restart policy is `ON_FAILURE` with up to 10 retries.
4. Generate a public HTTPS domain for the service. Use that HTTPS URL for administration. Do not call the session API over plain HTTP from another machine.
5. Add a volume mounted at `/data`. Leave the volume attached across deploys. If it is replaced or emptied, WhatsApp will require a new QR.
6. Set variables:
   - `NODE_ENV=production`
   - `WHATSAPP_AUTH_PATH=/data/baileys-auth`
   - `AUTO_RECONNECT=true`
   - `LOG_LEVEL=info`
   - `API_KEY` to a long random secret
   - `ALLOWED_RECIPIENTS` to the test numbers you will message, or `ALLOW_ALL_RECIPIENTS=true` only if unrestricted sending is intentional
   - Leave `PORT` unset so Railway can inject it
   - Leave the send-limit variables unset to keep the conservative defaults
7. Deploy one replica only. Do not enable horizontal scaling for this service.
8. After the deploy is healthy, pair the account once:

```powershell
$base = "https://YOUR-SERVICE.up.railway.app"
$headers = @{ Authorization = "Bearer YOUR_API_KEY" }
Invoke-RestMethod "$base/health"
Invoke-RestMethod "$base/api/session/qr" -Headers $headers
```

`npm run qr` talks to localhost only. Against Railway, render the payload in the terminal without printing the raw string or pasting it into a website:

```powershell
$qr = (Invoke-RestMethod "$base/api/session/qr" -Headers $headers).qr
npx --yes qrcode --type terminal $qr
Remove-Variable qr
```

9. Confirm `GET /api/session/status` reports `CONNECTED`.
10. Redeploy or restart the service. With the volume still mounted, status should return to `CONNECTED` without a new scan.
11. To unlink, `POST /api/session/logout`. Automatic retries stop. A later `POST /api/session/connect` starts a new pairing session.

The healthcheck only proves the HTTP process is up. It does not prove WhatsApp is connected. Use `/api/session/status` for that.

Redeploys can drop the process for a short time. WhatsApp itself can also disconnect the socket. Recoverable drops retry until the maximum delay of 60 seconds.

The container runs as root so a freshly attached Railway volume at `/data` is writable. On Linux the app sets the auth directory to mode `0700`. Windows local development does not enforce that mode.

## Manual checks after deploy

These were not executed against a live WhatsApp account or Railway in this workspace:

- First QR scan links the account.
- The phone's Linked devices list shows the session.
- An authenticated status request returns `CONNECTED`.
- A process restart keeps the same pairing.
- A Railway redeploy keeps the pairing while the volume remains.
- A temporary network drop returns to `CONNECTED` without a QR.
- Logout stops retries.
- `POST /api/session/connect` after logout can show a QR again.

## Layout

```text
src/
  app.ts                  Express app
  server.ts               Process startup and signals
  config/                 Environment validation, messaging limits, logger
  core/whatsapp/          Socket, auth files, retry policy, status
  core/messaging/         Send coordinator, validation, idempotency
  core/interfaces/        WhatsAppConnectionProvider
  api/                    Session and message routes, API key, rate limit
tests/                    Unit and HTTP tests with a fake socket
```

## Limitations

- One WhatsApp account and one outbound coordinator per process. Do not run a second replica against the same auth volume.
- Auth files are the Baileys multi-file helper, not a database. A crash while a file is half-written can force a new QR. Treat the volume as the session.
- QR responses use `expiresAt: null`. Baileys does not include a reliable expiry on `connection.update`. The gateway replaces the stored payload when a new QR arrives.
- The gateway does not fetch the latest WhatsApp Web version at startup. If WhatsApp rejects the version bundled in Baileys 6.7.24, bump that dependency and redeploy.
- `sent` means Baileys returned a message id. It does not mean WhatsApp delivered or displayed the message.
- Idempotency and send quotas live in process memory. They reset on restart or deploy. A retry after a restart can send the message again.
- A timed-out send is `unknown` and is not retried. New sends stay paused until that Baileys call finishes.
- The default allowlist is empty, so a fresh deploy does not send until you configure recipients or explicitly allow all numbers.
- The numeric send limits are conservative application guards. They are not a guarantee that WhatsApp will accept the traffic.
- No inbound messages, replies, media, groups, schedules, delivery receipts, message database, or web UI.
- Docker image build and a real WhatsApp delivery were not executed in this workspace. Automated tests mock Baileys.
