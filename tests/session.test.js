import { test, expect, describe } from 'bun:test';
import { SessionManager } from '../src/session/SessionManager.js';

// Mock Connection class for testing
class MockConnection {
    constructor() {
        this.id = crypto.randomUUID();
        this.sessionId = null;
    }
}

describe('SessionManager', () => {
    const secret = 'test-secret-key-at-least-32-bytes-long';

    test('should throw error without secret', () => {
        expect(() => new SessionManager({})).toThrow('SessionManager requires a secret key');
    });

    test('should create SessionManager with secret', () => {
        const manager = new SessionManager({ secret });
        expect(manager).toBeDefined();
        expect(manager.ttl).toBe(5 * 60 * 1000); // default 5 minutes
    });

    test('should create SessionManager with custom TTL', () => {
        const manager = new SessionManager({ secret, ttl: 10000 });
        expect(manager.ttl).toBe(10000);
    });

    test('should create valid JWT token', async () => {
        const manager = new SessionManager({ secret });
        const connection = new MockConnection();

        const token = await manager.create(connection);

        expect(token).toBeDefined();
        expect(typeof token).toBe('string');
        expect(token).toMatch(/^eyJ/); // JWT starts with eyJ
    });

    test('should set sessionId on connection when creating token', async () => {
        const manager = new SessionManager({ secret });
        const connection = new MockConnection();

        expect(connection.sessionId).toBeNull();

        await manager.create(connection);

        expect(connection.sessionId).toBeDefined();
        expect(connection.sessionId).toMatch(/^sess-/);
    });

    test('should verify valid token', async () => {
        const manager = new SessionManager({ secret });
        const connection = new MockConnection();

        const token = await manager.create(connection);
        const session = await manager.verify(token);

        expect(session).toBeDefined();
        expect(session.sessionId).toBe(connection.sessionId);
        expect(session.connectionId).toBe(connection.id);
        expect(session.metadata).toEqual({});
    });

    test('should include metadata in token', async () => {
        const manager = new SessionManager({ secret });
        const connection = new MockConnection();
        const metadata = { userId: '123', role: 'admin' };

        const token = await manager.create(connection, metadata);
        const session = await manager.verify(token);

        expect(session.metadata).toEqual(metadata);
    });

    test('should reject invalid token', async () => {
        const manager = new SessionManager({ secret });

        const session = await manager.verify('invalid.token.here');

        expect(session).toBeNull();
    });

    test('should reject token with wrong secret', async () => {
        const manager1 = new SessionManager({ secret: 'secret1' });
        const manager2 = new SessionManager({ secret: 'secret2' });
        const connection = new MockConnection();

        const token = await manager1.create(connection);
        const session = await manager2.verify(token);

        expect(session).toBeNull();
    });

    test('should reject expired token', async () => {
        const manager = new SessionManager({ secret, ttl: -1000 }); // Already expired
        const connection = new MockConnection();

        const token = await manager.create(connection);

        // Wait a tiny bit to ensure expiration
        await new Promise(resolve => setTimeout(resolve, 10));

        const session = await manager.verify(token);

        expect(session).toBeNull();
    });

    test('should have iat and exp claims', async () => {
        const manager = new SessionManager({ secret, ttl: 60000 }); // 1 minute
        const connection = new MockConnection();

        const token = await manager.create(connection);
        const session = await manager.verify(token);

        expect(session.iat).toBeDefined();
        expect(session.exp).toBeDefined();
        expect(session.exp).toBeGreaterThan(session.iat);
    });

    test('should refresh token with same sessionId', async () => {
        const manager = new SessionManager({ secret });
        const connection = new MockConnection();

        // Create initial token
        const token1 = await manager.create(connection);
        const session1 = await manager.verify(token1);

        // Wait 1 second to ensure different timestamp (JWT uses seconds)
        await new Promise(resolve => setTimeout(resolve, 1100));

        // Refresh token
        const token2 = await manager.refresh(connection);
        const session2 = await manager.verify(token2);

        // SessionId should be the same
        expect(session2.sessionId).toBe(session1.sessionId);
        expect(session2.connectionId).toBe(session1.connectionId);

        // But tokens should be different (different timestamps)
        expect(token2).not.toBe(token1);
    });

    test('should throw error when refreshing without sessionId', async () => {
        const manager = new SessionManager({ secret });
        const connection = new MockConnection();

        await expect(manager.refresh(connection)).rejects.toThrow('Cannot refresh: connection has no sessionId');
    });

    test('should refresh token with new expiration', async () => {
        const manager = new SessionManager({ secret, ttl: 60000 });
        const connection = new MockConnection();

        // Create initial token
        const token1 = await manager.create(connection);
        const session1 = await manager.verify(token1);

        // Wait 1 second to ensure different timestamp (JWT uses seconds)
        await new Promise(resolve => setTimeout(resolve, 1100));

        // Refresh
        const token2 = await manager.refresh(connection);
        const session2 = await manager.verify(token2);

        // Expiration should be newer (later timestamp)
        expect(session2.exp).toBeGreaterThan(session1.exp);
        expect(session2.iat).toBeGreaterThan(session1.iat);
    });
});

// Mock Helios for Connection tests
class MockHelios {
    constructor(ttl = 5000) {
        this.sessionManager = new SessionManager({
            secret: 'test-secret-key-at-least-32-bytes-long',
            ttl
        });
    }
}

describe('Connection Token Refresh Rate Limiting', () => {
    test('canRefreshToken returns false without sessionId', async () => {
        const { Connection } = await import('../src/connection.js');
        const helios = new MockHelios();
        const ws = {}; // Mock WebSocket
        const connection = new Connection(helios, ws);

        expect(connection.canRefreshToken()).toBe(false);
    });

    test('canRefreshToken returns false immediately after creation', async () => {
        const { Connection } = await import('../src/connection.js');
        const helios = new MockHelios(10000); // 10s TTL
        const ws = {};
        const connection = new Connection(helios, ws);
        connection.sessionId = 'sess-test';

        // Should not be able to refresh immediately (< TTL/2)
        expect(connection.canRefreshToken()).toBe(false);
    });

    test('canRefreshToken returns true after TTL/2', async () => {
        const { Connection } = await import('../src/connection.js');
        const helios = new MockHelios(200); // 200ms TTL
        const ws = {};
        const connection = new Connection(helios, ws);
        connection.sessionId = 'sess-test';

        // Should not be able to refresh immediately
        expect(connection.canRefreshToken()).toBe(false);

        // Wait for TTL/2 (100ms)
        await new Promise(resolve => setTimeout(resolve, 110));

        // Now should be able to refresh
        expect(connection.canRefreshToken()).toBe(true);
    });

    test('getTimeUntilRefreshAllowed returns correct wait time', async () => {
        const { Connection } = await import('../src/connection.js');
        const helios = new MockHelios(1000); // 1s TTL
        const ws = {};
        const connection = new Connection(helios, ws);
        connection.sessionId = 'sess-test';

        // Initially should wait ~500ms
        const wait1 = connection.getTimeUntilRefreshAllowed();
        expect(wait1).toBeGreaterThan(400);
        expect(wait1).toBeLessThanOrEqual(500);

        // After 300ms, should wait ~200ms
        await new Promise(resolve => setTimeout(resolve, 300));
        const wait2 = connection.getTimeUntilRefreshAllowed();
        expect(wait2).toBeGreaterThan(100);
        expect(wait2).toBeLessThanOrEqual(200);

        // After TTL/2, should be 0
        await new Promise(resolve => setTimeout(resolve, 250));
        const wait3 = connection.getTimeUntilRefreshAllowed();
        expect(wait3).toBe(0);
    });

    test('lastTokenRefresh updates correctly', async () => {
        const { Connection } = await import('../src/connection.js');
        const helios = new MockHelios();
        const ws = {};

        const before = Date.now();
        const connection = new Connection(helios, ws);
        const after = Date.now();

        expect(connection.lastTokenRefresh).toBeGreaterThanOrEqual(before);
        expect(connection.lastTokenRefresh).toBeLessThanOrEqual(after);
    });
});
