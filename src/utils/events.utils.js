import { PulseEvent } from "@killiandvcz/pulse";

export class HeliosEvent extends PulseEvent {
    /** @param {ConstructorParameters<typeof PulseEvent>} args */
    constructor(...args) {
        super(...args);

        /** 
        * Indicates whether the event propagation has been stopped.
        * @type {boolean} */
        this.stopped = false;
    }

    /**
     * Mark this event as stopped, preventing further propagation.
     * @return {void}
     */
    stop() { this.stopped = true; }
}