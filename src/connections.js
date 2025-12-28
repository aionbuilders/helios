import { Connection } from './connection.js';

export class Connections extends Map {
    /** @param {import('./helios.js').Helios} helios */
    constructor(helios) {
        super();
        this.helios = helios;
    }

    /** @param {import('bun').ServerWebSocket} ws */
    new(ws) {
        try {
            const connection = new Connection(this.helios, ws);
            this.set(ws, connection);
            this.helios.events.emit("connection", {connection, helios: this.helios});
            return connection;
        } catch (error) {
            this.delete(ws);
        }
    }
}

