import { Helios } from "../src/index.js";
import { Event } from "@aionbuilders/helios-protocol";

const helios = new Helios();

console.log("\n=== Helios E2E Test Server ===\n");

// Log tous les events pour debug
helios.events.on("**", ({event}) => {
    if (!event.topic.startsWith("response:") && !event.topic.startsWith("error:")) {
        console.log(`[Server Event] ${event.topic}`);
    }
});

// Test 1: Ping simple
helios.method("ping", () => {
    console.log("[Server] Received ping, sending pong");
    return "pong";
});

// Test 2: Echo
helios.method("echo", (payload) => {
    console.log("[Server] Received echo:", payload);
    return payload;
});

// Test 3: Slow method pour tester timeout
helios.method("slow", async () => {
    console.log("[Server] Slow method called, waiting 10s...");
    await new Promise(r => setTimeout(r, 10000));
    return "too late";
});

// Test 4: Pub/sub - Broadcast chat messages à tous les clients
helios.on("chat:message", (data, ctx) => {
    console.log(`[Server] Chat message from ${data.user}: ${data.message}`);

    // Broadcast to all connections
    let count = 0;
    for (const conn of helios.connections.values()) {
        conn.send(Event.outgoing(data, { topic: "chat:message" }));
        count++;
    }
    console.log(`[Server] Broadcasted to ${count} client(s)`);
});

// Test 5: Bidirectionnel - Server demande info au client
helios.events.on("connection", async ({connection}) => {
    console.log(`[Server] New connection! Total: ${helios.connections.size}`);

    // Wait un peu pour que le client soit prêt
    await new Promise(r => setTimeout(r, 100));

    try {
        console.log("[Server] Requesting client info...");
        const info = await connection.request("client.info", {}, { timeout: 3000 });
        console.log("[Server] Client info received:", info.data);
    } catch (e) {
        console.log("[Server] Client info failed:", e.message);
    }
});

// Log disconnections
helios.events.on("disconnection", ({code, reason}) => {
    console.log(`[Server] Client disconnected. Code: ${code}, Reason: ${reason || 'none'}`);
    console.log(`[Server] Remaining connections: ${helios.connections.size}`);
});

// Start server
helios.serve({ port: 3000 });
console.log("\n✅ Server ready on port 3000");
console.log("📝 Waiting for client connection...\n");
