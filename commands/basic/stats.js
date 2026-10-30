
const {
    SlashCommandBuilder,
    ContainerBuilder,
    MessageFlags
} = require('discord.js');

const os = require('os');
const { getLang } = require('../../utils/languageLoader');
const { getEmoji } = require('../../UI/emojis/emoji');
const { safeDeferReply } = require('../../utils/responseHandler');

const data = new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Show bot statistics and server information');

function formatUptime(ms = 0) {
    const seconds = Math.floor((ms || 0) / 1000);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;

    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;

    return `${remainingSeconds}s`;
}

function formatBytes(bytes = 0) {
    if (!bytes || bytes <= 0) return '0 Bytes';

    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(
        Math.floor(Math.log(bytes) / Math.log(1024)),
        sizes.length - 1
    );

    return `${(bytes / Math.pow(1024, index)).toFixed(2)} ${sizes[index]}`;
}

function emoji(name) {
    try {
        return getEmoji(name) || '';
    } catch {
        return '';
    }
}

function translate(value, fallback, replacements = {}) {
    let result = typeof value === 'string' ? value : fallback;

    for (const [key, replacement] of Object.entries(replacements)) {
        result = result.replaceAll(`{${key}}`, String(replacement));
    }

    return result;
}

function buildStatsCard(sections) {
    const container = new ContainerBuilder()
        .addTextDisplayComponents(text =>
            text.setContent('## 📊 Bot Statistics')
        );

    for (const section of sections) {
        container
            .addSeparatorComponents(separator => separator)
            .addTextDisplayComponents(text =>
                text.setContent(section)
            );
    }

    return container;
}

module.exports = {
    data,

    run: async (client, interaction) => {
        try {
            // Defer immediately to prevent interaction timeout.
            const deferred = await safeDeferReply(interaction);

            if (
                !deferred &&
                !interaction.deferred &&
                !interaction.replied
            ) {
                return;
            }

            const lang = await getLang(interaction.guildId).catch(() => ({}));
            const t = lang?.stats || {};

            // Lavalink / Riffy protection
            const players = client.riffy?.players;

            const playerMap =
                players && typeof players.values === 'function'
                    ? Array.from(players.values())
                    : [];

            const activePlayers = playerMap.filter(
                player => player.playing || player.paused
            );

            const totalPlayers = playerMap.length;
            const player = players?.get?.(interaction.guildId);

            // Memory information
            const memoryUsage = process.memoryUsage();
            const totalMemory = os.totalmem();
            const freeMemory = os.freemem();
            const usedMemory = totalMemory - freeMemory;

            // Track information
            const trackTitle =
                player?.current?.info?.title ||
                player?.queue?.current?.info?.title ||
                'None';

            const currentTrack =
                trackTitle.length > 40
                    ? trackTitle.substring(0, 40) + '...'
                    : trackTitle;

            // System information
            const cpu = os.cpus()?.[0]?.model || 'Unknown';
            const cpuName = cpu.length > 40
                ? cpu.substring(0, 40) + '...'
                : cpu;

            const sections = [
                [
                    '### 🤖 Bot Information',
                    `**Name:** ${client.user?.username || 'Unknown'}`,
                    `**ID:** ${client.user?.id || 'Unknown'}`,
                    `**Ping:** ${client.ws?.ping ?? 'N/A'} ms`,
                    `**Uptime:** ${formatUptime(client.uptime)}`
                ].join('\n'),

                [
                    `### ${emoji('servers')} Server Statistics`,
                    `**Servers:** ${client.guilds.cache.size.toLocaleString()}`,
                    `**Users (cached):** ${client.users.cache.size.toLocaleString()}`,
                    `**Channels (cached):** ${client.channels.cache.size.toLocaleString()}`,
                    `**Commands:** ${client.commands?.size || 0}`
                ].join('\n'),

                [
                    `### ${emoji('music')} Music Statistics`,
                    `**Active Players:** ${activePlayers.length}`,
                    `**Total Players:** ${totalPlayers}`,
                    `**Current Track:** ${currentTrack}`
                ].join('\n'),

                [
                    `### ${emoji('tools')} System Information`,
                    `**CPU:** ${cpuName}`,
                    `**Platform:** ${os.platform()}`,
                    `**Architecture:** ${os.arch()}`,
                    `**Node.js:** ${process.version}`,
                    `**Discord.js:** ${require('discord.js').version}`
                ].join('\n'),

                [
                    `### ${emoji('settings')} Memory Information`,
                    `**Heap Used:** ${formatBytes(memoryUsage.heapUsed)}`,
                    `**Heap Total:** ${formatBytes(memoryUsage.heapTotal)}`,
                    `**System Used:** ${formatBytes(usedMemory)}`,
                    `**System Free:** ${formatBytes(freeMemory)}`,
                    `**Shards:** ${client.shard?.count || 1}`
                ].join('\n')
            ];

            const card = buildStatsCard(sections);

            return await interaction.editReply({
                components: [card],
                flags: MessageFlags.IsComponentsV2
            });

        } catch (error) {
            console.error('[ STATS COMMAND ERROR ]', error);

            const errorMessage =
                '❌ Unable to retrieve bot statistics. Please try again later.';

            try {
                if (interaction.deferred) {
                    return await interaction.editReply({
                        content: errorMessage,
                        components: []
                    });
                }

                if (interaction.replied) {
                    return await interaction.followUp({
                        content: errorMessage,
                        flags: MessageFlags.Ephemeral
                    });
                }

                return await interaction.reply({
                    content: errorMessage,
                    flags: MessageFlags.Ephemeral
                });

            } catch (replyError) {
                console.error(
                    '[ STATS RESPONSE ERROR ]',
                    replyError
                );
            }
        }
    }
};
