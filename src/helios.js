import { Pulse } from "@killiandvcz/pulse";
import { HeliosEvent } from "./utils/events.utils";
import { Connections } from "./connections";
import { Parser } from "@aionbuilders/helios-protocol";
import { ProtocolError, MethodManager, EventManager } from "@aionbuilders/helios-protocol";

/**
 * @typedef {Object} HeliosOptions
 * @property {number} requestTimeout - Timeout for requests in milliseconds (default: 5000)
 * @property {'strict'|'permissive'|'passthrough'} parseMode - Mode for parsing incoming messages (default: 'strict')
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
            ...options
        };
        this.events = new Pulse({
            EventClass: HeliosEvent
        });

        this.connections = new Connections(this);
        
        this.methods = new MethodManager();
        this.method = this.methods.register.bind(this.methods);
        this.namespace = this.methods.namespace.bind(this.methods);
        this.use = this.methods.use.bind(this.methods);

        this.topics = new EventManager();
        this.on = this.topics.on.bind(this.topics);
        this.off = this.topics.off.bind(this.topics);
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
        })
    }
    
    /** @param {import('bun').ServerWebSocket} ws */
    handleOpen(ws) {
        this.connections.new(ws);
        
    }
    
    /** @param {import('bun').ServerWebSocket} ws @param {string | Buffer<ArrayBuffer>} raw  */
    handleMessage(ws, raw) {
        const connection = this.connections.get(ws);
        if (!connection) return; 
        //TODO: handle unknown connection
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
        
    }
    
    /** @param {import('bun').ServerWebSocket} ws */
    handleDrain(ws) {
        
    }
    
    /** @param {Partial<Parameters<typeof Bun.serve>>} args */
    serve(...args) {
        try {
            this.server = Bun.serve({
                fetch(req, server) {
                    server.upgrade(req)
                },
                websocket: this.websocket,
                ...args
            })
            console.log("Helios server started on port", this.server.port);
            return this.server;
        } catch (e) {
            console.error("Failed to start Helios server:", e);
            throw e;
        }
    }
}