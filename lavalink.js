
const { Riffy } = require("riffy");
const config = require("./config.js");
const colors = require("./UI/colors/colors");
const axios = require("axios");

let getLangSync;

try {
    const langLoader = require("./utils/languageLoader.js");
    getLangSync = langLoader.getLangSync;
} catch (error) {
    getLangSync = () => ({ console: {} });
}

class LavalinkNodeManager {
    constructor(client) {
        this.client = client;
        this.nodes = new Map();
        this.nodeStatus = new Map();

        this.healthCheckInterval = null;
        this.connectLoopInterval = null;
        this.reconnectInterval = null;

        this.riffy = null;
        this.initialized = false;
        this.destroying = false;

        this.connectionPromise = null;
        this.connectionResolve = null;

        this.initializeNodes();
    }

    initializeNodes() {
        if (Array.isArray(config.nodes)) {
            const nameCounts = new Map();

            config.nodes.forEach((node, index) => {
                const baseName = node.name || `node-${index}`;
                const count = nameCounts.get(baseName) || 0;

                nameCounts.set(baseName, count + 1);

                const nodeId = count > 0
                    ? `${baseName}-${count}`
                    : baseName;

                this.nodes.set(nodeId, {
                    ...node,
                    id: nodeId,
                    displayName: nodeId,
                    originalName: baseName
                });

                this.nodeStatus.set(nodeId, {
                    online: false,
                    lastCheck: null,
                    lastError: null
                });
            });
        }

        const lang = getLangSync();

        console.log(
            `${colors.cyan}[ LAVALINK ][INIT ]${colors.reset} ${
                lang.console?.lavalink?.nodesConfigured
                    ?.replace("{count}", this.nodes.size)
                || `Nodes configured: ${this.nodes.size}`
            }`
        );
    }

    async initializeRiffy() {
        if (this.destroying) {
            throw new Error("Lavalink manager is shutting down.");
        }

        try {
            const nodesToUse = Array.from(this.nodes.values()).map(node => ({
                host: node.host,
                password: node.password,
                port: node.port,
                secure: !!node.secure,
                name: node.id,
                displayName: node.displayName
            }));

            this.riffy = new Riffy(
                this.client,
                nodesToUse,
                {
                    send: (payload) => {
                        const guild = this.client.guilds.cache.get(
                            payload.d.guild_id
                        );

                        if (guild) {
                            guild.shard.send(payload);
                        }
                    },

                    defaultSearchPlatform: "ytsearch",
                    restVersion: "v4",
                    autoResume: true,
                    resumeKey: "PrimeMusic",
                    resumeTimeout: 30000
                }
            );

            this.setupEventListeners();

            this.initialized = true;

            this.startHealthMonitoring();
            this.startConnectLoop();

            const lang = getLangSync();

            console.log(
                `${colors.cyan}[ LAVALINK ][Riffy]${colors.reset} ${
                    colors.green
                }${
                    lang.console?.lavalink?.riffyInitialized
                        ?.replace("{count}", nodesToUse.length)
                    || `Initialized with ${nodesToUse.length} node(s)`
                }${colors.reset}`
            );

            setTimeout(() => {
                if (!this.riffy) return;

                try {
                    let keys = [];

                    if (this.riffy.nodes instanceof Map) {
                        keys = [...this.riffy.nodes.keys()];
                    } else if (Array.isArray(this.riffy.nodes)) {
                        keys = this.riffy.nodes.map(
                            node => node?.name || node?.identifier
                        );
                    } else if (this.riffy.nodes) {
                        keys = Object.keys(this.riffy.nodes);
                    }

                    console.log(
                        `${colors.cyan}[ LAVALINK ][Riffy]${colors.reset} Node keys:`,
                        keys
                    );
                } catch (error) {
                    console.error("[LAVALINK] Node inspection error:", error.message);
                }
            }, 2000);

            return this.riffy;

        } catch (error) {
            const lang = getLangSync();

            console.error(
                `${colors.cyan}[ LAVALINK ]${colors.reset} ${colors.red}${
                    lang.console?.lavalink?.failedToInitialize
                        ?.replace("{message}", error.message)
                    || `Failed to initialize Riffy: ${error.message}`
                }${colors.reset}`
            );

            throw error;
        }
    }

    _findRiffyNodeObjectByConfig(nodeConfig) {
        if (!this.riffy?.nodes) return null;

        const tryMatch = (riffyNode) => {
            if (!riffyNode) return false;

            if (riffyNode.host && riffyNode.port) {
                return (
                    riffyNode.host === nodeConfig.host &&
                    String(riffyNode.port) === String(nodeConfig.port)
                );
            }

            const identifier =
                riffyNode.identifier ||
                riffyNode.name;

            return (
                identifier === nodeConfig.id ||
                identifier === nodeConfig.displayName
            );
        };

        try {
            const nodes = this.riffy.nodes;

            if (nodes instanceof Map) {
                for (const node of nodes.values()) {
                    if (tryMatch(node)) return node;
                }
            } else if (Array.isArray(nodes)) {
                for (const node of nodes) {
                    if (tryMatch(node)) return node;
                }
            } else {
                for (const key of Object.keys(nodes)) {
                    if (tryMatch(nodes[key])) return nodes[key];
                }
            }
        } catch (error) {
            console.error("[LAVALINK] Node lookup error:", error.message);
        }

        return null;
    }

    async attemptConnectNode(nodeId) {
        if (this.destroying || !this.riffy) return false;

        const nodeCfg = this.nodes.get(nodeId);
        if (!nodeCfg) return false;

        const healthy = await this.checkNodeHealth(nodeId).catch(() => false);

        if (!healthy) return false;

        const riffyNode = this._findRiffyNodeObjectByConfig(nodeCfg);

        if (riffyNode) {
            try {
                if (
                    typeof riffyNode.connect === "function" &&
                    !riffyNode.connected
                ) {
                    riffyNode.connect();
                    return true;
                }

                if (
                    typeof riffyNode.connectNode === "function" &&
                    !riffyNode.connected
                ) {
                    riffyNode.connectNode();
                    return true;
                }
            } catch (error) {
                console.error("[LAVALINK] Connect error:", error.message);
            }
        }

        return false;
    }

    async forceConnectAllNodes() {
        if (!this.riffy || this.destroying) return false;

        const results = await Promise.allSettled(
            Array.from(this.nodes.keys()).map(nodeId =>
                this.attemptConnectNode(nodeId)
            )
        );

        return results.some(
            result => result.status === "fulfilled" && result.value
        );
    }

    async checkNodeHealth(nodeId) {
        const node = this.nodes.get(nodeId);

        if (!node) return false;

        try {
            const protocol = node.secure ? "https" : "http";

            const url =
                `${protocol}://${node.host}:${node.port}/version`;

            await axios.get(url, {
                headers: node.password
                    ? { Authorization: node.password }
                    : {},
                timeout: 3000
            });

            this.nodeStatus.set(nodeId, {
                online: true,
                lastCheck: new Date(),
                lastError: null
            });

            return true;

        } catch (error) {
            this.nodeStatus.set(nodeId, {
                online: false,
                lastCheck: new Date(),
                lastError: error.message
            });

            return false;
        }
    }

    async checkAllNodesHealth() {
        const healthy = [];

        await Promise.allSettled(
            Array.from(this.nodes.keys()).map(async nodeId => {
                const result = await this.checkNodeHealth(nodeId);

                if (result) healthy.push(nodeId);
            })
        );

        return healthy;
    }

    startConnectLoop() {
        if (this.connectLoopInterval || this.destroying) return;

        this.connectLoopInterval = setInterval(async () => {
            if (this.destroying) return;

            try {
                if (this.hasConnectedNodes()) return;

                await this.reconnectNodesNow(5000);
            } catch (error) {
                console.error("[LAVALINK] Reconnect loop error:", error.message);
            }
        }, 10000);
    }

    async reconnectNodesNow(maxWaitTime = 8000) {
        if (this.destroying || !this.riffy) return false;

        await this.checkAllNodesHealth().catch(() => {});

        await this.forceConnectAllNodes();

        const start = Date.now();

        while (
            Date.now() - start < maxWaitTime &&
            !this.destroying
        ) {
            if (this.hasConnectedNodes()) return true;

            await new Promise(resolve => setTimeout(resolve, 800));
        }

        return this.hasConnectedNodes();
    }

    async refreshRiffy() {
        if (this.destroying) return false;

        try {
            if (this.hasConnectedNodes()) return true;

            console.log("[LAVALINK] Refreshing Riffy...");

            const oldRiffy = this.riffy;

            this.riffy = null;
            this.initialized = false;

            // Do not call an unsupported Riffy destroy method.
            // Close only the players if their API supports it.
            if (oldRiffy?.players?.values) {
                for (const player of oldRiffy.players.values()) {
                    try {
                        if (typeof player.destroy === "function") {
                            player.destroy();
                        }
                    } catch (_) {}
                }
            }

            await this.initializeRiffy();

            console.log("[LAVALINK] Riffy re-initialized.");

            return true;

        } catch (error) {
            console.error(
                "[LAVALINK] Failed to refresh Riffy:",
                error.message
            );

            return false;
        }
    }

    setupEventListeners() {
        if (!this.riffy) return;

        this.riffy.on("nodeConnect", node => {
            const nodeId = this.findNodeIdByName(node.name);

            if (!nodeId) return;

            this.nodeStatus.set(nodeId, {
                online: true,
                lastCheck: new Date(),
                lastError: null
            });

            console.log(
                `${colors.cyan}[ LAVALINK ][NODE ]${colors.reset} ${
                    colors.green
                }Connected: ${node.name} (${node.host}:${node.port})${
                    colors.reset
                }`
            );

            if (this.connectionResolve) {
                this.connectionResolve(true);
                this.connectionResolve = null;
                this.connectionPromise = null;
            }
        });

        this.riffy.on("nodeDisconnect", node => {
            const nodeId = this.findNodeIdByName(node.name);

            if (!nodeId) return;

            this.nodeStatus.set(nodeId, {
                online: false,
                lastCheck: new Date(),
                lastError: "Disconnected"
            });

            console.log(
                `${colors.cyan}[ LAVALINK ][NODE ]${colors.reset} ${
                    colors.red
                }Disconnected: ${node.name}${colors.reset}`
            );
        });

        this.riffy.on("nodeError", (node, error) => {
            const nodeId = this.findNodeIdByName(node.name);

            if (!nodeId) return;

            const message = error?.message || "Unknown error";

            this.nodeStatus.set(nodeId, {
                online: false,
                lastCheck: new Date(),
                lastError: message
            });

            console.error(
                `${colors.cyan}[ LAVALINK ][NODE ]${colors.reset} ${
                    colors.red
                }${node.name}: ${message}${colors.reset}`
            );

            if (message.includes("after 3 attempts")) {
                this.reconnectNodesNow(3000).catch(() => {});
            }
        });
    }

    findNodeIdByName(nodeName) {
        for (const [nodeId, node] of this.nodes.entries()) {
            if (
                node.name === nodeName ||
                node.id === nodeName ||
                node.displayName === nodeName ||
                node.originalName === nodeName
            ) {
                return nodeId;
            }
        }

        return null;
    }

    getConnectedNodeCount() {
        if (!this.riffy?.nodes) return 0;

        let count = 0;

        try {
            const nodes = this.riffy.nodes;

            const checkNode = (nodeName, node) => {
                if (!node) return;

                if (node.connected || node.state === "CONNECTED") {
                    count++;

                    const nodeId = this.findNodeIdByName(
                        nodeName || node.name || node.identifier
                    );

                    if (nodeId) {
                        this.nodeStatus.set(nodeId, {
                            online: true,
                            lastCheck: new Date(),
                            lastError: null
                        });
                    }
                }
            };

            if (nodes instanceof Map) {
                for (const [name, node] of nodes) {
                    checkNode(name, node);
                }
            } else if (Array.isArray(nodes)) {
                for (const node of nodes) {
                    checkNode(node?.name || node?.identifier, node);
                }
            } else {
                for (const name of Object.keys(nodes)) {
                    checkNode(name, nodes[name]);
                }
            }

        } catch (error) {
            console.error("[LAVALINK] Node status error:", error.message);
        }

        return count;
    }

    getTotalNodeCount() {
        return this.nodes.size;
    }

    getNodeCount() {
        return this.getConnectedNodeCount();
    }

    hasConnectedNodes() {
        return this.getConnectedNodeCount() > 0;
    }

    async waitForNodeConnectEvent(timeout = 8000) {
        if (!this.riffy || this.destroying) return false;

        return new Promise(resolve => {
            let settled = false;

            const finish = result => {
                if (settled) return;

                settled = true;

                clearTimeout(timer);

                this.riffy?.off?.("nodeConnect", onConnect);

                resolve(result);
            };

            const onConnect = () => finish(true);

            const timer = setTimeout(
                () => finish(false),
                timeout
            );

            this.riffy.once("nodeConnect", onConnect);
        });
    }

    async waitForConnectedNode(maxWaitTime = 15000) {
        if (this.hasConnectedNodes()) return true;

        if (!this.riffy || this.destroying) return false;

        const startTime = Date.now();

        while (
            Date.now() - startTime < maxWaitTime &&
            !this.destroying
        ) {
            if (this.hasConnectedNodes()) return true;

            await new Promise(resolve => setTimeout(resolve, 500));
        }

        return false;
    }

    async ensureNodeAvailable() {
        if (this.destroying) {
            throw new Error("Lavalink manager is shutting down.");
        }

        if (this.hasConnectedNodes()) return true;

        console.log(
            `${colors.cyan}[ LAVALINK ][WAIT ]${colors.reset} Waiting for Lavalink node connection...`
        );

        await this.reconnectNodesNow(5000);

        if (this.hasConnectedNodes()) {
            console.log(
                `${colors.cyan}[ LAVALINK ][READY]${colors.reset} Node available (${this.getConnectedNodeCount()} connected)`
            );

            return true;
        }

        throw new Error(
            "No Lavalink nodes are currently available. Please check your node configuration."
        );
    }

    startHealthMonitoring() {
        if (this.healthCheckInterval || this.destroying) return;

        this.healthCheckInterval = setInterval(async () => {
            if (this.destroying) return;

            const connected = this.getConnectedNodeCount();
            const total = this.getTotalNodeCount();

            if (connected === 0 && total > 0) {
                console.log(
                    `[LAVALINK] No nodes connected (${connected}/${total}). Reconnecting...`
                );

                await this.reconnectNodesNow(5000);
            }
        }, 60000);

        this.reconnectInterval = setInterval(async () => {
            if (this.destroying) return;

            if (
                this.getConnectedNodeCount() === 0 &&
                this.getTotalNodeCount() > 0
            ) {
                await this.reconnectNodesNow(5000);
            }
        }, 30000);

        setTimeout(() => {
            if (this.destroying) return;

            console.log(
                `[LAVALINK] Node Status: ${this.getConnectedNodeCount()}/${this.getTotalNodeCount()} connected`
            );
        }, 5000);
    }

    getNodeStatus() {
        const status = {
            total: this.nodes.size,
            online: 0,
            offline: 0,
            nodes: []
        };

        for (const [nodeId, node] of this.nodes.entries()) {
            const nodeStatus = this.nodeStatus.get(nodeId) || {};
            const isConnected = this.isNodeConnected(nodeId);

            status.nodes.push({
                id: nodeId,
                name: node.displayName || node.name || node.id,
                host: node.host,
                port: node.port,
                online: isConnected,
                lastCheck: nodeStatus.lastCheck || null,
                lastError: nodeStatus.lastError || null
            });

            if (isConnected) {
                status.online++;
            } else {
                status.offline++;
            }
        }

        return status;
    }

    isNodeConnected(nodeId) {
        const node = this.nodes.get(nodeId);

        if (!node) return false;

        if (this.riffy?.nodes) {
            try {
                const nodes = this.riffy.nodes;

                const matches = riffyNode => {
                    if (!riffyNode) return false;

                    return (
                        riffyNode.host === node.host &&
                        String(riffyNode.port) === String(node.port) ||
                        riffyNode.name === node.id ||
                        riffyNode.identifier === node.id
                    ) && (
                        riffyNode.connected ||
                        riffyNode.state === "CONNECTED"
                    );
                };

                if (nodes instanceof Map) {
                    for (const riffyNode of nodes.values()) {
                        if (matches(riffyNode)) return true;
                    }
                } else if (Array.isArray(nodes)) {
                    for (const riffyNode of nodes) {
                        if (matches(riffyNode)) return true;
                    }
                } else {
                    for (const key of Object.keys(nodes)) {
                        if (matches(nodes[key])) return true;
                    }
                }

            } catch (_) {}
        }

        return this.nodeStatus.get(nodeId)?.online === true;
    }

    init(userId) {
        if (
            this.riffy &&
            typeof this.riffy.init === "function"
        ) {
            this.riffy.init(userId);
        }
    }

    destroy() {
        if (this.destroying) return;

        this.destroying = true;

        try {
            if (this.healthCheckInterval) {
                clearInterval(this.healthCheckInterval);
                this.healthCheckInterval = null;
            }

            if (this.connectLoopInterval) {
                clearInterval(this.connectLoopInterval);
                this.connectLoopInterval = null;
            }

            if (this.reconnectInterval) {
                clearInterval(this.reconnectInterval);
                this.reconnectInterval = null;
            }

            if (this.connectionResolve) {
                this.connectionResolve(false);
                this.connectionResolve = null;
                this.connectionPromise = null;
            }

            if (this.riffy) {
                const players = this.riffy.players;

                if (players && typeof players.values === "function") {
                    for (const player of players.values()) {
                        try {
                            if (typeof player.destroy === "function") {
                                player.destroy();
                            }
                        } catch (error) {
                            console.error(
                                "[LAVALINK] Player cleanup error:",
                                error.message
                            );
                        }
                    }
                }

                // Riffy does not necessarily expose destroy().
                // Never call it without checking its availability.
                if (typeof this.riffy.destroy === "function") {
                    this.riffy.destroy();
                }

                this.riffy = null;
            }

            this.initialized = false;

            console.log(
                `${colors.cyan}[ LAVALINK ]${colors.reset} ${colors.green}Cleanup completed successfully.${colors.reset}`
            );

        } catch (error) {
            console.error(
                "[LAVALINK] Shutdown cleanup error:",
                error
            );
        }
    }
}

// Manager instance
let nodeManagerInstance = null;

async function initializeLavalinkManager(client) {
    if (!nodeManagerInstance) {
        nodeManagerInstance = new LavalinkNodeManager(client);

        await nodeManagerInstance.initializeRiffy();
    }

    if (client && nodeManagerInstance.riffy) {
        client.riffy = nodeManagerInstance.riffy;
    }

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
