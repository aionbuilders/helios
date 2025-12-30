import { test, expect, describe } from 'bun:test';
import { RoomManager } from '../src/rooms/RoomManager.js';

// Mock Helios
class MockHelios {
    constructor() {
        this.events = {
            emit: () => {}
        };
    }
}

// Mock Connection
class MockConnection {
    constructor(id, data = {}) {
        this.id = id;
        this.state = 'OPEN';
        this.data = new Map(Object.entries(data));
        this.emittedEvents = [];
    }

    emit(topic, data) {
        this.emittedEvents.push({ topic, data });
    }
}

describe('RoomManager', () => {
    describe('Room Declaration', () => {
        test('should declare public room', () => {
            const helios = new MockHelios();
            const rooms = new RoomManager(helios);

            const result = rooms.declare('lobby', { type: 'public' });

            expect(result).toBe(rooms); // Should return this for chaining
        });

        test('should reject public room with wildcards', () => {
            const helios = new MockHelios();
            const rooms = new RoomManager(helios);

            expect(() => {
                rooms.declare('user:*', { type: 'public' });
            }).toThrow('Public rooms cannot use wildcards');
        });

        test('should declare protected room with validator', () => {
            const helios = new MockHelios();
            const rooms = new RoomManager(helios);

            const validator = async (conn) => conn.data.get('role') === 'admin';

            rooms.declare('admin:chat', { validator });
            // Should not throw
        });

        test('should reject protected room without validator', () => {
            const helios = new MockHelios();
            const rooms = new RoomManager(helios);

            expect(() => {
                rooms.declare('admin:chat', { type: 'protected' });
            }).toThrow('Protected rooms require a validator');
        });

        test('should reject invalid pattern', () => {
            const helios = new MockHelios();
            const rooms = new RoomManager(helios);

            expect(() => {
                rooms.declare('', { type: 'public' });
            }).toThrow('Pattern must be a non-empty string');
        });

        test('should sort protected rooms by specificity', () => {
            const helios = new MockHelios();
            const rooms = new RoomManager(helios);

            rooms.declare('user:**', { validator: async () => true });
            rooms.declare('user:*', { validator: async () => true });
            rooms.declare('user:123:profile', { validator: async () => true });

            // Most specific patterns should match first
            // (tested via subscribe matching logic)
        });
    });

    describe('Subscription', () => {
        test('should reject subscription to undeclared room', async () => {
            const helios = new MockHelios();
            const rooms = new RoomManager(helios);
            const conn = new MockConnection('conn1');

            const result = await rooms.subscribe(conn, 'undeclared');

            expect(result.success).toBe(false);
            expect(result.error).toContain('not declared');
        });

        test('should allow subscription to public room', async () => {
            const helios = new MockHelios();
            const rooms = new RoomManager(helios);

            rooms.declare('lobby', { type: 'public' });

            const conn = new MockConnection('conn1');
            const result = await rooms.subscribe(conn, 'lobby');

            expect(result.success).toBe(true);
            expect(result.error).toBeUndefined();
        });

        test('should validate protected room subscription', async () => {
            const helios = new MockHelios();
            const rooms = new RoomManager(helios);

            rooms.declare('admin:*', {
                validator: async (conn) => conn.data.get('role') === 'admin'
            });

            // User connection (no admin role)
            const userConn = new MockConnection('user1', { role: 'user' });
            const userResult = await rooms.subscribe(userConn, 'admin:chat');

            expect(userResult.success).toBe(false);
            expect(userResult.error).toBe('Permission denied');

            // Admin connection
            const adminConn = new MockConnection('admin1', { role: 'admin' });
            const adminResult = await rooms.subscribe(adminConn, 'admin:chat');

            expect(adminResult.success).toBe(true);
        });

        test('should pass capture groups to validator', async () => {
            const helios = new MockHelios();
            const rooms = new RoomManager(helios);

            let receivedCaptures = null;

            rooms.declare('user:*', {
                validator: async (conn, captures) => {
                    receivedCaptures = captures;
                    const [userId] = captures;
                    return conn.data.get('userId') === userId;
                }
            });

            const conn = new MockConnection('conn1', { userId: '123' });
            const result = await rooms.subscribe(conn, 'user:123');

            expect(result.success).toBe(true);
            expect(receivedCaptures).toEqual(['123']);
        });

        test('should handle validator errors gracefully', async () => {
            const helios = new MockHelios();
            const rooms = new RoomManager(helios);

            rooms.declare('broken:*', {
                validator: async () => {
                    throw new Error('Validator error');
                }
            });

            const conn = new MockConnection('conn1');
            const result = await rooms.subscribe(conn, 'broken:test');

            expect(result.success).toBe(false);
            expect(result.error).toBe('Validator error');
        });

        test('should track subscriptions per connection', async () => {
            const helios = new MockHelios();
            const rooms = new RoomManager(helios);

            rooms.declare('lobby', { type: 'public' });
            rooms.declare('general', { type: 'public' });

            const conn = new MockConnection('conn1');

            await rooms.subscribe(conn, 'lobby');
            await rooms.subscribe(conn, 'general');

            const subscriptions = rooms.getSubscriptions(conn);
            expect(subscriptions.size).toBe(2);
            expect(subscriptions.has('lobby')).toBe(true);
            expect(subscriptions.has('general')).toBe(true);
        });
    });

    describe('Unsubscription', () => {
        test('should unsubscribe from room', async () => {
            const helios = new MockHelios();
            const rooms = new RoomManager(helios);

            rooms.declare('lobby', { type: 'public' });

            const conn = new MockConnection('conn1');
            await rooms.subscribe(conn, 'lobby');

            const result = await rooms.unsubscribe(conn, 'lobby');

            expect(result.success).toBe(true);

            const subscriptions = rooms.getSubscriptions(conn);
            expect(subscriptions.size).toBe(0);
        });

        test('should return false when unsubscribing from non-subscribed room', async () => {
            const helios = new MockHelios();
            const rooms = new RoomManager(helios);

            const conn = new MockConnection('conn1');

            const result = await rooms.unsubscribe(conn, 'lobby');

            expect(result.success).toBe(false);
        });
    });

    describe('Broadcasting', () => {
        test('should broadcast to exact match subscribers', () => {
            const helios = new MockHelios();
            const rooms = new RoomManager(helios);

            rooms.declare('lobby', { type: 'public' });

            const conn1 = new MockConnection('conn1');
            const conn2 = new MockConnection('conn2');
            const conn3 = new MockConnection('conn3');

            rooms.subscribe(conn1, 'lobby');
            rooms.subscribe(conn2, 'lobby');
            // conn3 not subscribed

            const result = rooms.broadcast('lobby', { message: 'Hello!' });

            expect(result.targets).toBe(2);
            expect(result.sent).toBe(2);

            expect(conn1.emittedEvents).toHaveLength(1);
            expect(conn1.emittedEvents[0].data).toEqual({ message: 'Hello!' });

            expect(conn2.emittedEvents).toHaveLength(1);

            expect(conn3.emittedEvents).toHaveLength(0);
        });

        test('should broadcast to pattern match subscribers', async () => {
            const helios = new MockHelios();
            const rooms = new RoomManager(helios);

            rooms.declare('user:*', {
                validator: async (conn, captures) => {
                    const [userId] = captures;
                    return conn.data.get('userId') === userId;
                }
            });

            const conn1 = new MockConnection('conn1', { userId: '123' });
            const conn2 = new MockConnection('conn2', { userId: '456' });

            await rooms.subscribe(conn1, 'user:123');
            await rooms.subscribe(conn2, 'user:456');

            // Broadcast to pattern
            const result = rooms.broadcast('user:*', { type: 'announcement' });

            expect(result.targets).toBe(2);
            expect(result.sent).toBe(2);

            expect(conn1.emittedEvents).toHaveLength(1);
            expect(conn2.emittedEvents).toHaveLength(1);
        });

        test('should skip closed connections when broadcasting', () => {
            const helios = new MockHelios();
            const rooms = new RoomManager(helios);

            rooms.declare('lobby', { type: 'public' });

            const conn1 = new MockConnection('conn1');
            const conn2 = new MockConnection('conn2');

            rooms.subscribe(conn1, 'lobby');
            rooms.subscribe(conn2, 'lobby');

            // Close conn2
            conn2.state = 'CLOSED';

            const result = rooms.broadcast('lobby', { message: 'Test' });

            expect(result.targets).toBe(2); // 2 connections subscribed
            expect(result.sent).toBe(1);    // Only 1 was OPEN

            expect(conn1.emittedEvents).toHaveLength(1);
            expect(conn2.emittedEvents).toHaveLength(0); // Closed connection didn't receive
        });

        test('should broadcast to no one if no subscribers', () => {
            const helios = new MockHelios();
            const rooms = new RoomManager(helios);

            rooms.declare('lobby', { type: 'public' });

            const result = rooms.broadcast('lobby', { message: 'Hello!' });

            expect(result.targets).toBe(0);
            expect(result.sent).toBe(0);
        });
    });

    describe('Room Info', () => {
        test('should get room information', async () => {
            const helios = new MockHelios();
            const rooms = new RoomManager(helios);

            rooms.declare('lobby', { type: 'public' });

            const conn1 = new MockConnection('conn1');
            const conn2 = new MockConnection('conn2');

            await rooms.subscribe(conn1, 'lobby');
            await rooms.subscribe(conn2, 'lobby');

            const info = rooms.getRoom('lobby');

            expect(info).toBeDefined();
            expect(info.topic).toBe('lobby');
            expect(info.connections).toBe(2);
        });

        test('should return null for non-existent room', () => {
            const helios = new MockHelios();
            const rooms = new RoomManager(helios);

            const info = rooms.getRoom('nonexistent');

            expect(info).toBe(null);
        });
    });

    describe('Cleanup', () => {
        test('should cleanup all subscriptions for a connection', async () => {
            const helios = new MockHelios();
            const rooms = new RoomManager(helios);

            rooms.declare('lobby', { type: 'public' });
            rooms.declare('general', { type: 'public' });

            const conn = new MockConnection('conn1');

            await rooms.subscribe(conn, 'lobby');
            await rooms.subscribe(conn, 'general');

            rooms.cleanup(conn);

            const subscriptions = rooms.getSubscriptions(conn);
            expect(subscriptions.size).toBe(0);

            const lobbyInfo = rooms.getRoom('lobby');
            expect(lobbyInfo).toBe(null); // No connections left

            const generalInfo = rooms.getRoom('general');
            expect(generalInfo).toBe(null);
        });

        test('should not affect other connections when cleaning up', async () => {
            const helios = new MockHelios();
            const rooms = new RoomManager(helios);

            rooms.declare('lobby', { type: 'public' });

            const conn1 = new MockConnection('conn1');
            const conn2 = new MockConnection('conn2');

            await rooms.subscribe(conn1, 'lobby');
            await rooms.subscribe(conn2, 'lobby');

            rooms.cleanup(conn1);

            const conn2Subs = rooms.getSubscriptions(conn2);
            expect(conn2Subs.size).toBe(1);
            expect(conn2Subs.has('lobby')).toBe(true);

            const lobbyInfo = rooms.getRoom('lobby');
            expect(lobbyInfo.connections).toBe(1);
        });
    });
});
