# Helius WebSocket Proxy

A NestJS WebSocket proxy that multiplexes client connections onto a single upstream [Helius](https://helius.dev) Solana RPC WebSocket. Clients connect to the proxy, send lightweight subscribe/unsubscribe messages, and receive real-time notifications (account changes, program logs, slot updates, etc.) without each needing their own Helius connection.

## Architecture

```
┌────────┐          ┌──────────────────────────────────────────────┐          ┌────────┐
│Client A│─ ws ──▶  │  WsProxyGateway (/ws)                       │          │        │
├────────┤          │    │                                         │          │ Helius │
│Client B│─ ws ──▶  │    ▼                                         │  single  │  RPC   │
├────────┤          │  SubscriptionsService ──▶ UpstreamService ───┼── ws ──▶ │  WS    │
│Client C│─ ws ──▶  │    ▲                                         │          │        │
└────────┘          │    │                                         │          └────────┘
                    │  ClientConnectionService                     │
                    │  (tracks open sockets)                       │
                    └──────────────────────────────────────────────┘
```

## How It Works

- **Client connections** — Clients open a WebSocket to `/ws`. The gateway assigns each connection a UUID and registers it with `ClientConnectionService`.
- **Subscription lifecycle** — A client sends `{ "action": "subscribe", "method": "accountSubscribe", "params": [...] }`. `SubscriptionsService` forwards the RPC call upstream and maps the returned Helius subscription ID to an internal proxy ID, which is sent back to the client.
- **Notification routing** — When Helius pushes a notification, the `upstream.notification` event fires. `SubscriptionsService` looks up the proxy subscription by Helius ID and forwards the payload to the owning client via `ClientConnectionService`.
- **Reconnection** — If the upstream WebSocket drops, `UpstreamService` reconnects with exponential backoff (1 s → 30 s cap). On reconnect, `SubscriptionsService` re-subscribes all active subscriptions so clients see no interruption.
- **Idle cleanup** — When a client disconnects or explicitly unsubscribes, the upstream subscription isn't torn down immediately. A configurable grace period (`IDLE_TIMEOUT_MS`, default 5 min) allows the client to reconnect and reuse the subscription before it is cleaned up.

## Getting Started

```bash
cp .env.example .env
# fill in your HELIUS_API_KEY

npm install
npm run start:dev
```

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `HELIUS_API_KEY` | Your Helius API key | *(required)* |
| `HELIUS_WS_URL` | Helius WebSocket base URL | `wss://mainnet.helius-rpc.com` |
| `PORT` | HTTP / WS listen port | `3000` |
| `IDLE_TIMEOUT_MS` | Grace period before tearing down an idle upstream subscription | `300000` (5 min) |
| `ALLOWED_ORIGINS` | Comma-separated list of allowed CORS origins | `http://localhost:3000` |

## Deployment

A multi-stage `Dockerfile` and a `fly.toml` for [Fly.io](https://fly.io) are included. The Fly config runs a single `shared-cpu-1x` machine with 512 MB RAM, auto-stop/start enabled, and a connection concurrency limit of 800/1000 (soft/hard).

```bash
fly deploy
```

## Scaling Strategies

The current design uses a single upstream WebSocket per instance. Here are strategies for scaling beyond that.

### Fan-out (multiple upstream connections per instance)

Open N upstream WebSocket connections and shard subscriptions across them (e.g. by hashing the subscription method + params). This raises the per-instance subscription ceiling without adding more machines.

### Multi-instance with sticky sessions

Run multiple proxy instances behind a load balancer configured with sticky sessions (e.g. cookie- or IP-based affinity). Each client's WebSocket is pinned to one instance, and each instance maintains its own upstream connection. Simple to deploy but subscription state is not shared across instances.

### Leader/follower with internal pub/sub

A single leader instance holds the upstream Helius connection. Follower instances accept client connections and proxy subscribe/unsubscribe requests to the leader over an internal channel (e.g. Redis Pub/Sub). The leader fans notifications back out to followers, which forward them to their clients. This avoids duplicate upstream subscriptions across instances.

### Shared subscription dedup

The codebase includes `canonical-key.util.ts`, which produces a stable SHA-256 key for any `(method, params)` pair. This is intended for future use: when multiple clients subscribe with identical parameters, the proxy can share a single upstream subscription and fan out notifications locally, reducing upstream load.

## Health Check

```
GET /health
```

Returns:

```json
{
  "status": "ok",
  "upstreamConnected": true,
  "connectedClients": 3,
  "upstreamSubscriptions": 2,
  "clientSubscriptions": 2,
  "connections": 3
}
```
