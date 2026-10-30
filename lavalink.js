
const { Riffy } = require("riffy");
const config = require("./config.js");

class LavalinkNodeManager {
    constructor(client) {
        this.client = client;
        this.riffy = null;

        this.initialized = false;
        this.started = false;
        this.destroying = false;

        this.connectionWaiters = new Set();
    }

    // Validate and prepare Lavalink nodes
    initializeNodes() {
        if (!Array.isArray(config.nodes) || config.nodes.length === 0) {
            throw new Error("No Lavalink nodes configured in config.js");
        }

        return config.nodes.map((node, index) => {
            if (!node.host || !node.password || !node.port) {
                throw new Error(
                    `Invalid Lavalink node at config.nodes[${index}]. Check host, password and port.`
                );
            }

            const port = Number(node.port);

            if (!Number.isInteger(port) || port < 1 || port > 65535) {
                throw new Error(
                    `Invalid port for Lavalink node at index ${index}`
                );
            }

            return {
                host: String(node.host).trim(),
                password: String(node.password),
                port,
                secure: node.secure === true
            };
        });
    }

    // Create Riffy instance
    async initializeRiffy() {
        if (this.destroying) {
            throw new Error("Lavalink manager is shutting down.");
        }

        if (this.riffy) {
            return this.riffy;
        }

        const nodes = this.initializeNodes();

        this.riffy = new Riffy(
            this.client,
            nodes,
            {
                send: (payload) => {
                    const guildId = payload?.d?.guild_id;

                    if (!guildId) return;

                    const guild = this.client.guilds.cache.get(guildId);

                    if (guild) {
                        guild.shard.send(payload);
                    }
                },

                defaultSearchPlatform: "ytsearch",
                restVersion: "v4"
            }
        );

        this.setupEventListeners();

        this.client.riffy = this.riffy;

        this.initialized = true;

        console.log(
            `[LAVALINK] Riffy initialized with ${nodes.length} node(s).`
        );

        nodes.forEach((node, index) => {
            console.log(
                `[LAVALINK] Node ${index + 1}: ${node.host}:${node.port} | SSL: ${node.secure}`
            );
        });

        return this.riffy;
    }

    // Riffy node events
    setupEventListeners() {
        if (!this.riffy) return;

        this.riffy.on("nodeConnect", (node) => {
            console.log(
                `[LAVALINK] CONNECTED: ${node.name || node.host || "Unknown node"}`
            );

            this.resolveConnectionWaiters();
        });

        this.riffy.on("nodeDisconnect", (node, reason) => {
            console.warn(
                `[LAVALINK] DISCONNECTED: ${node?.name || node?.host || "Unknown node"}`,
                reason || ""
            );
        });

        this.riffy.on("nodeReconnect", (node) => {
            console.log(
                `[LAVALINK] RECONNECTED: ${node?.name || node?.host || "Unknown node"}`
            );

            this.resolveConnectionWaiters();
        });

        this.riffy.on("nodeError", (node, error) => {
            console.error("[LAVALINK] NODE CONNECTION ERROR");
            console.error("Node:", node?.name || "Unknown");
            console.error("Host:", node?.host || "Unknown");
            console.error("Port:", node?.port || "Unknown");
            console.error("Error:", error?.stack || error?.message || error);
        });
    }

    // Start actual Lavalink connection
    init(userId) {
        if (!this.riffy) {
            throw new Error("Riffy has not been initialized.");
        }

        if (this.destroying) {
            throw new Error("Lavalink manager is shutting down.");
        }

        if (this.started) {
            console.log("[LAVALINK] Already initialized.");
            return;
        }

        this.started = true;

        try {
            this.riffy.init(userId);

            console.log(
                `[LAVALINK] Connection started for Discord client: ${userId}`
            );
        } catch (error) {
            this.started = false;
            console.error("[LAVALINK] Init failed:", error);
            throw error;
        }
    }

    // Get connected node count
    getConnectedNodeCount() {
        if (!this.riffy?.nodes) return 0;

        const nodes = this.riffy.nodes;

        let nodeList = [];

        if (nodes instanceof Map) {
            nodeList = [...nodes.values()];
        } else if (Array.isArray(nodes)) {
            nodeList = nodes;
        } else {
            nodeList = Object.values(nodes);
        }

        return nodeList.filter(node => {
            return (
                node?.connected === true ||
                node?.state === "CONNECTED"
            );
        }).length;
    }

    getTotalNodeCount() {
        return Array.isArray(config.nodes) ? config.nodes.length : 0;
    }

    getNodeCount() {
        return this.getConnectedNodeCount();
    }

    hasConnectedNodes() {
        return this.getConnectedNodeCount() > 0;
    }

    getNodeStatus() {
        const online = this.getConnectedNodeCount();
        const total = this.getTotalNodeCount();

        return {
            total,
            online,
            offline: Math.max(0, total - online)
        };
    }

    // Resolve pending connection checks
    resolveConnectionWaiters() {
        if (!this.hasConnectedNodes()) return;

        for (const resolve of this.connectionWaiters) {
            resolve(true);
        }

        this.connectionWaiters.clear();
    }

    // Wait for a node to connect
    async waitForConnectedNode(timeout = 15000) {
        if (this.hasConnectedNodes()) return true;

        if (!this.riffy || this.destroying || !this.started) {
            return false;
        }

        return new Promise(resolve => {
            let settled = false;

            const finish = (result) => {
                if (settled) return;

                settled = true;

                clearTimeout(timer);
                this.connectionWaiters.delete(finish);

                resolve(result);
            };

            const timer = setTimeout(() => {
                finish(this.hasConnectedNodes());
            }, timeout);

            this.connectionWaiters.add(finish);

            // Check again in case connection happened during registration.
            if (this.hasConnectedNodes()) {
                finish(true);
            }
        });
    }

    // Check before playing music
    async ensureNodeAvailable() {
        if (this.destroying) {
            throw new Error("Lavalink manager is shutting down.");
        }

        if (!this.riffy || !this.started) {
            throw new Error(
                "Lavalink is not initialized. Check your Discord ready event."
            );
        }

        if (this.hasConnectedNodes()) {
            return true;
        }

        console.log(
            "[LAVALINK] Waiting for a Lavalink node connection..."
        );

        const connected = await this.waitForConnectedNode(15000);

        if (connected) {
            console.log("[LAVALINK] Node is ready.");
            return true;
        }

        throw new Error(
            "No Lavalink nodes connected after 15 seconds. Check Lavalink host, port, password, SSL and server status."
        );
    }

    // Shutdown
    destroy() {
        if (this.destroying) return;

        this.destroying = true;

        for (const resolve of this.connectionWaiters) {
            resolve(false);
        }

        this.connectionWaiters.clear();

        try {
            if (this.riffy?.players?.values) {
                for (const player of this.riffy.players.values()) {
                    try {
                        player.destroy();
                    } catch (error) {
                        console.error(
                            "[LAVALINK] Player cleanup error:",
                            error.message
                        );
                    }
                }
            }

            this.riffy = null;
            this.client.riffy = null;

            this.initialized = false;
            this.started = false;

            console.log("[LAVALINK] Cleanup completed.");
        } catch (error) {
            console.error("[LAVALINK] Cleanup error:", error);
        }
    }
}

// Singleton manager
let nodeManagerInstance = null;

// Initialize manager
async function initializeLavalinkManager(client) {
    if (!nodeManagerInstance) {
        nodeManagerInstance = new LavalinkNodeManager(client);
    }

    await nodeManagerInstance.initializeRiffy();

    client.riffy = nodeManagerInstance.riffy;

    return nodeManagerInstance;
}

// Compatibility function
async function initializePlayer(client) {
    return initializeLavalinkManager(client);
}

// Get manager
function getLavalinkManager() {
    return nodeManagerInstance;
}

module.exports = {
    initializePlayer,
    initializeLavalinkManager,
    getLavalinkManager
};
