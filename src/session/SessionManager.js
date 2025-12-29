import * as jose from 'jose';

/**
 * @typedef {Object} SessionManagerOptions
 * @property {string} secret - Secret key for JWT signing (required)
 * @property {number} [ttl=300000] - Session TTL in milliseconds (default: 5 minutes)
 */

/**
 * SessionManager handles JWT-based session token creation and verification
 * for connection recovery after disconnection.
 */
export class SessionManager {
    /**
     * @param {SessionManagerOptions} options
     */
    constructor(options) {
        if (!options?.secret) {
            throw new Error('SessionManager requires a secret key');
        }

        this.secret = new TextEncoder().encode(options.secret);
        this.ttl = options.ttl || 5 * 60 * 1000; // 5 minutes default
    }

    /**
     * Create a JWT session token for a connection
     * @param {import('../connection.js').Connection} connection
     * @param {Object} [metadata={}] - Optional metadata to include in token
     * @returns {Promise<string>} JWT token
     */
    async create(connection, metadata = {}) {
        // Generate session ID if not already set
        if (!connection.sessionId) {
            connection.sessionId = `sess-${crypto.randomUUID()}`;
        }

        const token = await new jose.SignJWT({
            sessionId: connection.sessionId,
            connectionId: connection.id,
            metadata
        })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setExpirationTime(Math.floor((Date.now() + this.ttl) / 1000))
            .sign(this.secret);

        return token;
    }

    /**
     * Verify a JWT session token
     * @param {string} token - JWT token to verify
     * @returns {Promise<Object|null>} Payload if valid, null if invalid/expired
     */
    async verify(token) {
        try {
            const { payload } = await jose.jwtVerify(token, this.secret);
            return payload;
        } catch (error) {
            console.warn('[SessionManager] Token verification failed:', /** @type {Error} */ (error).message);
            return null;
        }
    }
}
