import { Serializer } from '@aionbuilders/helios-protocol';
import { Message, Event, Request, Response, EventManager } from '@aionbuilders/helios-protocol';

export class Connection {
    /** @param {import('./helios.js').Helios} helios @param {import('bun').ServerWebSocket} ws */
    constructor(helios, ws) {
        this.helios = helios;
        this.ws = ws;

        this.data = new Map();

        this.topics = new EventManager();
        this.on = this.topics.on.bind(this.topics);
        this.off = this.topics.off.bind(this.topics);
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
    emit = async message => {
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
    json = (data, options = {}) => this.emit(Message.outgoing(data, {dataType: "json", ...options}));

    /** @param {string} data @param {Partial<Parameters<typeof Message.outgoing>[1]>} options */
    text = (data, options = {}) => this.emit(Message.outgoing(data, {dataType: "string", ...options}));

    /** @param {ArrayBuffer | Uint8Array | Buffer} data @param {Partial<Parameters<typeof Message.outgoing>[1]>} options */
    binary = (data, options = {}) => this.emit(Message.outgoing(data, {dataType: "buffer", ...options}));

    /** @param {string} method @param {any} payload @param {Partial<Parameters<typeof Request.outgoing>[1]>} options @returns {Promise<Response>}*/
    request = async (method, payload, options = {}) => new Promise((resolve, reject) => {
        const request = Request.outgoing(payload, { method, ...options });
        this.emit(request);
        const timeout = setTimeout(() => {
            this.helios.events.emit(`error:${request.id}`, new Error("Request timed out."));
        }, options.timeout || this.helios.options.requestTimeout)
        const clear = () => {
            clearTimeout(timeout);
            this.helios.events.off(`response:${request.id}`);
            this.helios.events.off(`error:${request.id}`);
        }
        this.helios.events.once(`response:${request.id}`, ({event}) => {
            clear();
            resolve(/** @type {Response} */ (event.data));
        });
        this.helios.events.once(`error:${request.id}`, ({event}) => {
            clear();
            reject(event.data);
        });
    })

    /** @param {Message | Request | Response | Event} message */
    handleMessage(message) {
        if (message instanceof Request) this.handleRequest(message);
        else if (message instanceof Response) this.handleResponse(message);
        else if (message instanceof Event) this.handleEvent(message);
    }

    /** @param {Request} request */
    handleRequest(request) {
        this.helios.methods.handle(request, { connection: this }).then(res => {
            this.emit(res);
        })
    }

    /** @param {Response} response */
    handleResponse(response) {
        this.helios.events.emit(`response:${response.requestId}`, response);
    }

    /** @param {Event} event */
    handleEvent(event) {
        this.helios.topics.handle(event, { connection: this });
    }
}