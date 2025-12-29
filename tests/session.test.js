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
});
