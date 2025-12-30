import { Pulse } from "@killiandvcz/pulse";
import { HeliosEvent } from "./utils/events.utils";
import { Connections } from "./connections";
import { Parser } from "@aionbuilders/helios-protocol";
import { ProtocolError, MethodManager, EventManager } from "@aionbuilders/helios-protocol";
import { ConnectionClosedError } from "./errors.js";
import { SessionManager } from "./session/SessionManager.js";
import { HeliosRequestContext } from "./requests/RequestContext.js";

/**
 * @typedef {Object} SessionRecoveryOptions
 * @property {boolean} enabled - Enable session recovery (default: false)
 * @property {string} secret - Secret key for JWT signing (required if enabled)
 * @property {number} [ttl=300000] - Session TTL in milliseconds (default: 5 minutes)
 */

/**
 * @typedef {Object} HealthCheckOptions
 * @property {boolean} enabled - Enable health checks (default: true)
 * @property {number} interval - Ping interval in milliseconds (default: 30000)
 * @property {number} timeout - Time to wait for pong in milliseconds (default: 10000)
 * @property {number} maxMissed - Close after N missed pongs (default: 2)
 */

/**
 * @typedef {Object} HeliosOptions
 * @property {number} requestTimeout - Timeout for requests in milliseconds (default: 5000)
 * @property {'strict'|'permissive'|'passthrough'} parseMode - Mode for parsing incoming messages (default: 'strict')
 * @property {SessionRecoveryOptions} [sessionRecovery] - Session recovery configuration
 * @property {HealthCheckOptions} [healthCheck] - Health check configuration
 */

/**
* @typedef {import('bun').WebSocketHandler<any>} WSHandler
*/
export class Helios {
    /** @param {Partial<HeliosOptions>} options */
    constructor(options = {}) {
        /** @type {HeliosOptions} */
        this.options = {
            requestTimeout: options.requestTimeout || 5000,
            parseMode: options.parseMode || 'strict',
            healthCheck: {
                enabled: options.healthCheck?.enabled !== false, // default: true
                interval: options.healthCheck?.interval || 30000, // 30s
                timeout: options.healthCheck?.timeout || 10000, // 10s
                maxMissed: options.healthCheck?.maxMissed || 2
            },
            ...options
        };
        this.events = new Pulse({
            EventClass: HeliosEvent
        });

        this.connections = new Connections(this);

        /** @type {MethodManager<HeliosRequestContext>} */
        this.methods = new MethodManager();
        this.method = this.methods.register.bind(this.methods);
        this.namespace = this.methods.namespace.bind(this.methods);
        this.use = this.methods.use.bind(this.methods);

        this.topics = new EventManager();
        this.on = this.topics.on.bind(this.topics);
        this.off = this.topics.off.bind(this.topics);

        // Initialize session recovery if enabled
        if (options.sessionRecovery?.enabled) {
            this.sessionManager = new SessionManager({
                secret: options.sessionRecovery.secret,
                ttl: options.sessionRecovery.ttl
            });

            // Register session refresh method
            this.method('session.refresh', async (context) => {
                const { connection } = context;

                if (!connection.sessionId) {
                    return { error: 'No active session' };
                }

                // Rate limiting check
                if (!connection.canRefreshToken()) {
                    const waitTime = connection.getTimeUntilRefreshAllowed();
                    return {
                        error: 'Rate limit exceeded',
                        waitMs: waitTime,
                        message: `Please wait ${Math.ceil(waitTime / 1000)}s before refreshing`
                    };
                }

                // Generate new token
                if (!this.sessionManager) {
                    return { error: 'Session recovery not enabled' };
                }
                const newToken = await this.sessionManager.refresh(connection);
                connection.lastTokenRefresh = Date.now();

                // Emit event to client
                connection.emit('session:refreshed', {
                    token: newToken,
                    sessionId: connection.sessionId
                });

                // Emit server event
                this.events.emit('session:refreshed', {
                    connection,
                    token: newToken,
                    helios: this
                });

                return {
                    success: true,
                    token: newToken,
                    sessionId: connection.sessionId
                };
            });
        }
    }
    
    /** @type {import('bun').Server<any> | null | undefined} */
    server;
    
    /** @type {import('bun').WebSocketHandler<any>} */
    websocket = {
        open: (ws) => this.events.emit("open", {ws, helios: this}).then(e => {
            if (e.stopped) return;
            this.handleOpen(ws);
        }),
        message: (ws, message) => this.events.emit("message", {ws, message, helios: this}).then(e => {
            if (e.stopped) return;
            this.handleMessage(ws, message);
        }),
        close: (ws, code, reason) => this.events.emit("close", {ws, code, reason, helios: this}).then(e => {
            if (e.stopped) return;
            this.handleClose(ws, code, reason);
        }),
        drain: (ws) => this.events.emit("drain", {ws, helios: this}).then(e => {
            if (e.stopped) return;
            this.handleDrain(ws);
        }),
        ping: (ws, data) => this.events.emit("ping", {ws, data, helios: this}).then(e => {
            if (e.stopped) return;
            this.handlePing(ws, data);
        }),
        pong: (ws, data) => this.events.emit("pong", {ws, data, helios: this}).then(e => {
            if (e.stopped) return;
            this.handlePong(ws, data);
        })
    }

    
    /** @param {import('bun').ServerWebSocket} ws */
    handleOpen(ws) {
        // Check for session recovery token
        if (this.sessionManager) {
            // Try to extract session token from upgrade request URL
            // Note: Bun provides the upgrade request in ws.data
            const url = ws.data?.url;
            if (url) {
                try {
                    const parsedUrl = new URL(url, 'ws://localhost');
                    const token = parsedUrl.searchParams.get('session_token');

                    if (token) {
                        // Attempt recovery
                        this.recoverSession(token, ws);
                        return;
                    }
                } catch (error) {
                    console.warn('[Helios] Failed to parse URL for session token:', error);
                }
            }
        }

        // Normal new connection
        const connection = this.connections.new(ws);
        if (connection) {
            this.createSession(connection);

            // Start health check
            connection.startHealthCheck();
        }
    }
    
    /** @param {import('bun').ServerWebSocket} ws @param {string | Buffer<ArrayBuffer>} raw  */
    handleMessage(ws, raw) {
        const connection = this.connections.get(ws);
        if (!connection) {
            console.warn(
                '[Helios] Message received for unknown connection. ' +
                'This may indicate a race condition or missing handleOpen call.',
                {
                    readyState: ws.readyState,
                    remoteAddress: ws.remoteAddress,
                    messageLength: typeof raw === 'string' ? raw.length : raw.byteLength
                }
            );
            return;
        }
        try {
            const message = Parser.parse(raw);
            this.events.emit(message.type, {connection, message, helios: this}).then(e => {
                if (e.stopped) return;
                connection.handleMessage(message);
            });
        } catch (error) {
            let message = raw;
            if (error instanceof ProtocolError) {
                if (this.options.parseMode === 'strict') throw error;
                else if (this.options.parseMode === 'permissive') {
                    let dataType = typeof message === 'string' ? 'text' : 'binary';
                    if (dataType === 'text') try {
                        const json = JSON.parse(/** @type {string} */ (message));
                        dataType = 'json';
                        message = json;
                    } catch (e) {}
                    this.events.emit(dataType, {connection, message, helios: this});
                }   
            }
        }
    }
    
    /** @param {import('bun').ServerWebSocket} ws @param {number} code @param {string} reason */
    handleClose(ws, code, reason) {
        const connection = this.connections.get(ws);

        if (!connection) {
            console.warn(`[Helios] Close event for unknown WebSocket. Code: ${code}, Reason: ${reason}`);
            return;
        }

        // Mark connection as closing IMMEDIATELY
        connection.state = 'CLOSING';

        // Stop health check timers
        connection.stopHealthCheck();

        // Session recovery: keep connection in memory instead of cleanup
        if (this.sessionManager && connection.sessionId) {
            // Just mark as disconnected, keep in memory for TTL period
            this.connections.markDisconnected(ws);

            // Mark as closed
            connection.state = 'CLOSED';

            // Emit disconnection event
            this.events.emit('disconnection', {
                connection,
                code,
                reason,
                helios: this
            });

            return;
        }

        // No session recovery: cleanup immediately (original behavior)
        // 1. Cancel all pending requests
        if (connection.pendingRequests && connection.pendingRequests.size > 0) {
            for (const [requestId, pendingInfo] of connection.pendingRequests) {
                // Clear timeout
                if (pendingInfo.timeoutId) {
                    clearTimeout(pendingInfo.timeoutId);
                }

                // Call cleanup function (removes listeners)
                if (typeof pendingInfo.cleanup === 'function') {
                    pendingInfo.cleanup();
                }

                // Reject promise with ConnectionClosedError
                if (typeof pendingInfo.reject === 'function') {
                    pendingInfo.reject(new ConnectionClosedError('Connection closed'));
                }
            }
            connection.pendingRequests.clear();
        }

        // 2. Cleanup connection's EventManager
        if (connection.topics && typeof connection.topics.clear === 'function') {
            connection.topics.clear();
        }

        // 3. Clear data Map
        if (connection.data && typeof connection.data.clear === 'function') {
            connection.data.clear();
        }

        // 4. Mark as closed
        connection.state = 'CLOSED';

        // 5. Remove from connections Map
        this.connections.delete(ws);

        // 6. Emit disconnection event AFTER cleanup
        this.events.emit('disconnection', {
            connection,
            code,
            reason,
            helios: this
        });
    }
    
    /** @param {import('bun').ServerWebSocket} ws */
    handleDrain(ws) {
        const connection = this.connections.get(ws);

        if (!connection) {
            console.warn('[Helios] Drain event for unknown connection');
            return;
        }

        // Event is already emitted by websocket.drain handler (line 58-60)
        // This is just for additional handling if needed
        // Users can listen to 'drain' event and implement custom queue
    }

    /** @param {import('bun').ServerWebSocket} ws @param {Buffer} data */
    handlePing(ws, data) {
        // Server receives ping from client (unusual but possible)
        // Bun automatically responds with pong, but we can track it
        const connection = this.connections.get(ws);
        if (!connection) return;

        this.events.emit('ping-received', {
            connection,
            data,
            helios: this
        });
    }

    /** @param {import('bun').ServerWebSocket} ws @param {Buffer} data */
    handlePong(ws, data) {
        const connection = this.connections.get(ws);

        if (!connection) {
            console.warn('[Helios] Pong received for unknown connection');
            return;
        }

        connection.handlePong();
    }

    /**
     * Attempt to recover a session from a JWT token
     * @param {string} token - JWT session token
     * @param {import('bun').ServerWebSocket} ws - New WebSocket connection
     */
    async recoverSession(token, ws) {
        try {
            // 1. Verify JWT
            const session = await this.sessionManager.verify(token);
            if (!session) {
                return this.createNewSession(ws, 'Invalid token');
            }

            // 2. Find and reconnect existing Connection
            const connection = this.connections.reconnect(session.sessionId, ws);
            if (!connection) {
                return this.createNewSession(ws, 'Session expired');
            }

            // 3. Emit success events
            connection.emit('session:recovered', {
                sessionId: session.sessionId,
                metadata: session.metadata || {}
            });

            this.events.emit('session:recovered', {
                connection,
                session,
                helios: this
            });

        } catch (error) {
            console.error('[Helios] Session recovery failed:', error);
            this.createNewSession(ws, error.message);
        }
    }

    /**
     * Create a new session for a connection
     * @param {import('./connection.js').Connection} connection
     */
    async createSession(connection) {
        if (!this.sessionManager) return;

        try {
            const token = await this.sessionManager.create(connection);

            // Add to sessionMap now that sessionId is set
            this.connections.sessionMap.set(connection.sessionId, connection);

            connection.emit('session:created', {
                token,
                ttl: this.sessionManager.ttl
            });
        } catch (error) {
            console.error('[Helios] Failed to create session:', error);
        }
    }

    /**
     * Create a new connection and session when recovery fails
     * @param {import('bun').ServerWebSocket} ws
     * @param {string} reason - Reason why recovery failed
     */
    createNewSession(ws, reason) {
        const connection = this.connections.new(ws);
        if (connection) {
            connection.emit('session:recovery-failed', { reason });
            this.createSession(connection);
        }
    }

    /**
     * Manually send a ping to a connection
     * @param {import('./connection.js').Connection} connection
     * @returns {Promise<number>} Latency in milliseconds
     */
    async ping(connection) {
        if (connection.state !== 'OPEN') {
            throw new Error('Connection is not open');
        }

        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            /** @type {NodeJS.Timeout | undefined} */
            let timeoutId;

            // Listen for next pong
            /** @param {any} event */
            const handler = ({event}) => {
                const eventData = event?.data || event;
                if (eventData?.connection?.id === connection.id) {
                    cleanup();
                    resolve(Date.now() - startTime);
                }
            };

            // Cleanup function
            const cleanup = () => {
                this.events.off('pong-received');
                if (timeoutId) clearTimeout(timeoutId);
            };

            this.events.once('pong-received', handler);

            // Timeout after 10 seconds
            timeoutId = setTimeout(() => {
                cleanup();
                reject(new Error('Ping timeout'));
            }, 10000);

            // Send ping
            connection.ws.ping();
        });
    }

    /** @param {Partial<Parameters<typeof Bun.serve>[0]>} options */
    serve(options) {
        console.log("Starting Helios server with args:", options);
        try {
            this.server = Bun.serve({
                fetch(req, server) {
                    // Pass URL in upgrade data for session recovery
                    server.upgrade(req, {
                        data: {
                            url: req.url
                        }
                    });
                },
                websocket: this.websocket,
                ...options,
            })
            console.log("Helios server started on port", this.server.port);
            return this.server;
        } catch (e) {
            console.error("Failed to start Helios server:", e);
            throw e;
        }
    }
}