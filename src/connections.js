import { Connection } from './connection.js';

/**
 * @extends {Map<import('bun').ServerWebSocket, Connection>}
 */
export class Connections extends Map {
    /** @param {import('./helios.js').Helios} helios */
    constructor(helios) {
        super(); // Map<WebSocket, Connection>
        this.helios = helios;

        // Session recovery maps
        this.sessionMap = new Map(); // Map<sessionId, Connection>
        this.disconnectedSessions = new Map(); // Map<sessionId, {connection, expiresAt}>

        // Start cleanup interval for expired sessions
        this.startCleanup();
    }

    /** @param {import('bun').ServerWebSocket} ws */
    new(ws) {
        try {
            const connection = new Connection(this.helios, ws);
            this.set(ws, connection);

            // Also add to session map (sessionId will be set later by SessionManager)
            if (connection.sessionId) {
                this.sessionMap.set(connection.sessionId, connection);
            }

            this.helios.events.emit("connection", {connection, helios: this.helios});
            return connection;
        } catch (error) {
            this.delete(ws);
        }
    }

    /**
     * Find a connection by session ID (active or disconnected)
     * @param {string} sessionId
     * @returns {Connection | null}
     */
    findBySessionId(sessionId) {
        // Check active connections first
        let conn = this.sessionMap.get(sessionId);
        if (conn) return conn;

        // Check disconnected sessions
        const disconnected = this.disconnectedSessions.get(sessionId);
        if (disconnected && Date.now() < disconnected.expiresAt) {
            return disconnected.connection;
        }

        return null;
    }

    /**
     * Reconnect an existing connection to a new WebSocket
     * @param {string} sessionId
     * @param {import('bun').ServerWebSocket} newWs
     * @returns {Connection | null}
     */
    reconnect(sessionId, newWs) {
        const connection = this.findBySessionId(sessionId);
        if (!connection) return null;

        // Remove from disconnected if present
        this.disconnectedSessions.delete(sessionId);

        // Update WebSocket mapping
        const oldWs = connection.ws;
        if (oldWs && this.has(oldWs)) {
            this.delete(oldWs);
        }

        // Reconnect the connection
        connection.reconnect(newWs);
        this.set(newWs, connection);

        return connection;
    }

    /**
     * Mark a connection as disconnected but keep it in memory for TTL period
     * @param {import('bun').ServerWebSocket} ws
     */
    markDisconnected(ws) {
        const connection = this.get(ws);
        if (!connection || !connection.sessionId) return;

        // Remove from ws->connection map
        this.delete(ws);

        // Add to disconnected with TTL
        const ttl = this.helios.options.sessionRecovery?.ttl || 5 * 60 * 1000;
        this.disconnectedSessions.set(connection.sessionId, {
            connection,
            expiresAt: Date.now() + ttl
        });
    }

    /**
     * Start periodic cleanup of expired sessions
     */
    startCleanup() {
        setInterval(() => {
            const now = Date.now();
            for (const [sessionId, {connection, expiresAt}] of this.disconnectedSessions) {
                if (now >= expiresAt) {
                    // Stop health check timers before cleanup
                    connection.stopHealthCheck();

                    // Really cleanup now
                    this.sessionMap.delete(sessionId);
                    this.disconnectedSessions.delete(sessionId);

                    // Additional cleanup if connection has cleanup method
                    if (typeof connection.cleanup === 'function') {
                        connection.cleanup();
                    }
                }
            }
        }, 60000); // Every minute
    }
}

