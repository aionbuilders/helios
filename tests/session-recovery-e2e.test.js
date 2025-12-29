import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { Helios } from '../src/helios.js';
import { Starling } from '@aionbuilders/starling';
import { InMemorySessionStorage } from '@aionbuilders/starling/src/session/SessionStorage.js';

const PORT = 8765;
const SECRET = 'test-secret-key-for-session-recovery-minimum-32-bytes';

describe('Session Recovery E2E', () => {
    let helios;
    let server;

    beforeAll(async () => {
        // Start Helios server with session recovery enabled
        helios = new Helios({
            sessionRecovery: {
                enabled: true,
                secret: SECRET,
                ttl: 10000 // 10 seconds for testing
            }
        });

        server = helios.serve({ port: PORT });
    });

    afterAll(() => {
        server?.stop();
    });

    test('should create and save session token on first connection', async () => {
        const storage = new InMemorySessionStorage();

        const client = new Starling({
            url: `ws://localhost:${PORT}`,
            sessionRecovery: {
                enabled: true,
                storage
            }
        });

        // Wait for session:created event
        const sessionPromise = new Promise((resolve) => {
            client.topics.on('session:created', resolve);
        });

        await client.connect();

        const session = await sessionPromise;
        expect(session.token).toBeDefined();
        expect(typeof session.token).toBe('string');

        // Verify token was saved to storage
        const savedToken = await storage.load();
        expect(savedToken).toBe(session.token);

        client.websocket?.close();
    });

    test('should recover session after disconnection', async () => {
        const storage = new InMemorySessionStorage();

        // First connection
        const client1 = new Starling({
            url: `ws://localhost:${PORT}`,
            sessionRecovery: {
                enabled: true,
                storage
            }
        });

        await client1.connect();

        // Wait for session token
        await new Promise((resolve) => {
            client1.topics.on('session:created', resolve);
        });

        const token = await storage.load();
        expect(token).toBeDefined();

        // Set some data on the connection (server-side)
        // This will be preserved across reconnection
        const connection1 = Array.from(helios.connections.values())[0];
        connection1.data.set('test-key', 'test-value');
        const sessionId = connection1.sessionId;

        // Disconnect
        client1.websocket?.close();

        // Wait a bit for disconnection
        await new Promise(resolve => setTimeout(resolve, 100));

        // Second connection - should recover
        const client2 = new Starling({
            url: `ws://localhost:${PORT}`,
            sessionRecovery: {
                enabled: true,
                storage, // Same storage with token
                autoRecover: true
            }
        });

        const recoveryPromise = new Promise((resolve, reject) => {
            client2.topics.on('session:recovered', resolve);
            client2.topics.on('session:recovery-failed', (data) => reject(new Error(data.reason)));
        });

        await client2.connect();
        const recovered = await recoveryPromise;

        expect(recovered.sessionId).toBe(sessionId);

        // Verify data was preserved
        const connection2 = Array.from(helios.connections.values())[0];
        expect(connection2.data.get('test-key')).toBe('test-value');
        expect(connection2.sessionId).toBe(sessionId);

        client2.websocket?.close();
    });

    test('should fail recovery with invalid token', async () => {
        const storage = new InMemorySessionStorage();

        // Save an invalid token
        await storage.save('invalid.token.here');

        const client = new Starling({
            url: `ws://localhost:${PORT}`,
            sessionRecovery: {
                enabled: true,
                storage,
                autoRecover: true
            }
        });

        const failurePromise = new Promise((resolve) => {
            client.topics.on('session:recovery-failed', resolve);
        });

        const newSessionPromise = new Promise((resolve) => {
            client.topics.on('session:created', resolve);
        });

        await client.connect();

        // Should fail recovery
        const failure = await failurePromise;
        expect(failure.reason).toBeDefined();

        // Should create new session
        const newSession = await newSessionPromise;
        expect(newSession.token).toBeDefined();

        // Storage should be cleared
        const savedToken = await storage.load();
        expect(savedToken).not.toBe('invalid.token.here');

        client.websocket?.close();
    });

    test('should fail recovery with expired session', async () => {
        const storage = new InMemorySessionStorage();

        // Create very short TTL server
        const shortTtlHelios = new Helios({
            sessionRecovery: {
                enabled: true,
                secret: SECRET,
                ttl: 100 // 100ms
            }
        });

        const shortTtlServer = shortTtlHelios.serve({ port: PORT + 1 });

        try {
            const client1 = new Starling({
                url: `ws://localhost:${PORT + 1}`,
                sessionRecovery: {
                    enabled: true,
                    storage
                }
            });

            await client1.connect();

            await new Promise((resolve) => {
                client1.topics.on('session:created', resolve);
            });

            client1.websocket?.close();

            // Wait for session to expire (TTL = 100ms + buffer)
            await new Promise(resolve => setTimeout(resolve, 200));

            // Try to reconnect after expiration
            const client2 = new Starling({
                url: `ws://localhost:${PORT + 1}`,
                sessionRecovery: {
                    enabled: true,
                    storage,
                    autoRecover: true
                }
            });

            const failurePromise = new Promise((resolve) => {
                client2.topics.on('session:recovery-failed', resolve);
            });

            await client2.connect();

            const failure = await failurePromise;
            expect(failure.reason).toContain('expired');

            client2.websocket?.close();
        } finally {
            shortTtlServer.stop();
        }
    });

    test('should handle multiple reconnections', async () => {
        const storage = new InMemorySessionStorage();

        for (let i = 0; i < 3; i++) {
            const client = new Starling({
                url: `ws://localhost:${PORT}`,
                sessionRecovery: {
                    enabled: true,
                    storage,
                    autoRecover: i > 0 // First connection creates, rest recover
                }
            });

            if (i === 0) {
                await new Promise((resolve) => {
                    client.topics.on('session:created', resolve);
                    client.connect();
                });
            } else {
                await new Promise((resolve) => {
                    client.topics.on('session:recovered', resolve);
                    client.connect();
                });
            }

            client.websocket?.close();
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        expect(true).toBe(true); // If we get here, multiple reconnections worked
    });
});
