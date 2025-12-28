import {Pulse} from "@killiandvcz/pulse";
import { HeliosEvent } from "./utils/events.utils";
import { Connections } from "./connections";

/**
* @typedef {import('bun').WebSocketHandler<any>} WSHandler
*/
export class Helios {
    constructor() {
        this.events = new Pulse({
            EventClass: HeliosEvent
        });
        this.on = this.events.on.bind(this.events);
        this.off = this.events.off.bind(this.events);

        this.connections = new Connections(this);
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
    
    /** @param {import('bun').ServerWebSocket} ws @param {string | Buffer<ArrayBuffer>} message  */
    handleMessage(ws, message) {
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