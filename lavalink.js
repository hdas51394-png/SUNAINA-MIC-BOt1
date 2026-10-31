
const { Riffy } = require("riffy");
const config = require("./config.js");

class LavalinkNodeManager {

    constructor(client) {
        this.client = client;
        this.riffy = null;

        this.initialized = false;
        this.started = false;
        this.destroying = false;

        // Track node connections using actual events.
        this.connectedNodes = new Set();
        this.connectionWaiters = new Set();

        this.nodeErrors = new Map();
    }

    // ==========================================
    // NODE CONFIGURATION
    // ==========================================

    initializeNodes() {

        if (!Array.isArray(config.nodes) || !config.nodes.length) {
            throw new Error("No Lavalink nodes configured in config.js");
        }

        return config.nodes.map((node, index) => {

            if (!node.host || !node.password || !node.port) {
                throw new Error(
                    `Invalid Lavalink node at config.nodes[${index}]`
                );
            }

            const port = Number(node.port);

            if (!Number.isInteger(port) || port < 1 || port > 65535) {
                throw new Error(
                    `Invalid Lavalink port at index ${index}`
                );
            }

            return {
                name: node.name || `Node-${index + 1}`,
                host: String(node.host).trim(),
                password: String(node.password),
                port,
                secure: node.secure === true
            };
        });
    }

    // ==========================================
    // NODE IDENTIFICATION
    // ==========================================

    getNodeKey(node) {

        if (!node) return null;

        if (node.name) {
            return String(node.name);
        }

        if (node.host) {
            return `${node.host}:${node.port || ""}`;
        }

        return null;
    }

    // ==========================================
    // INITIALIZE RIFFY
    // ==========================================

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

                    if (guild && guild.shard) {
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

    // ==========================================
    // EVENT LISTENERS
    // ==========================================

    setupEventListeners() {

        if (!this.riffy) return;

        this.riffy.on("nodeConnect", (node) => {

            const key = this.getNodeKey(node);

            if (key) {
                this.connectedNodes.add(key);
                this.nodeErrors.delete(key);
            }

            console.log(
                `[LAVALINK] NODE CONNECTED: ${key || "Unknown node"}`
            );

            this.resolveConnectionWaiters();

            console.log(
                `[LAVALINK] Available Nodes: ${this.getNodeCount()}/${this.getTotalNodeCount()}`
            );

        });

        this.riffy.on("nodeReconnect", (node) => {

            const key = this.getNodeKey(node);

            if (key) {
                this.connectedNodes.add(key);
                this.nodeErrors.delete(key);
            }

            console.log(
                `[LAVALINK] NODE RECONNECTED: ${key || "Unknown node"}`
            );

            this.resolveConnectionWaiters();

        });

        this.riffy.on("nodeDisconnect", (node, reason) => {

            const key = this.getNodeKey(node);

            if (key) {
                this.connectedNodes.delete(key);
            }

            console.warn(
                `[LAVALINK] NODE DISCONNECTED: ${key || "Unknown node"}`,
                reason || ""
            );

        });

        this.riffy.on("nodeError", (node, error) => {

            const key = this.getNodeKey(node);

            const message =
                error?.message || String(error || "Unknown error");

            if (key) {
                this.nodeErrors.set(key, message);
            }

            console.error(
                "[LAVALINK] NODE ERROR:",
                key || "Unknown node"
            );

            console.error(message);

        });

    }

    // ==========================================
    // START LAVALINK
    // ==========================================

    init(userId) {

        if (!this.riffy) {
            throw new Error("Riffy has not been initialized.");
        }

        if (this.destroying) {
            throw new Error("Lavalink manager is shutting down.");
        }

        if (this.started) {
            console.log("[LAVALINK] Already started.");
            return;
        }

        if (!userId) {
            throw new Error("Discord client ID is missing.");
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

    // ==========================================
    // NODE COUNTERS
    // ==========================================

    getConnectedNodeCount() {

        return this.connectedNodes.size;
    }

    getTotalNodeCount() {

        return Array.isArray(config.nodes)
            ? config.nodes.length
            : 0;
    }

    getNodeCount() {

        return this.getConnectedNodeCount();
    }

    hasConnectedNodes() {

        return this.connectedNodes.size > 0;
    }

    getNodeStatus() {

        const online = this.getConnectedNodeCount();
        const total = this.getTotalNodeCount();

        return {

            total,
            online,

            offline: Math.max(0, total - online),

            nodes: Array.from(this.connectedNodes).map(name => ({
                name,
                online: true
            })),

            errors: Object.fromEntries(this.nodeErrors)

        };
    }

    // ==========================================
    // CONNECTION WAITERS
    // ==========================================

    resolveConnectionWaiters() {

        if (!this.hasConnectedNodes()) return;

        for (const resolve of this.connectionWaiters) {
            resolve(true);
        }

        this.connectionWaiters.clear();
    }

    async waitForConnectedNode(timeout = 20000) {

        if (this.hasConnectedNodes()) {
            return true;
        }

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

            if (this.hasConnectedNodes()) {
                finish(true);
            }

        });
    }

    // ==========================================
    // ENSURE NODE AVAILABLE
    // ==========================================

    async ensureNodeAvailable() {

        if (this.destroying) {
            throw new Error("Lavalink manager is shutting down.");
        }

        if (!this.riffy || !this.started) {
            throw new Error(
                "Lavalink is not initialized. Check Discord ready event."
            );
        }

        if (this.hasConnectedNodes()) {
            return true;
        }

        console.log(
            "[LAVALINK] Waiting for node connection..."
        );

        const connected = await this.waitForConnectedNode(20000);

        if (connected) {

            console.log(
                "[LAVALINK] Node is ready."
            );

            return true;
        }

        const errors = Array.from(
            this.nodeErrors.entries()
        ).map(([node, error]) => `${node}: ${error}`);

        throw new Error(
            "No Lavalink nodes are ready. " +
            (errors.length
                ? errors.join(" | ")
                : "Check host, port, password, SSL and Lavalink server status.")
        );
    }

    // ==========================================
    // HEALTH CHECK
    // ==========================================

    async checkAllNodesHealth() {

        const status = this.getNodeStatus();

        console.log(
            `[LAVALINK] Health: ${status.online}/${status.total} nodes online.`
        );

        return status;
    }

    // ==========================================
    // FORCE CONNECTION CHECK
    // ==========================================

    async forceConnectAllNodes() {

        if (!this.started || this.destroying) {
            return false;
        }

        if (this.hasConnectedNodes()) {
            return true;
        }

        console.log(
            "[LAVALINK] Waiting for available node..."
        );

        return this.waitForConnectedNode(15000);
    }

    // ==========================================
    // RECONNECT COMPATIBILITY
    // ==========================================

    async reconnectNodesNow(timeout = 5000) {

        if (!this.riffy || !this.started || this.destroying) {
            return false;
        }

        if (this.hasConnectedNodes()) {
            return true;
        }

        console.log(
            "[LAVALINK] Waiting for Riffy automatic reconnection..."
        );

        return this.waitForConnectedNode(timeout);
    }

    // ==========================================
    // REFRESH COMPATIBILITY
    // ==========================================

    async refreshRiffy() {

        if (this.destroying) {
            return false;
        }

        if (!this.riffy) {
            await this.initializeRiffy();
            return true;
        }

        return this.hasConnectedNodes();
    }

    // ==========================================
    // DESTROY
    // ==========================================

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

            this.connectedNodes.clear();
            this.nodeErrors.clear();

            this.riffy = null;

            this.client.riffy = null;

            this.initialized = false;
            this.started = false;

            console.log(
                "[LAVALINK] Cleanup completed."
            );

        } catch (error) {

            console.error(
                "[LAVALINK] Cleanup error:",
                error
            );
        }
    }
}

// ==========================================
// SINGLETON MANAGER
// ==========================================

let nodeManagerInstance = null;

// ==========================================
// INITIALIZE MANAGER
// ==========================================

async function initializeLavalinkManager(client) {

    if (!nodeManagerInstance || nodeManagerInstance.destroying) {

        nodeManagerInstance = new LavalinkNodeManager(client);
    }

    await nodeManagerInstance.initializeRiffy();

    client.riffy = nodeManagerInstance.riffy;

    return nodeManagerInstance;
}

// ==========================================
// COMPATIBILITY FUNCTION
// ==========================================

async function initializePlayer(client) {

    return initializeLavalinkManager(client);
}

// ==========================================
// GET MANAGER
// ==========================================

function getLavalinkManager() {

    return nodeManagerInstance;
}

// ==========================================
// EXPORTS
// ==========================================

module.exports = {

    LavalinkNodeManager,

    initializePlayer,

    initializeLavalinkManager,

    getLavalinkManager

};
