import { Helios } from "../src";

const helios = new Helios();

helios.events.on("**", ({event}) => {
    console.log(`[Event: ${event.topic}]`);
})

helios.method("ping", (c) => {
    return "pong";
})

helios.serve();