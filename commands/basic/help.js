
const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder
} = require('discord.js');

const config = require('../../config.js');
const fs = require('fs');
const path = require('path');

const { getLang } = require('../../utils/languageLoader');
const { getEmoji, getButtonEmoji } = require('../../UI/emojis/emoji');

const {
    safeDeferReply,
    stripLeadingIcons,
    handleCommandError
} = require('../../utils/responseHandler');

// ==========================================
// COMMAND DATA
// ==========================================

const data = new SlashCommandBuilder()
    .setName('help')
    .setDescription('Get information about the bot and its commands')
    .addStringOption(option =>
        option.setName('category')
            .setDescription('Select a category to view')
            .setRequired(false)
            .addChoices(
                { name: '🏠 Main Menu', value: 'main' },
                { name: '🎵 Music Commands', value: 'music' },
                { name: '📋 Playlist Commands', value: 'playlist' },
                { name: '💜 Basic Commands', value: 'basic' },
                { name: '🔧 Utility Commands', value: 'utility' }
            )
    );

// ==========================================
// CONSTANTS
// ==========================================

const CATEGORIES = ['basic', 'music', 'playlist', 'utility'];

const CATEGORY_INFO = {
    music: {
        name: 'Music Commands',
        description: 'Control music playback and settings'
    },
    playlist: {
        name: 'Playlist Commands',
        description: 'Manage your playlists'
    },
    basic: {
        name: 'Basic Commands',
        description: 'General bot information and utilities'
    },
    utility: {
        name: 'Utility Commands',
        description: 'Additional utility features'
    }
};

const COMMAND_MENTION_CACHE_TTL_MS = 5 * 60 * 1000;
const commandMentionCache = new Map();

// ==========================================
// CATEGORY DETECTION
// ==========================================

function getCommandCategory(commandName) {
    const commandsDir = path.resolve(__dirname, '../../commands');

    for (const category of CATEGORIES) {
        const categoryPath = path.join(commandsDir, category);

        if (!fs.existsSync(categoryPath)) continue;

        function searchDirectory(directory) {
            let items;

            try {
                items = fs.readdirSync(directory, {
                    withFileTypes: true
                });
            } catch {
                return false;
            }

            for (const item of items) {
                const fullPath = path.join(directory, item.name);

                if (item.isDirectory()) {
                    if (searchDirectory(fullPath)) return true;
                }

                if (
                    item.isFile() &&
                    item.name.endsWith('.js') &&
                    path.basename(item.name, '.js') === commandName
                ) {
                    return true;
                }
            }

            return false;
        }

        if (searchDirectory(categoryPath)) {
            return category;
        }
    }

    return 'basic';
}

function groupCommandsByCategory(client) {
    const grouped = {
        music: [],
        playlist: [],
        basic: [],
        utility: []
    };

    client.commands.forEach(command => {
        if (!command?.data?.name) return;

        const category = getCommandCategory(command.data.name);

        grouped[category].push(command);
    });

    return grouped;
}

// ==========================================
// UTILITIES
// ==========================================

function formatUptime(secondsTotal) {
    const days = Math.floor(secondsTotal / 86400);
    const hours = Math.floor((secondsTotal % 86400) / 3600);
    const minutes = Math.floor((secondsTotal % 3600) / 60);
    const seconds = Math.floor(secondsTotal % 60);

    return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

function getPingStatus(ping) {
    if (ping <= 90) return '🟢 Excellent';
    if (ping <= 180) return '🟢 Good';
    if (ping <= 280) return '🟡 Stable';

    return '🔴 High';
}

function getCategoryMeta(lang, category) {
    const translated = lang?.help?.categories?.[category] || {};
    const fallback = CATEGORY_INFO[category] || CATEGORY_INFO.basic;

    return {
        name: translated.name || fallback.name,
        description: translated.description || fallback.description
    };
}

function getCommandRef(commandName, mentionMap) {
    return mentionMap?.get(commandName) || `/${commandName}`;
}

function formatCommandMention(command) {
    if (!command?.name || !command?.id) return null;

    const options = Array.isArray(command.options)
        ? command.options
        : [];

    const subcommand = options.find(option => option.type === 1);

    if (subcommand?.name) {
        return `</${command.name} ${subcommand.name}:${command.id}>`;
    }

    return `</${command.name}:${command.id}>`;
}

// ==========================================
// COMMAND MENTION CACHE
// ==========================================

async function getCommandMentionMap(client, interaction) {
    const guildId = interaction.guildId || 'global';
    const cached = commandMentionCache.get(guildId);

    if (
        cached &&
        Date.now() - cached.fetchedAt < COMMAND_MENTION_CACHE_TTL_MS
    ) {
        return cached.map;
    }

    const mentionMap = new Map();

    try {
        if (client.application?.commands) {
            const commands = await client.application.commands.fetch();

            commands.forEach(command => {
                if (command.type === 1) {
                    mentionMap.set(
                        command.name,
                        formatCommandMention(command) || `/${command.name}`
                    );
                }
            });
        }
    } catch (error) {
        console.warn('[HELP] Could not fetch global commands:', error.message);
    }

    try {
        if (interaction.guild?.commands) {
            const commands = await interaction.guild.commands.fetch();

            commands.forEach(command => {
                if (command.type === 1) {
                    mentionMap.set(
                        command.name,
                        formatCommandMention(command) || `/${command.name}`
                    );
                }
            });
        }
    } catch (error) {
        console.warn('[HELP] Could not fetch guild commands:', error.message);
    }

    commandMentionCache.set(guildId, {
        fetchedAt: Date.now(),
        map: mentionMap
    });

    return mentionMap;
}

// ==========================================
// BUTTONS
// ==========================================

function createNavigationButton(
    label,
    customId,
    emojiKey,
    style = ButtonStyle.Secondary
) {
    const button = new ButtonBuilder()
        .setCustomId(customId)
        .setLabel(stripLeadingIcons(label))
        .setStyle(style);

    try {
        const emoji = getButtonEmoji(emojiKey);

        if (emoji) {
            button.setEmoji(emoji);
        }
    } catch (error) {
        console.warn('[HELP] Button emoji error:', error.message);
    }

    return button;
}

function buildTabsRow(activeKey) {
    const styleFor = key =>
        activeKey === key
            ? ButtonStyle.Primary
            : ButtonStyle.Secondary;

    return new ActionRowBuilder().addComponents(
        createNavigationButton(
            'Overview',
            'help_tab_overview',
            'home',
            styleFor('overview')
        ),
        createNavigationButton(
            'Music',
            'help_tab_music',
            'music',
            styleFor('music')
        ),
        createNavigationButton(
            'Playlist',
            'help_tab_playlist',
            'playlist',
            styleFor('playlist')
        ),
        createNavigationButton(
            'Basic',
            'help_tab_basic',
            'basic',
            styleFor('basic')
        ),
        createNavigationButton(
            'Utility',
            'help_tab_utility',
            'utility',
            styleFor('utility')
        )
    );
}

function buildControlsRow(backCustomId) {
    return new ActionRowBuilder().addComponents(
        createNavigationButton(
            'Back',
            backCustomId,
            'home',
            ButtonStyle.Secondary
        ),
        new ButtonBuilder()
            .setCustomId('help_close')
            .setLabel('Close')
            .setStyle(ButtonStyle.Danger)
    );
}

// ==========================================
// COMMAND SELECT MENU
// ==========================================

function buildCommandSelect(categoryKey, commands) {
    const options = commands.slice(0, 25).map(command => ({
        label: `/${command.data.name}`.slice(0, 100),
        description: (
            command.data.description || 'No description available'
        ).slice(0, 100),
        value: command.data.name
    }));

    if (!options.length) return null;

    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`help_select_${categoryKey}`)
            .setPlaceholder('Select a command for detailed information')
            .addOptions(options)
    );
}

// ==========================================
// EMBED BUILDER
// ==========================================

function getHelpColor() {
    const color = config.embedColor || config.color;

    if (typeof color === 'number') {
        return color;
    }

    if (typeof color === 'string' && /^#?[0-9a-fA-F]{6}$/.test(color)) {
        return parseInt(color.replace('#', ''), 16);
    }

    return 0x5865F2;
}

function buildHelpEmbed(title, sections, banner = null) {
    const embed = new EmbedBuilder()
        .setColor(getHelpColor())
        .setTitle(title)
        .setDescription(sections.join('\n\n').slice(0, 4000))
        .setFooter({
            text: 'Use the buttons below to navigate the help menu.'
        })
        .setTimestamp();

    if (banner) {
        embed.setImage(banner);
    }

    return embed;
}

function buildHelpBanner() {
    const bannerUrl = String(config.helpBannerUrl || '').trim();

    if (!bannerUrl) return null;

    try {
        const url = new URL(bannerUrl);

        if (!['https:', 'http:'].includes(url.protocol)) {
            return null;
        }

        return bannerUrl;
    } catch {
        return null;
    }
}

// ==========================================
// MAIN MENU
// ==========================================

function buildMainBody(client, lang, groupedCommands, mentionMap) {
    const botName = client.user?.username || 'SUNAINA';

    const totalCommands = client.commands.size;
    const totalServers = client.guilds.cache.size;

    const totalUsers = client.guilds.cache.reduce(
        (total, guild) => total + (guild.memberCount || 0),
        0
    );

    const uptime = formatUptime(process.uptime());
    const ping = client.ws.ping;

    const sections = [
        [
            `## ${getEmoji('commands')} Overview`,
            `**Bot:** ${botName}`,
            `**Commands:** ${totalCommands}`,
            `**Servers:** ${totalServers}`,
            `**Users:** ${totalUsers.toLocaleString()}`,
            `**Uptime:** ${uptime}`,
            `**Ping:** ${ping}ms (${getPingStatus(ping)})`
        ].join('\n'),

        [
            `## ${getEmoji('folder')} Categories`,
            `${getEmoji('music')} Music: **${groupedCommands.music.length}**`,
            `${getEmoji('playlist')} Playlist: **${groupedCommands.playlist.length}**`,
            `${getEmoji('basic')} Basic: **${groupedCommands.basic.length}**`,
            `${getEmoji('utility')} Utility: **${groupedCommands.utility.length}**`
        ].join('\n'),

        `${getEmoji('home')} Select a tab below to view commands.`,

        `${getEmoji('search')} Try: ${
            ['play', 'queue', 'search', 'history', 'stats']
                .map(name => getCommandRef(name, mentionMap))
                .join(' • ')
        }`
    ];

    return sections;
}

// ==========================================
// CATEGORY COMMAND GROUPS
// ==========================================

function getCategorySections(categoryKey) {
    const map = {
        music: [
            {
                title: 'Playback',
                keys: [
                    'play', 'search', 'pause', 'resume',
                    'skip', 'stop', 'seek', 'volume',
                    'np', 'trackinfo', 'voteskip'
                ]
            },
            {
                title: 'Queue',
                keys: ['queue', 'shuffle', 'move', 'remove', 'jump']
            },
            {
                title: 'Effects',
                keys: ['filters', 'autoplay']
            }
        ],

        playlist: [
            {
                title: 'Manage',
                keys: [
                    'playlist', 'createplaylist',
                    'deleteplaylist', 'myplaylists',
                    'allplaylists'
                ]
            },
            {
                title: 'Songs',
                keys: ['addsong', 'deletesong', 'showsongs']
            },
            {
                title: 'Playback',
                keys: ['playcustomplaylist', 'savequeue']
            }
        ],

        basic: [
            {
                title: 'General',
                keys: ['help', 'ping', 'stats', 'support']
            }
        ],

        utility: [
            {
                title: 'Server',
                keys: ['language', '247']
            },
            {
                title: 'Music Tools',
                keys: ['history']
            }
        ]
    };

    return map[categoryKey] || [];
}

function renderCategoryTree(categoryKey, commands, mentionMap) {
    const sections = getCategorySections(categoryKey);

    const commandMap = new Map(
        commands.map(command => [command.data.name, command])
    );

    const consumed = new Set();
    const lines = [];

    for (const section of sections) {
        const found = section.keys.filter(name => commandMap.has(name));

        if (!found.length) continue;

        found.forEach(name => consumed.add(name));

        lines.push(`**${section.title} (${found.length})**`);

        lines.push(
            found.map(name => getCommandRef(name, mentionMap)).join('  ')
        );

        lines.push('');
    }

    const extra = commands
        .map(command => command.data.name)
        .filter(name => !consumed.has(name));

    if (extra.length) {
        lines.push(`**Extra (${extra.length})**`);

        lines.push(
            extra.map(name => getCommandRef(name, mentionMap)).join('  ')
        );
    }

    return lines.length
        ? lines.join('\n').trim().slice(0, 3500)
        : '`No commands available.`';
}

// ==========================================
// CATEGORY PAGE
// ==========================================

function buildCategoryBody(lang, groupedCommands, categoryKey, mentionMap) {
    const categoryMeta = getCategoryMeta(lang, categoryKey);

    const commands = groupedCommands[categoryKey] || [];

    const sortedCommands = [...commands].sort(
        (a, b) => a.data.name.localeCompare(b.data.name)
    );

    const tree = sortedCommands.length
        ? renderCategoryTree(categoryKey, sortedCommands, mentionMap)
        : '`No commands available in this category.`';

    return [
        categoryMeta.description,
        `## ${getEmoji('folder')} Commands\n${tree}`,
        `${getEmoji('search')} Select a command below to view details.`
    ];
}

// ==========================================
// COMMAND DETAILS
// ==========================================

function buildCommandDetailsBody(lang, categoryKey, command, mentionMap) {
    const categoryMeta = getCategoryMeta(lang, categoryKey);

    const json = command.data.toJSON();

    const commandRef = getCommandRef(json.name, mentionMap);

    const options = (json.options || [])
        .map(option =>
            `• \`${option.name}\`: ${option.description || 'No description'}`
        )
        .join('\n');

    return [
        `## ${getEmoji('commands')} ${commandRef}\n${json.description || 'No description available.'}`,

        [
            `## ${getEmoji(categoryKey)} Category`,
            `**${categoryMeta.name}**`,
            `**Run:** ${commandRef}`
        ].join('\n'),

        `## ${getEmoji('settings')} Options\n${options || '`No options for this command.`'}`
    ];
}

// ==========================================
// RESPONSE HANDLER
// ==========================================

async function sendHelpResponse(interaction, embed, components = []) {
    const response = {
        embeds: [embed],
        components
    };

    try {
        // Interaction already acknowledged.
        if (interaction.deferred || interaction.replied) {
            return await interaction.editReply(response);
        }

        // New button or select menu interaction.
        if (
            interaction.isButton?.() ||
            interaction.isStringSelectMenu?.()
        ) {
            return await interaction.update(response);
        }

        // New slash command interaction.
        return await interaction.reply(response);

    } catch (error) {
        console.error('[HELP] Failed to send response:', error);

        // Try a safe fallback only if the interaction is still unacknowledged.
        if (!interaction.deferred && !interaction.replied) {
            try {
                return await interaction.reply({
                    content: 'Unable to display the help menu. Please try again.',
                    ephemeral: true
                });
            } catch (fallbackError) {
                console.error('[HELP] Fallback response failed:', fallbackError);
            }
        }

        throw error;
    }
}

// ==========================================
// SHOW MAIN MENU
// ==========================================

async function showMainMenu(client, interaction) {
    const lang = await getLang(interaction.guildId).catch(() => ({}));

    const groupedCommands = groupCommandsByCategory(client);

    const mentionMap = await getCommandMentionMap(client, interaction);

    const banner = buildHelpBanner();

    const embed = buildHelpEmbed(
        `${getEmoji('help')} ${client.user?.username || 'SUNAINA'} Help Section`,
        buildMainBody(client, lang, groupedCommands, mentionMap),
        banner
    );

    return sendHelpResponse(
        interaction,
        embed,
        [buildTabsRow('overview')]
    );
}

// ==========================================
// SHOW CATEGORY
// ==========================================

async function showCategoryPage(client, interaction, categoryKey) {
    const lang = await getLang(interaction.guildId).catch(() => ({}));

    const groupedCommands = groupCommandsByCategory(client);

    const mentionMap = await getCommandMentionMap(client, interaction);

    const safeCategory = CATEGORIES.includes(categoryKey)
        ? categoryKey
        : 'basic';

    const commands = [...(groupedCommands[safeCategory] || [])].sort(
        (a, b) => a.data.name.localeCompare(b.data.name)
    );

    const components = [
        buildTabsRow(safeCategory)
    ];

    const selectMenu = buildCommandSelect(safeCategory, commands);

    if (selectMenu) {
        components.push(selectMenu);
    }

    components.push(
        buildControlsRow('help_back_overview')
    );

    const embed = buildHelpEmbed(
        `${getEmoji(safeCategory)} ${getCategoryMeta(lang, safeCategory).name}`,
        buildCategoryBody(lang, groupedCommands, safeCategory, mentionMap),
        buildHelpBanner()
    );

    return sendHelpResponse(
        interaction,
        embed,
        components
    );
}

// ==========================================
// SHOW COMMAND DETAILS
// ==========================================

async function showCommandDetails(client, interaction, categoryKey, commandName) {
    const lang = await getLang(interaction.guildId).catch(() => ({}));

    const groupedCommands = groupCommandsByCategory(client);

    const mentionMap = await getCommandMentionMap(client, interaction);

    const safeCategory = CATEGORIES.includes(categoryKey)
        ? categoryKey
        : 'basic';

    const commands = [...(groupedCommands[safeCategory] || [])].sort(
        (a, b) => a.data.name.localeCompare(b.data.name)
    );

    const command = commands.find(
        item => item.data.name === commandName
    );

    if (!command) {
        return showCategoryPage(client, interaction, safeCategory);
    }

    const components = [
        buildTabsRow(safeCategory)
    ];

    const selectMenu = buildCommandSelect(safeCategory, commands);

    if (selectMenu) {
        components.push(selectMenu);
    }

    components.push(
        buildControlsRow(`help_back_cat_${safeCategory}`)
    );

    const embed = buildHelpEmbed(
        `${getEmoji('commands')} Command Details`,
        buildCommandDetailsBody(
            lang,
            safeCategory,
            command,
            mentionMap
        ),
        buildHelpBanner()
    );

    return sendHelpResponse(
        interaction,
        embed,
        components
    );
}

// ==========================================
// EXPIRED / CLOSE
// ==========================================

async function showExpired(client, interaction) {
    const embed = buildHelpEmbed(
        'Bot Information',
        [
            `${getEmoji('warning')} **Help menu closed.**`,
            'Run `/help` again to open a fresh help panel.',
            '**Quick Commands:** `/help`, `/ping`, `/stats`, `/support`, `/play`'
        ]
    );

    return sendHelpResponse(interaction, embed, []);
}

// ==========================================
// NAVIGATION
// ==========================================

async function renderFromSelection(client, interaction, selectedCategory) {
    if (
        ['main', 'home', 'overview'].includes(selectedCategory)
    ) {
        return showMainMenu(client, interaction);
    }

    return showCategoryPage(client, interaction, selectedCategory);
}

// ==========================================
// COMPONENT HANDLER
// ==========================================

async function handleComponent(client, interaction) {
    const customId = interaction.customId;

    if (!customId) return;

    if (customId === 'help_close') {
        return showExpired(client, interaction);
    }

    if (
        customId === 'help_back_main' ||
        customId === 'help_back_overview' ||
        customId === 'help_home'
    ) {
        return showMainMenu(client, interaction);
    }

    if (customId.startsWith('help_back_cat_')) {
        const category = customId.replace('help_back_cat_', '');

        return showCategoryPage(client, interaction, category);
    }

    if (customId.startsWith('help_tab_')) {
        const tab = customId.replace('help_tab_', '');

        return renderFromSelection(client, interaction, tab);
    }

    if (customId.startsWith('help_cat_')) {
        const category = customId.replace('help_cat_', '');

        return showCategoryPage(client, interaction, category);
    }

    if (customId === 'help_category_select') {
        const category = interaction.values?.[0];

        return renderFromSelection(client, interaction, category);
    }

    if (customId.startsWith('help_select_')) {
        const category = customId.replace('help_select_', '');

        const commandName = interaction.values?.[0];

        if (!commandName) return;

        return showCommandDetails(
            client,
            interaction,
            category,
            commandName
        );
    }
}

// ==========================================
// MODULE EXPORTS
// ==========================================

module.exports = {
    data,

    helpers: {
        showMainMenu,
        showCategoryPage,
        showCommandDetails,
        showExpired,
        renderFromSelection,
        handleComponent,
        groupCommandsByCategory
    },

    run: async (client, interaction) => {
        try {
            const deferred = await safeDeferReply(interaction);

            if (
                !deferred &&
                !interaction.deferred &&
                !interaction.replied
            ) {
                return;
            }

            const selectedCategory =
                interaction.options.getString('category') || 'main';

            return await renderFromSelection(
                client,
                interaction,
                selectedCategory
            );

        } catch (error) {
            console.error('[HELP] Command execution error:', error);

            return handleCommandError(
                interaction,
                error,
                'help',
                '## ❌ Help Error\n\nFailed to load the help interface. Please try again later.'
            );
        }
    }
};
