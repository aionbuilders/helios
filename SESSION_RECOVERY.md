# Session Recovery

Session Recovery allows clients to reconnect after network disruptions and restore their previous session state without data loss.

## Features

- 🔐 **JWT-based session tokens** - Secure, signed tokens prevent spoofing
- 💾 **Automatic state preservation** - Connection data, subscriptions, and pending requests survive disconnection
- ⚡ **Zero serialization** - Connection instances stay in memory for performance
- 🔄 **Automatic recovery** - Clients reconnect seamlessly with stored tokens
- ⏰ **Configurable TTL** - Sessions expire after inactivity (default: 5 minutes)
- 🎯 **Simple API** - Enable with minimal configuration

## Server Setup (Helios)

```javascript
import { Helios } from '@aionbuilders/helios';

const helios = new Helios({
    sessionRecovery: {
        enabled: true,
        secret: process.env.SESSION_SECRET, // Required: 32+ bytes
        ttl: 5 * 60 * 1000 // Optional: 5 minutes default
    }
});

helios.serve({ port: 3000 });
```

### What Gets Preserved

When a client reconnects with a valid session token, the **Connection instance** is reused with all its state:

- ✅ `connection.data` Map - Custom state you've stored
- ✅ `connection.topics` subscriptions - Event listeners
- ✅ `connection.pendingRequests` - In-flight requests complete normally
- ✅ All properties added to Connection - Future features automatically work

### Session Events

```javascript
// Server-side events
helios.events.on('session:recovered', ({ connection, session }) => {
    console.log('Session recovered:', session.sessionId);
    // connection is the same instance from before disconnection
});
```

### Example: Preserving User Data

```javascript
helios.method('user.login', (context) => {
    const { username, userId } = context.payload;

    // Store on connection
    context.connection.data.set('user', { username, userId });
    context.connection.data.set('loginTime', Date.now());

    return { success: true };
});

helios.method('user.info', (context) => {
    // This works even after reconnection!
    const user = context.connection.data.get('user');

    if (!user) {
        return { error: 'Not logged in' };
    }

    return { user, sessionAge: Date.now() - context.connection.data.get('loginTime') };
});
```

## Client Setup (Starling)

```javascript
import { Starling } from '@aionbuilders/starling';

const starling = new Starling({
    url: 'ws://localhost:3000',
    sessionRecovery: {
        enabled: true,
        autoRecover: true // Auto-use stored token on connect (default: true)
    }
});

await starling.connect();
```

### Session Events

```javascript
// Client-side events
starling.topics.on('session:recovered', (data) => {
    console.log('Session recovered!', data.sessionId);
});

starling.topics.on('session:recovery-failed', (data) => {
    console.log('Recovery failed:', data.reason);
    // A new session will be created automatically
});

// Clear session manually (logout)
await starling.clearSession();
```

### Custom Storage

By default:
- **Browser**: Uses `localStorage`
- **Node.js/Bun**: Uses in-memory storage

Override with custom storage:

```javascript
const starling = new Starling({
    url: 'ws://localhost:3000',
    sessionRecovery: {
        enabled: true,
        storage: {
            async save(token) {
                await redis.set('session', token, 'EX', 300);
            },
            async load() {
                return await redis.get('session');
            },
            async clear() {
                await redis.del('session');
            }
        }
    }
});
```

## How It Works

### 1. Session Creation

```
Client connects → Server creates JWT token → Emits session:created → Client saves to storage
```

The JWT contains:
```json
{
  "sessionId": "sess-uuid",
  "connectionId": "conn-uuid",
  "metadata": {},
  "iat": 1234567890,
  "exp": 1234568190
}
```

### 2. Disconnection

```
Client disconnects → Server keeps Connection in memory (with TTL) → waits for reconnection
```

The Connection instance stays alive in memory for the TTL period (default 5 minutes).

### 3. Reconnection

```
Client reconnects with token in URL → Server verifies JWT → Finds existing Connection →
Swaps WebSocket → Emits session:recovered → Everything works as before
```

**URL with token:** `ws://localhost:3000?session_token=eyJhbGc...`

### 4. Expiration

```
TTL exceeded → Server cleans up Connection → Next reconnect creates new session
```

## Security

### Best Practices

1. **Use HTTPS/WSS in production** - Tokens transmitted over secure connection
2. **Strong secret** - Minimum 32 bytes, cryptographically random
3. **Short TTL** - 5-10 minutes max (default: 5 minutes)
4. **Rotate secrets** - Periodically change the signing key
5. **Environment variables** - Never hardcode secrets

```javascript
// ✅ Good
secret: process.env.SESSION_SECRET

// ❌ Bad
secret: 'my-secret'
```

### Threat Model

| Attack | Mitigation |
|--------|------------|
| Token replay | Short TTL, HTTPS only |
| Token forgery | HMAC signature (HS256) |
| Session hijacking | Short TTL, optional IP validation (future) |
| DoS | Rate limiting (P1), TTL cleanup |

## Performance

- **JWT signing**: <1ms
- **JWT verification**: <1ms
- **Memory per session**: <1KB
- **Cleanup overhead**: Negligible (runs every minute)
- **Recovery time**: <100ms total

## Limitations (MVP)

This is the MVP implementation. Future enhancements:

- ❌ **Persistent storage** - Sessions lost on server restart (use Redis in future)
- ❌ **One-time tokens** - Tokens can be replayed within TTL (Phase 2)
- ❌ **IP validation** - No binding to client IP (Phase 2)
- ❌ **Distributed systems** - No cross-server session sharing (P3: Redis pub/sub)

## Examples

See:
- `examples/session-recovery-server.js` - Server example
- `examples/session-recovery-client.js` - Client example (in starling repo)

Run:
```bash
# Terminal 1: Start server
bun examples/session-recovery-server.js

# Terminal 2: Run client
cd ../starling
bun examples/session-recovery-client.js
```

## Troubleshooting

### "Session recovery failed: Invalid token"

- Token expired (TTL exceeded)
- Different secret on server
- Token was manually edited
- **Solution**: Client will automatically start fresh session

### "Session recovery failed: Session expired"

- Server restarted (sessions in memory lost)
- TTL exceeded and cleaned up
- **Solution**: Client will automatically start fresh session

### Session not recovering

- Check `sessionRecovery.enabled` is true on both client and server
- Check `secret` is set on server
- Check token is being saved to storage
- Check autoRecover is true on client (default)

### Memory leak concerns

- Sessions are cleaned up after TTL expires (every minute)
- Connections without sessionId are cleaned immediately
- Use `markDisconnected()` which tracks expiration

## Migration from No Session Recovery

Session recovery is **opt-in** and **backward compatible**:

1. Existing connections without sessionRecovery work normally
2. No breaking changes to existing code
3. Enable gradually per client/server

```javascript
// Old code still works
const helios = new Helios();
const starling = new Starling({ url: '...' });

// New code is opt-in
const helios = new Helios({
    sessionRecovery: { enabled: true, secret: '...' }
});
```

## Next Steps

- P0-2: [Health Checks](./docs/health-checks.md) (ping/pong)
- P0-3: [Peer Routing](./docs/peer-routing.md)
- P1: [Broadcast/Rooms](./docs/rooms.md)

---

**Version**: 1.0.0
**Status**: ✅ Implemented
