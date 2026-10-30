
require("dotenv").config();

const {
    Client,
    GatewayIntentBits,
    GatewayDispatchEvents,
    Events
} = require("discord.js");

const fs = require("fs");
const path = require("path");
const express = require("express");

const config = require("./config.js");
const colors = require("./UI/colors/colors");
const { connectToDatabase } = require("./mongodb");

const {
    initializePlayer,
    getLavalinkManager
} = require("./lavalink.js");

const { getLangSync } = require("./utils/languageLoader.js");

// ==========================================
// CLIENT CONFIGURATION
// ==========================================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
    ]
});

client.config = config;
client.commands = new Map();
client.commandsArray = [];

const PREFIX = colors.cyan;
const RESET = colors.reset;
const GREEN = colors.green;
const RED = colors.red;
const YELLOW = colors.yellow;
const MAGENTA = colors.magenta;

function getLanguage() {
    try {
        return getLangSync() || {};
    } catch {
        return {};
    }
}

// ==========================================
// ERROR HANDLING
// ==========================================

process.on("unhandledRejection", (error) => {
    console.error(
        `${RED}[ UNHANDLED REJECTION ]${RESET}`,
        error
    );
});

process.on("uncaughtException", (error) => {
    console.error(
        `${RED}[ UNCAUGHT EXCEPTION ]${RESET}`,
        error
    );
});

// ==========================================
// LOAD EVENTS
// ==========================================

function loadEvents() {
    const eventsPath = path.join(__dirname, "events");

    if (!fs.existsSync(eventsPath)) {
        console.warn(
            `${YELLOW}[ EVENTS ] Directory not found.${RESET}`
        );
        return;
    }

    const eventFiles = fs.readdirSync(eventsPath)
        .filter(file => file.endsWith(".js"));

    for (const file of eventFiles) {
        const filePath = path.join(eventsPath, file);

        try {
            const event = require(filePath);

            if (typeof event !== "function") {
                console.warn(
                    `${YELLOW}[ EVENTS ] Invalid event: ${file}${RESET}`
                );
                continue;
            }

            const eventName = path.basename(file, ".js");

            client.on(eventName, (...args) => {
                try {
                    const result = event(client, ...args);

                    if (result && typeof result.catch === "function") {
                        result.catch(error => {
                            console.error(
                                `[ EVENT ERROR ] ${eventName}:`,
                                error
                            );
                        });
                    }
                } catch (error) {
                    console.error(
                        `[ EVENT ERROR ] ${eventName}:`,
                        error
                    );
                }
            });

            console.log(
                `${PREFIX}[ EVENTS ]${RESET} ${GREEN}Loaded: ${file}${RESET}`
            );

        } catch (error) {
            console.error(
                `${RED}[ EVENTS ] Failed to load ${file}:${RESET}`,
                error
            );
        }
    }
}

// ==========================================
// LOAD COMMANDS
// ==========================================

function loadCommands() {
    const commandsDir = path.resolve(
        __dirname,
        config.commandsDir || "commands"
    );

    if (!fs.existsSync(commandsDir)) {
        console.error(
            `${RED}[ COMMANDS ] Directory not found: ${commandsDir}${RESET}`
        );
        return;
    }

    function loadFromDirectory(directory) {
        const items = fs.readdirSync(directory, {
            withFileTypes: true
        });

        for (const item of items) {
            const fullPath = path.join(directory, item.name);

            if (item.isDirectory()) {
                loadFromDirectory(fullPath);
                continue;
            }

            if (!item.isFile() || !item.name.endsWith(".js")) {
                continue;
            }

            try {
                const command = require(fullPath);

                if (
                    !command ||
                    !command.data ||
                    typeof command.run !== "function" ||
                    typeof command.data.toJSON !== "function"
                ) {
                    console.warn(
                        `${YELLOW}[ COMMANDS ] Invalid command: ${item.name}${RESET}`
                    );
                    continue;
                }

                const commandData = command.data.toJSON();

                if (!commandData.name) {
                    console.warn(
                        `${YELLOW}[ COMMANDS ] Missing name: ${item.name}${RESET}`
                    );
                    continue;
                }

                if (client.commands.has(commandData.name)) {
                    console.warn(
                        `${YELLOW}[ COMMANDS ] Duplicate: ${commandData.name}${RESET}`
                    );
                    continue;
                }

                client.commands.set(commandData.name, command);
                client.commandsArray.push(commandData);

                console.log(
                    `${PREFIX}[ COMMANDS ]${RESET} ${GREEN}Loaded: ${commandData.name}${RESET}`
                );

            } catch (error) {
                console.error(
                    `${RED}[ COMMANDS ] Error loading ${item.name}:${RESET}`,
                    error
                );
            }
        }
    }

    loadFromDirectory(commandsDir);

    console.log(
        `${PREFIX}[ COMMANDS ]${RESET} ${GREEN}Total Commands: ${client.commands.size}${RESET}`
    );
}

// ==========================================
// LAVALINK INITIALIZATION
// ==========================================

async function setupLavalink() {
    try {
        const manager = await initializePlayer(client);

        if (!manager || !manager.riffy) {
            throw new Error(
                "Lavalink manager or Riffy instance was not created."
            );
        }

        // Make Riffy available to other bot modules.
        client.riffy = manager.riffy;

        console.log(
            `${PREFIX}[ LAVALINK ]${RESET} ${GREEN}Riffy initialized successfully.${RESET}`
        );

        return manager;

    } catch (error) {
        console.error(
            `${RED}[ LAVALINK ] Initialization failed:${RESET}`,
            error
        );

        throw error;
    }
}

// ==========================================
// CLIENT READY
// ==========================================

client.once(Events.ClientReady, () => {
    const lang = getLanguage();

    console.log("\n" + "─".repeat(45));

    console.log(
        `${PREFIX}[ SYSTEM ]${RESET} ${GREEN}${lang.console?.bot?.clientLogged?.replace("{tag}", client.user.tag) || `Logged in as ${client.user.tag}`}${RESET}`
    );

    console.log(
        `${PREFIX}[ MUSIC ]${RESET} ${GREEN}${lang.console?.bot?.musicSystemReady || "Music System Ready 🎵"}${RESET}`
    );

    console.log("─".repeat(45));

    try {
        const manager = getLavalinkManager();

        if (manager) {
            manager.init(client.user.id);

            setTimeout(() => {
                try {
                    const status = manager.getNodeStatus();
                    const available = manager.getNodeCount();
                    const total = manager.getTotalNodeCount();

                    console.log(
                        `${PREFIX}[ LAVALINK ]${RESET} ${GREEN}Nodes: ${available}/${total}${RESET}`
                    );

                    if (status?.nodes?.length) {
                        for (const node of status.nodes) {
                            const icon = node.online ? "✅" : "❌";

                            console.log(
                                `${PREFIX}[ NODE ]${RESET} ${icon} ${node.name} (${node.host}:${node.port})`
                            );

                            if (node.lastError) {
                                console.log(
                                    `${YELLOW}${node.lastError}${RESET}`
                                );
                            }
                        }
                    }

                } catch (error) {
                    console.error(
                        "[ LAVALINK ] Status error:",
                        error
                    );
                }
            }, 3000);
        }

    } catch (error) {
        console.error(
            "[ LAVALINK ] Ready error:",
            error
        );
    }
});

// ==========================================
// RIFFY VOICE STATE UPDATES
// ==========================================

client.on("raw", (packet) => {
    try {
        if (
            packet.t !== GatewayDispatchEvents.VoiceStateUpdate &&
            packet.t !== GatewayDispatchEvents.VoiceServerUpdate
        ) {
            return;
        }

        if (config.voiceDebug === true) {
            console.log(
                `[ VOICE DEBUG ] Event: ${packet.t}`
            );
        }

        if (client.riffy?.updateVoiceState) {
            client.riffy.updateVoiceState(packet);
        }

    } catch (error) {
        console.error(
            "[ VOICE ERROR ]",
            error
        );
    }
});

// ==========================================
// EXPRESS WEB SERVER
// ==========================================

const app = express();

const PORT = Number(process.env.PORT) || 3000;

app.disable("x-powered-by");

app.get("/", (req, res) => {
    const indexPath = path.join(__dirname, "index.html");

    if (!fs.existsSync(indexPath)) {
        return res.status(404).send("index.html not found.");
    }

    return res.sendFile(indexPath);
});

app.get("/health", (req, res) => {
    res.json({
        status: "online",
        bot: client.isReady(),
        uptime: process.uptime()
    });
});

const server = app.listen(PORT, "0.0.0.0", () => {
    console.log("\n" + "─".repeat(45));

    console.log(
        `${MAGENTA}🌐 SERVER STATUS${RESET}`
    );

    console.log(
        `${PREFIX}[ SERVER ]${RESET} ${GREEN}Online ✅${RESET}`
    );

    console.log(
        `${PREFIX}[ PORT ]${RESET} ${YELLOW}${PORT}${RESET}`
    );

    console.log(
        `${PREFIX}[ TIME ]${RESET} ${new Date().toISOString()}`
    );

    console.log("─".repeat(45));
});

// ==========================================
// START BOT
// ==========================================

async function startBot() {
    try {
        console.log(
            `${PREFIX}[ SYSTEM ]${RESET} Starting bot...`
        );

        loadEvents();
        loadCommands();

        // Initialize Lavalink.
        await setupLavalink();

        // Connect MongoDB.
        try {
            await connectToDatabase();

            console.log(
                `${PREFIX}[ DATABASE ]${RESET} ${GREEN}MongoDB Connected ✅${RESET}`
            );

        } catch (error) {
            console.error(
                `${RED}[ DATABASE ] Connection failed:${RESET}`,
                error.message
            );
        }

        // Discord token.
        const token = config.TOKEN || process.env.TOKEN;

        if (!token) {
            throw new Error(
                "Discord token missing. Check config.js or .env."
            );
        }

        await client.login(token);

        console.log(
            `${PREFIX}[ SYSTEM ]${RESET} ${GREEN}Discord login successful.${RESET}`
        );

    } catch (error) {
        console.error(
            `${RED}[ STARTUP ERROR ]${RESET}`,
            error
        );

        process.exitCode = 1;
    }
}

// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================

async function shutdown() {
    console.log("[ SYSTEM ] Shutting down...");

    try {
        const manager = getLavalinkManager();

        if (manager) {
            manager.destroy();
        }

        client.destroy();

        server.close(() => {
            process.exit(0);
        });

        setTimeout(() => process.exit(1), 5000).unref();

    } catch (error) {
        console.error("[ SHUTDOWN ERROR ]", error);
        process.exit(1);
    }
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ==========================================
// RUN
// ==========================================

startBot();
