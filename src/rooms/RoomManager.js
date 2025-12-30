import { CapturePatternMatcher } from '@aionbuilders/helios-protocol';
import { ValidationError } from '@aionbuilders/helios-protocol';

/**
 * Room Manager for managing broadcast rooms with permission validation
 *
 * Supports:
 * - Public rooms (no validation)
 * - Protected rooms with validators
 * - Pattern-based rooms (user:*, document:*)
 * - Capture groups for validators
 */
export class RoomManager {
    /**
     * @param {import('../helios.js').Helios} helios
     */
    constructor(helios) {
        this.helios = helios;

        // Index 1: Track which topics each connection is subscribed to
        // Use Map instead of WeakMap to allow iteration in broadcast()
        // Cleanup is done explicitly via cleanup() method
        /** @type {Map<import('../connection.js').Connection, Set<string>>} */
        this.#connectionSubscriptions = new Map();

        // Index 2: Fast lookup for exact topic matches
        /** @type {Map<string, Set<import('../connection.js').Connection>>} */
        this.#topicConnections = new Map();

        // Index 3: Declared room patterns with validators
        /** @type {Array<{pattern: string, validator: Function|null, type: 'public'|'protected', specificity: number}>} */
        this.#roomPatterns = [];

        // Index 4: Public rooms (no validation needed)
        /** @type {Set<string>} */
        this.#publicRooms = new Set();

        // Pattern matcher with capture support
        this.#matcher = new CapturePatternMatcher(':');
    }

    // Private fields
    #connectionSubscriptions;
    #topicConnections;
    #roomPatterns;
    #publicRooms;
    #matcher;

    /**
     * Declare a room with optional validator
     *
     * @typedef {(connection: import('../connection.js').Connection, captures: string[], data: any) => Promise<boolean> } ValidatorFunction
     * 
     * @param {string} pattern - "lobby" | "user:*" | "document:*"
     * @param {Object} options
     * @param {'public'|'protected'} [options.type='protected'] - Room type
     * @param {ValidatorFunction} [options.validator] - async (connection, captures, data) => boolean
     * @returns {this}
     *
     * @example
     * // Public room (anyone can join)
     * helios.room("lobby", { type: "public" })
     *
     * // Protected static room (role-based)
     * helios.room("admin:chat", {
     *   validator: async (conn) => conn.data.get("role") === "admin"
     * })
     *
     * // Protected dynamic room (pattern-based)
     * helios.room("user:*", {
     *   validator: async (conn, captures) => {
     *     const [userId] = captures;
     *     return conn.data.get("userId") === userId;
     *   }
     * })
     */
    declare(pattern, options = {}) {
        const { type = 'protected', validator = null } = options;

        // Validation
        if (!pattern || typeof pattern !== 'string') {
            throw new ValidationError("Pattern must be a non-empty string");
        }

        if (type === 'protected' && !validator) {
            throw new ValidationError("Protected rooms require a validator");
        }

        // Add to appropriate index
        if (type === 'public') {
            // Exact match only for public rooms
            if (pattern.includes('*') || pattern.includes('+')) {
                throw new ValidationError("Public rooms cannot use wildcards");
            }
            this.#publicRooms.add(pattern);
        } else {
            // Protected room with validator
            const specificity = this.#matcher.calculateSpecificity(pattern);
            this.#roomPatterns.push({
                pattern,
                validator,
                type,
                specificity
            });

            // Sort by specificity (descending: most specific first)
            this.#roomPatterns.sort((a, b) => b.specificity - a.specificity);
        }

        return this; // Allow chaining
    }

    /**
     * Subscribe a connection to a topic (with validation)
     *
     * @param {import('../connection.js').Connection} connection
     * @param {string} topic - exact topic to subscribe to
     * @param {any} [data={}] - optional data for validator
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async subscribe(connection, topic, data = {}) {
        // 1. Check if room is declared
        const roomConfig = this.#findRoomConfig(topic);
        console.log(`[RoomManager] Subscribing to topic "${topic}". Room config:`, roomConfig);
        if (!roomConfig) {
            return {
                success: false,
                error: "Room not declared (deny by default)"
            };
        }

        // 2. Run validator if protected
        if (roomConfig.type === 'protected' && roomConfig.validator) {
            try {
                const result = this.#matcher.matchWithCaptures(topic, roomConfig.pattern);
                const allowed = await roomConfig.validator(connection, result.captures, data);

                if (!allowed) {
                    return {
                        success: false,
                        error: "Permission denied"
                    };
                }
            } catch (error) {
                console.error(`[RoomManager] Validator error for ${topic}:`, error);
                return {
                    success: false,
                    error: "Validator error"
                };
            }
        }

        // 3. Add to indexes
        this.#addSubscription(connection, topic);

        // 4. Emit event
        this.helios.events.emit('room:subscribed', {
            connection,
            topic,
            helios: this.helios
        });

        return { success: true };
    }

    /**
     * Unsubscribe a connection from a topic
     *
     * @param {import('../connection.js').Connection} connection
     * @param {string} topic
     * @returns {Promise<{success: boolean}>}
     */
    async unsubscribe(connection, topic) {
        const removed = this.#removeSubscription(connection, topic);

        if (removed) {
            this.helios.events.emit('room:unsubscribed', {
                connection,
                topic,
                helios: this.helios
            });
        }

        return { success: removed };
    }

    /**
     * Broadcast to all connections matching topic/pattern
     *
     * @param {string} topicOrPattern - "lobby" | "user:*" | "document:123"
     * @param {any} data - event payload
     * @returns {{targets: number, sent: number}}
     *
     * Strategy:
     *   1. Exact match (fast path - O(1))
     *   2. Pattern match (slower - O(n*m))
     */
    broadcast(topicOrPattern, data) {
        const targets = new Set();

        // Fast path: exact match lookup
        const exactMatches = this.#topicConnections.get(topicOrPattern);
        if (exactMatches) {
            for (const conn of exactMatches) {
                targets.add(conn);
            }
        }

        // Slow path: pattern matching
        // For each connection's subscriptions, check if any match the broadcast pattern
        for (const [conn, subscriptions] of this.#connectionSubscriptions.entries()) {
            for (const topic of subscriptions) {
                if (this.#matcher.match(topic, topicOrPattern)) {
                    targets.add(conn);
                }
            }
        }

        // Send to all targets
        let successCount = 0;
        for (const conn of targets) {
            if (conn.state === 'OPEN') {
                conn.emit(topicOrPattern, data);
                successCount++;
            }
        }

        return { targets: targets.size, sent: successCount };
    }

    /**
     * Get room information
     *
     * @param {string} topic - exact topic
     * @returns {{connections: number, topic: string} | null}
     */
    getRoom(topic) {
        const connections = this.#topicConnections.get(topic);
        if (!connections) return null;

        return {
            topic,
            connections: connections.size
        };
    }

    /**
     * Get all subscriptions for a connection
     *
     * @param {import('../connection.js').Connection} connection
     * @returns {Set<string>}
     */
    getSubscriptions(connection) {
        return this.#connectionSubscriptions.get(connection) || new Set();
    }

    /**
     * Cleanup all subscriptions for a connection
     * Called on connection close (if no session recovery) or session expiry
     *
     * @param {import('../connection.js').Connection} connection
     */
    cleanup(connection) {
        const topics = this.#connectionSubscriptions.get(connection);
        if (!topics) return;

        for (const topic of topics) {
            const connections = this.#topicConnections.get(topic);
            if (connections) {
                connections.delete(connection);
                if (connections.size === 0) {
                    this.#topicConnections.delete(topic);
                }
            }
        }

        this.#connectionSubscriptions.delete(connection);
    }

    /**
     * Find room configuration for a topic
     * @private
     */
    #findRoomConfig(topic) {
        // Check public rooms first (exact match only)
        if (this.#publicRooms.has(topic)) {
            return { type: 'public', pattern: topic, validator: null };
        }

        // Check protected patterns (most specific first)
        for (const config of this.#roomPatterns) {
            if (this.#matcher.match(topic, config.pattern)) {
                return config;
            }
        }

        return null; // Deny by default
    }

    /**
     * Add subscription to indexes
     * @private
     */
    #addSubscription(connection, topic) {
        // Index 1: connection -> topics
        if (!this.#connectionSubscriptions.has(connection)) {
            this.#connectionSubscriptions.set(connection, new Set());
        }
        this.#connectionSubscriptions.get(connection).add(topic);

        // Index 2: topic -> connections
        if (!this.#topicConnections.has(topic)) {
            this.#topicConnections.set(topic, new Set());
        }
        this.#topicConnections.get(topic).add(connection);
    }

    /**
     * Remove subscription from indexes
     * @private
     */
    #removeSubscription(connection, topic) {
        // Index 1
        const topics = this.#connectionSubscriptions.get(connection);
        if (!topics) return false;

        const removed = topics.delete(topic);
        if (topics.size === 0) {
            this.#connectionSubscriptions.delete(connection);
        }

        // Index 2
        const connections = this.#topicConnections.get(topic);
        if (connections) {
            connections.delete(connection);
            if (connections.size === 0) {
                this.#topicConnections.delete(topic);
            }
        }

        return removed;
    }
}
