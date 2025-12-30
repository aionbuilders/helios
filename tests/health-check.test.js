import { test, expect, describe, beforeEach } from 'bun:test';
import { Helios } from '../src/helios.js';
import { Connection } from '../src/connection.js';

// Mock WebSocket for testing
class MockWebSocket {
    constructor() {
        this.readyState = 1; // OPEN
        this.pingSent = false;
        this.autoRespond = true;
        this.pingCallback = null;
        this.pongCallback = null;
    }

    ping() {
        this.pingSent = true;
        if (this.autoRespond && this.pongCallback) {
            // Simulate pong after 10ms
            setTimeout(() => {
                if (this.pongCallback) this.pongCallback();
            }, 10);
        }
    }

    close(code, reason) {
        this.readyState = 3; // CLOSED
        this.closeCode = code;
        this.closeReason = reason;
    }

    send() {
        // Mock send
    }
}

// Mock Helios for Connection tests
class MockHelios {
    constructor(healthCheckOptions = {}) {
        this.options = {
            healthCheck: {
                enabled: healthCheckOptions.enabled !== false,
                interval: healthCheckOptions.interval || 30000,
                timeout: healthCheckOptions.timeout || 10000,
                maxMissed: healthCheckOptions.maxMissed || 2
            }
        };
        this.events = {
            emit: () => {},
            on: () => {},
            off: () => {}
        };
    }
}

describe('Health Check Configuration', () => {
    test('should use default health check options', () => {
        const helios = new Helios();

        expect(helios.options.healthCheck.enabled).toBe(true);
        expect(helios.options.healthCheck.interval).toBe(30000);
        expect(helios.options.healthCheck.timeout).toBe(10000);
        expect(helios.options.healthCheck.maxMissed).toBe(2);
    });

    test('should accept custom health check options', () => {
        const helios = new Helios({
            healthCheck: {
                enabled: true,
                interval: 15000,
                timeout: 5000,
                maxMissed: 3
            }
        });

        expect(helios.options.healthCheck.enabled).toBe(true);
        expect(helios.options.healthCheck.interval).toBe(15000);
        expect(helios.options.healthCheck.timeout).toBe(5000);
        expect(helios.options.healthCheck.maxMissed).toBe(3);
    });

    test('should allow disabling health checks', () => {
        const helios = new Helios({
            healthCheck: {
                enabled: false
            }
        });

        expect(helios.options.healthCheck.enabled).toBe(false);
    });
});

describe('Connection Health Check State', () => {
    test('should initialize health check properties', () => {
        const helios = new MockHelios();
        const ws = new MockWebSocket();
        const connection = new Connection(helios, ws);

        expect(connection.missedPongs).toBe(0);
        expect(connection.lastPingAt).toBe(null);
        expect(connection.lastPongAt).toBeGreaterThan(0);
        expect(connection.pingIntervalId).toBe(null);
        expect(connection.pingTimeoutId).toBe(null);
    });

    test('should start ping interval when startHealthCheck is called', async () => {
        const helios = new MockHelios({ interval: 100 });
        const ws = new MockWebSocket();
        const connection = new Connection(helios, ws);

        connection.startHealthCheck();

        expect(connection.pingIntervalId).not.toBe(null);

        // Cleanup
        connection.stopHealthCheck();
    });

    test('should stop ping interval when stopHealthCheck is called', () => {
        const helios = new MockHelios({ interval: 100 });
        const ws = new MockWebSocket();
        const connection = new Connection(helios, ws);

        connection.startHealthCheck();
        const intervalId = connection.pingIntervalId;
        expect(intervalId).not.toBe(null);

        connection.stopHealthCheck();

        expect(connection.pingIntervalId).toBe(null);
        expect(connection.pingTimeoutId).toBe(null);
    });

    test('should not start health check when disabled', () => {
        const helios = new MockHelios({ enabled: false });
        const ws = new MockWebSocket();
        const connection = new Connection(helios, ws);

        connection.startHealthCheck();

        expect(connection.pingIntervalId).toBe(null);
    });
});

describe('Ping Logic', () => {
    test('should send ping and track timestamp', () => {
        const helios = new MockHelios();
        const ws = new MockWebSocket();
        const connection = new Connection(helios, ws);

        expect(connection.lastPingAt).toBe(null);
        expect(ws.pingSent).toBe(false);

        connection.sendPing();

        expect(connection.lastPingAt).toBeGreaterThan(0);
        expect(ws.pingSent).toBe(true);
        expect(connection.pingTimeoutId).not.toBe(null);

        // Cleanup
        connection.stopHealthCheck();
    });

    test('should increment missedPongs when no pong received', async () => {
        const helios = new MockHelios({ timeout: 50 });
        const ws = new MockWebSocket();
        ws.autoRespond = false; // Don't respond to pings
        const connection = new Connection(helios, ws);

        expect(connection.missedPongs).toBe(0);

        // Set lastPongAt to old value so timeout check will fail
        connection.lastPongAt = Date.now() - 1000;
        connection.sendPing();

        // Wait for timeout to expire
        await new Promise(resolve => setTimeout(resolve, 100));

        expect(connection.missedPongs).toBeGreaterThanOrEqual(1);

        // Cleanup
        connection.stopHealthCheck();
    });

    test('should close connection after maxMissed pongs', () => {
        const helios = new MockHelios({ maxMissed: 2 });
        const ws = new MockWebSocket();
        const connection = new Connection(helios, ws);

        connection.missedPongs = 2;

        connection.sendPing();

        expect(ws.readyState).toBe(3); // CLOSED
        expect(ws.closeCode).toBe(1000);
        expect(ws.closeReason).toBe('Ping timeout');
    });

    test('should not send ping if connection not OPEN', () => {
        const helios = new MockHelios();
        const ws = new MockWebSocket();
        const connection = new Connection(helios, ws);

        connection.state = 'CLOSED';

        connection.sendPing();

        expect(ws.pingSent).toBe(false);
        expect(connection.pingIntervalId).toBe(null);
    });
});

describe('Pong Handling', () => {
    test('should reset missedPongs counter on pong', () => {
        const helios = new MockHelios();
        const ws = new MockWebSocket();
        const connection = new Connection(helios, ws);

        connection.missedPongs = 2;
        connection.lastPingAt = Date.now() - 100;

        connection.handlePong();

        expect(connection.missedPongs).toBe(0);
    });

    test('should update lastPongAt timestamp', () => {
        const helios = new MockHelios();
        const ws = new MockWebSocket();
        const connection = new Connection(helios, ws);

        const before = Date.now();
        connection.handlePong();
        const after = Date.now();

        expect(connection.lastPongAt).toBeGreaterThanOrEqual(before);
        expect(connection.lastPongAt).toBeLessThanOrEqual(after);
    });

    test('should clear timeout timer on pong', () => {
        const helios = new MockHelios();
        const ws = new MockWebSocket();
        const connection = new Connection(helios, ws);

        // Set a timeout
        connection.pingTimeoutId = setTimeout(() => {}, 1000);
        const timeoutId = connection.pingTimeoutId;
        expect(timeoutId).not.toBe(null);

        connection.handlePong();

        expect(connection.pingTimeoutId).toBe(null);
    });
});

describe('Connection Reconnect', () => {
    test('should reset health check state on reconnect', () => {
        const helios = new MockHelios();
        const oldWs = new MockWebSocket();
        const newWs = new MockWebSocket();
        const connection = new Connection(helios, oldWs);

        // Start health check on old WS
        connection.startHealthCheck();
        const oldIntervalId = connection.pingIntervalId;

        // Simulate some missed pongs
        connection.missedPongs = 2;
        connection.lastPingAt = Date.now() - 5000;

        // Reconnect
        connection.reconnect(newWs);

        // Health check state should be reset
        expect(connection.missedPongs).toBe(0);
        expect(connection.lastPingAt).toBe(null);
        expect(connection.lastPongAt).toBeGreaterThan(0);
        expect(connection.pingIntervalId).not.toBe(oldIntervalId);
        expect(connection.pingIntervalId).not.toBe(null);

        // Cleanup
        connection.stopHealthCheck();
    });
});

describe('Integration Tests', () => {
    test('should maintain healthy connection with regular pongs', async () => {
        const helios = new MockHelios({ interval: 50, timeout: 30 });
        const ws = new MockWebSocket();
        const connection = new Connection(helios, ws);

        // Manually simulate pong responses by calling handlePong after each ping
        let pingCount = 0;
        const originalPing = ws.ping.bind(ws);
        ws.ping = function() {
            originalPing();
            pingCount++;
            // Simulate pong response after 5ms
            setTimeout(() => {
                connection.handlePong();
            }, 5);
        };

        connection.startHealthCheck();

        // Wait for 3 ping intervals
        await new Promise(resolve => setTimeout(resolve, 180));

        // Connection should still be healthy
        expect(connection.missedPongs).toBe(0);
        expect(connection.state).toBe('OPEN');
        expect(pingCount).toBeGreaterThan(0);

        // Cleanup
        connection.stopHealthCheck();
    });

    test('should handle rapid start/stop cycles', () => {
        const helios = new MockHelios();
        const ws = new MockWebSocket();
        const connection = new Connection(helios, ws);

        // Rapid start/stop
        for (let i = 0; i < 10; i++) {
            connection.startHealthCheck();
            connection.stopHealthCheck();
        }

        // Should end in clean state
        expect(connection.pingIntervalId).toBe(null);
        expect(connection.pingTimeoutId).toBe(null);
    });
});
