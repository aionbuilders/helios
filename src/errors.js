/**
 * Error thrown when a connection closes before a request completes.
 *
 * @class ConnectionClosedError
 * @extends Error
 *
 * @example
 * try {
 *     await connection.request('method', payload);
 * } catch (err) {
 *     if (err instanceof ConnectionClosedError) {
 *         console.log('Connection closed before response');
 *     }
 * }
 */
export class ConnectionClosedError extends Error {
    constructor(message = 'Connection closed before request completed') {
        super(message);
        this.name = 'ConnectionClosedError';
    }
}
