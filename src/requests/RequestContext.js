import { RequestContext } from "@aionbuilders/helios-protocol";

/**
 * @typedef {Parameters<RequestContext.new>} RCP
 */

export class HeliosRequestContext extends RequestContext {
    /** @param {RCP[0]} request @param {RCP[1] & {connection: import('../connection').Connection}} contextData */
    constructor(request, contextData) {
        super(request, contextData || {});
        this.connection = contextData.connection;
    }

    /** @type {import('../connection').Connection} */
    connection;
}