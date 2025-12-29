import { Serializer } from '@aionbuilders/helios-protocol';
import { Message, Event, Request, Response, EventManager } from '@aionbuilders/helios-protocol';
import { ConnectionClosedError } from './errors.js';

export class Connection {
    /** @param {import('./helios.js').Helios} helios @param {import('bun').ServerWebSocket} ws */
    constructor(helios, ws) {
        this.helios = helios;
        this.ws = ws;

        this.data = new Map();

        this.topics = new EventManager();
        this.on = this.topics.on.bind(this.topics);
        this.off = this.topics.off.bind(this.topics);

        // State management
        this.state = 'OPEN'; // 'OPEN' | 'CLOSING' | 'CLOSED'

        // Track pending requests for cleanup
        this.pendingRequests = new Map(); // requestId -> { requestId, timeoutId, cleanup, reject }
    }

    /** @type {import('bun').ServerWebSocket} */
    ws;

    /** @param {string | Bun.BufferSource} data */
    raw = async data => {
        if (this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("WebSocket is not connected.");
        }
        try {
            this.ws.send(data);
            return true;
        } catch (e) {
            return false;
        }
    }

    /** @param {Message} message */
    send = async message => {
        if (!(message instanceof Message)) throw new Error("Message must be an instance of Message");
        if (!message.id) throw new Error("Message must have an ID to be sent");

        try {
            this.ws.send(Serializer.serialize(message));
            return true;
        } catch (e) {
            return false;
        }
    }

    /** @param {any} data @param {Partial<Parameters<typeof Message.outgoing>[1]>} options */
    json = (data, options = {}) => this.send(Message.outgoing(data, {dataType: "json", ...options}));

    /** @param {string} data @param {Partial<Parameters<typeof Message.outgoing>[1]>} options */
    text = (data, options = {}) => this.send(Message.outgoing(data, {dataType: "string", ...options}));

    /** @param {ArrayBuffer | Uint8Array | Buffer} data @param {Partial<Parameters<typeof Message.outgoing>[1]>} options */
    binary = (data, options = {}) => this.send(Message.outgoing(data, {dataType: "buffer", ...options}));

    /** @param {string} topic @param {any} data @param {Partial<Parameters<typeof Event.outgoing>[1]>} options */
    emit = (topic, data, options = {}) => this.send(Event.outgoing(data, { topic, ...options }));

    /** @param {string} method @param {any} payload @param {Partial<Parameters<typeof Request.outgoing>[1]>} options @returns {Promise<Response>}*/
    request = async (method, payload, options = {}) => {
        // Check connection state
        if (this.state !== 'OPEN') {
            return Promise.reject(new ConnectionClosedError('Connection is closing or closed'));
        }

        return new Promise((resolve, reject) => {
            const request = Request.outgoing(payload, { method, ...options });
            const requestId = request.id;

            // Setup timeout
            const timeoutMs = options.timeout || this.helios.options.requestTimeout;
            const timeoutId = setTimeout(() => {
                // Check if connection still exists before emitting
                if (this.helios.connections.has(this.ws)) {
                    this.helios.events.emit(`error:${requestId}`, new Error("Request timed out."));
                }
            }, timeoutMs);

            // Cleanup function
            const cleanup = () => {
                clearTimeout(timeoutId);
                this.helios.events.off(`response:${requestId}`);
                this.helios.events.off(`error:${requestId}`);
                this.pendingRequests.delete(requestId);
            };

            // Store pending request info for cleanup
            this.pendingRequests.set(requestId, {
                requestId,
                timeoutId,
                cleanup,
                reject
            });

            // Setup listeners
            this.helios.events.once(`response:${requestId}`, ({event}) => {
                cleanup();
                resolve(/** @type {Response} */ (event.data));
            });

            this.helios.events.once(`error:${requestId}`, ({event}) => {
                cleanup();
                reject(event.data);
            });

            // Send request
            this.send(request);
        });
    }

    /** @param {Message | Request | Response | Event} message */
    handleMessage(message) {
        if (message instanceof Request) this.handleRequest(message);
        else if (message instanceof Response) this.handleResponse(message);
        else if (message instanceof Event) this.handleEvent(message);
    }

    /** @param {Request} request */
    handleRequest(request) {
        this.helios.methods.handle(request, { connection: this }).then(res => {
            this.send(res);
        })
    }

    /** @param {Response} response */
    handleResponse(response) {
        if (this.state === 'CLOSING' || this.state === 'CLOSED') {
            console.warn(`[Helios] Response received for closing/closed connection: ${response.requestId}`);
            return;
        }
        this.helios.events.emit(`response:${response.requestId}`, response);
    }

    /** @param {Event} event */
    handleEvent(event) {
        this.helios.topics.handle(event, { connection: this });
    }
}