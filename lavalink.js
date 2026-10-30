
const { Riffy } = require("riffy");
const config = require("./config.js");

class LavalinkNodeManager {
    constructor(client) {
        this.client = client;
        this.riffy = null;
        this.initialized = false;
        this.destroying = false;
    }

    initializeNodes() {
        if (!Array.isArray(config.nodes) || config.nodes.length === 0) {
            throw new Error("No Lavalink nodes found in config.js");
        }

        return config.nodes.map((node, index) => {
            if (!node.host || !node.port || !node.password) {
                throw new Error(`Invalid Lavalink node configuration at index ${index}`);
            }

            return {
                host: node.host,
                password: node.password,
                port: Number(node.port),
                secure: Boolean(node.secure)
            };
        });
    }

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

        return this.riffy;
    }

    setupEventListeners() {
        if (!this.riffy) return;

        this.riffy.on("nodeConnect", (node) => {
            console.log(
                `[LAVALINK] Connected: ${node.name || "Unknown node"}`
            );
        });

        this.riffy.on("nodeDisconnect", (node) => {
            console.warn(
                `[LAVALINK] Disconnected: ${node.name || "Unknown node"}`
            );
        });

        this.riffy.on("nodeError", (node, error) => {
            console.error(
                `[LAVALINK] Node error (${node?.name || "Unknown"}):`,
                error?.message || error
            );
        });

        this.riffy.on("nodeReconnect", (node) => {
            console.log(
                `[LAVALINK] Reconnecting: ${node?.name || "Unknown node"}`
            );
        });
    }

    init(userId) {
        if (!this.riffy) {
            throw new Error("Riffy has not been initialized.");
        }

        if (this.destroying) {
            throw new Error("Lavalink manager is shutting down.");
        }

        if (this.initialized) {
            this.riffy.init(userId);
            console.log("[LAVALINK] Node initialization started.");
        }
    }

    getConnectedNodeCount() {
        if (!this.riffy?.nodes) return 0;

        const nodes = this.riffy.nodes;

        if (nodes instanceof Map) {
            return [...nodes.values()].filter(
                node => node.connected || node.state === "CONNECTED"
            ).length;
        }

        if (Array.isArray(nodes)) {
            return nodes.filter(
                node => node.connected || node.state === "CONNECTED"
            ).length;
        }

        return Object.values(nodes).filter(
            node => node.connected || node.state === "CONNECTED"
        ).length;
    }

    getTotalNodeCount() {
        return config.nodes?.length || 0;
    }

    getNodeCount() {
        return this.getConnectedNodeCount();
    }

    hasConnectedNodes() {
        return this.getConnectedNodeCount() > 0;
    }

    getNodeStatus() {
        const connected = this.getConnectedNodeCount();
        const total = this.getTotalNodeCount();

        return {
            total,
            online: connected,
            offline: Math.max(0, total - connected)
        };
    }

    async ensureNodeAvailable() {
        if (this.destroying) {
            throw new Error("Lavalink manager is shutting down.");
        }

        if (this.hasConnectedNodes()) {
            return true;
        }

        throw new Error(
            "No Lavalink nodes are connected. Check your Lavalink server and configuration."
        );
    }

    destroy() {
        if (this.destroying) return;

        this.destroying = true;

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

            console.log("[LAVALINK] Cleanup completed.");
        } catch (error) {
            console.error("[LAVALINK] Cleanup error:", error);
        }
    }
}

let nodeManagerInstance = null;

async function initializeLavalinkManager(client) {
    if (!nodeManagerInstance) {
        nodeManagerInstance = new LavalinkNodeManager(client);
    }

    await nodeManagerInstance.initializeRiffy();

    client.riffy = nodeManagerInstance.riffy;

    return nodeManagerInstance;
}

async function initializePlayer(client) {
    return initializeLavalinkManager(client);
}

function getLavalinkManager() {
    return nodeManagerInstance;
}

module.exports = {
    initializePlayer,
    initializeLavalinkManager,
    getLavalinkManager
};
