export class Connection {
    /** @param {import('./helios.js').Helios} helios @param {import('bun').ServerWebSocket} ws */
    constructor(helios, ws) {
        this.helios = helios;
        this.ws = ws;

        this.data = new Map();
    }

    /** @type {import('bun').ServerWebSocket} */
    ws;




}