import { Helios } from '../src/helios.js';

/**
 * Example Helios server with session recovery enabled
 *
 * This demonstrates how to configure and use session recovery.
 *
 * To test:
 * 1. Start this server: bun examples/session-recovery-server.js
 * 2. Connect a client (see session-recovery-client.js in starling examples)
 * 3. Disconnect and reconnect - session will be recovered
 */

const PORT = 3000;
const SECRET = process.env.SESSION_SECRET || 'your-secret-key-minimum-32-bytes-long!';

const helios = new Helios({
    sessionRecovery: {
        enabled: true,
        secret: SECRET,
        ttl: 5 * 60 * 1000 // 5 minutes
    }
});

// Track session events
helios.events.on('session:recovered', ({ connection, session }) => {
    console.log('[Session Recovered]', {
        sessionId: session.sessionId,
        connectionId: connection.id,
        dataKeys: Array.from(connection.data.keys())
    });
});

// Example method that sets data on connection
helios.method('user.login', async (payload, context) => {
    const { username } = payload;

    // Store user data on connection
    context.connection.data.set('username', username);
    context.connection.data.set('loginTime', Date.now());

    return {
        success: true,
        message: `Welcome ${username}!`,
        sessionId: context.connection.sessionId
    };
});

// Example method that uses preserved data
helios.method('user.info', async (payload, context) => {
    const username = context.connection.data.get('username');
    const loginTime = context.connection.data.get('loginTime');

    if (!username) {
        return { error: 'Not logged in' };
    }

    return {
        username,
        loginTime,
        sessionAge: Date.now() - loginTime
    };
});

helios.serve({ port: PORT });

console.log(`
✅ Helios server with session recovery started on port ${PORT}

Try this:
1. Connect with a client
2. Call user.login with {username: "your-name"}
3. Disconnect
4. Reconnect within 5 minutes
5. Call user.info - your username will still be there!
`);
