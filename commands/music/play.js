
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const config = require('../../config.js');
const SpotifyWebApi = require('spotify-web-api-node');
const { getData } = require('spotify-url-info')(require('node-fetch'));

const {
    sendErrorResponse,
    handleCommandError,
    safeDeferReply,
    buildPaleCard,
    sanitizeTitle,
    stripLeadingIcons
} = require('../../utils/responseHandler.js');

const { checkVoiceChannel: checkVC } = require('../../utils/voiceChannelCheck.js');
const { getLavalinkManager } = require('../../lavalink.js');
const { getLang } = require('../../utils/languageLoader');
const { getEmoji } = require('../../UI/emojis/emoji');

const requesters = new Map();

// ==========================================
// DURATION FORMATTER
// ==========================================

function formatDuration(ms) {
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);

    return [
        hours > 0 ? `${hours}h` : null,
        minutes > 0 ? `${minutes}m` : null,
        `${seconds}s`
    ].filter(Boolean).join(' ');
}

// ==========================================
// SLASH COMMAND
// ==========================================

const data = new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song from a name or link')
    .addStringOption(option =>
        option
            .setName('name')
            .setDescription('Enter song name / link or playlist')
            .setRequired(true)
            .setAutocomplete(true)
    );

// ==========================================
// SPOTIFY API
// ==========================================

const spotifyApi = new SpotifyWebApi({
    clientId: config.spotifyClientId,
    clientSecret: config.spotifyClientSecret
});

// ==========================================
// WAIT FOR PLAYER CONNECTION
// ==========================================

async function waitForPlayerConnection(player, timeoutMs = 7000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        if (player?.connected) {
            return true;
        }

        await new Promise(resolve => setTimeout(resolve, 150));
    }

    return false;
}

// ==========================================
// SPOTIFY PLAYLIST TRACKS
// ==========================================

async function getSpotifyPlaylistTracks(playlistId) {
    try {
        const data = await spotifyApi.clientCredentialsGrant();

        spotifyApi.setAccessToken(data.body.access_token);

        let tracks = [];
        let offset = 0;
        const limit = 100;
        let total = 0;

        do {
            const response = await spotifyApi.getPlaylistTracks(
                playlistId,
                { limit, offset }
            );

            total = response.body.total;
            offset += limit;

            for (const item of response.body.items) {
                if (
                    item.track &&
                    item.track.name &&
                    item.track.artists
                ) {
                    const trackName =
                        `${item.track.name} - ${item.track.artists.map(a => a.name).join(', ')}`;

                    tracks.push(trackName);
                }
            }

        } while (offset < total);

        return tracks;

    } catch (error) {
        console.error('[SPOTIFY PLAYLIST ERROR]', error);
        return [];
    }
}

// ==========================================
// MAIN COMMAND
// ==========================================

module.exports = {

    data,

    run: async (client, interaction) => {

        try {

            // ==========================================
            // AUTOCOMPLETE HANDLER
            // ==========================================

            if (interaction.isAutocomplete()) {

                if (interaction.commandName !== 'play') {
                    return;
                }

                let responded = false;
                let timeout;

                const safeRespond = async (choices = []) => {

                    if (responded || interaction.responded) {
                        return;
                    }

                    responded = true;

                    try {
                        await interaction.respond(
                            Array.isArray(choices)
                                ? choices.slice(0, 25)
                                : []
                        );

                    } catch (error) {
                        console.error(
                            '[PLAY AUTOCOMPLETE RESPONSE ERROR]',
                            error
                        );
                    }
                };

                try {

                    const focusedOption =
                        interaction.options.getFocused(true);

                    if (focusedOption.name !== 'name') {
                        await safeRespond([]);
                        return;
                    }

                    const query = String(
                        focusedOption.value || ''
                    ).trim();

                    if (query.length < 2) {
                        await safeRespond([]);
                        return;
                    }

                    // Search Lavalink
                    const searchPromise = (async () => {

                        const nodeManager = getLavalinkManager();

                        if (!nodeManager || !client.riffy) {
                            return [];
                        }

                        await nodeManager.ensureNodeAvailable();

                        const result = await client.riffy.resolve({
                            query,
                            requester: interaction.user.username
                        });

                        if (
                            !result ||
                            !Array.isArray(result.tracks)
                        ) {
                            return [];
                        }

                        return result.tracks.slice(0, 25).map(track => {

                            const info = track?.info || {};

                            const title = info.title || 'Unknown Song';
                            const author = info.author || 'Unknown Artist';

                            const duration = formatDuration(
                                Number(info.length) || 0
                            );

                            const display =
                                `${title} - ${author} (${duration})`;

                            const value =
                                typeof info.uri === 'string' &&
                                info.uri.length > 0 &&
                                info.uri.length <= 100
                                    ? info.uri
                                    : query.slice(0, 100);

                            return {
                                name: display.length > 100
                                    ? display.slice(0, 97) + '...'
                                    : display,

                                value
                            };
                        });

                    })();

                    // Discord autocomplete timeout protection
                    const timeoutPromise = new Promise(resolve => {

                        timeout = setTimeout(() => {
                            resolve([]);
                        }, 1800);

                    });

                    const choices = await Promise.race([
                        searchPromise,
                        timeoutPromise
                    ]);

                    clearTimeout(timeout);

                    await safeRespond(choices);

                } catch (error) {

                    clearTimeout(timeout);

                    console.error(
                        '[PLAY AUTOCOMPLETE ERROR]',
                        error
                    );

                    await safeRespond([]);
                }

                return;
            }

            // ==========================================
            // NORMAL PLAY COMMAND
            // ==========================================

            const lang = await getLang(interaction.guildId);
            const t = lang.music.play;

            const query = interaction.options.getString('name');

            const deferred = await safeDeferReply(interaction);

            if (
                !deferred &&
                !interaction.deferred &&
                !interaction.replied
            ) {
                return;
            }

            const existingPlayer =
                client.riffy.players.get(interaction.guildId);

            const voiceCheck = await checkVC(
                interaction,
                existingPlayer
            );

            if (!voiceCheck.allowed) {

                const reply = await interaction.editReply(
                    voiceCheck.response
                );

                setTimeout(() => {
                    reply.delete().catch(() => {});
                }, 5000);

                return reply;
            }

            // ==========================================
            // LAVALINK MANAGER
            // ==========================================

            const nodeManager = getLavalinkManager();

            if (!nodeManager) {

                return sendErrorResponse(
                    interaction,

                    t.lavalinkManagerError.title + '\n\n' +
                    t.lavalinkManagerError.message + '\n' +
                    t.lavalinkManagerError.note,

                    5000
                );
            }

            try {

                await nodeManager.ensureNodeAvailable();

            } catch (error) {

                const nodeCount = nodeManager.getNodeCount();
                const totalCount = nodeManager.getTotalNodeCount();

                return sendErrorResponse(
                    interaction,

                    t.noNodes.title + '\n\n' +
                    t.noNodes.message
                        .replace('{connected}', nodeCount)
                        .replace('{total}', totalCount) + '\n' +
                    t.noNodes.note,

                    5000
                );
            }

            // ==========================================
            // VOICE CHANNEL
            // ==========================================

            const userVoiceChannel =
                interaction.member.voice.channelId;

            if (
                existingPlayer &&
                existingPlayer.voiceChannel !== userVoiceChannel
            ) {

                try {

                    const { cleanupTrackMessages } =
                        require('../../player.js');

                    await cleanupTrackMessages(
                        client,
                        existingPlayer
                    );

                    existingPlayer.queue.clear();
                    existingPlayer.stop();

                    await new Promise(resolve =>
                        setTimeout(resolve, 300)
                    );

                    existingPlayer.destroy();

                    await new Promise(resolve =>
                        setTimeout(resolve, 500)
                    );

                } catch (error) {

                    console.error(
                        'Error destroying old player:',
                        error
                    );

                    try {

                        if (!existingPlayer.destroyed) {

                            existingPlayer.destroy();

                            await new Promise(resolve =>
                                setTimeout(resolve, 500)
                            );
                        }

                    } catch (e) {}
                }
            }

            // ==========================================
            // NODE HEALTH
            // ==========================================

            await nodeManager.checkAllNodesHealth().catch(() => {});
            await nodeManager.forceConnectAllNodes().catch(() => {});

            await new Promise(resolve =>
                setTimeout(resolve, 400)
            );

            // ==========================================
            // CREATE PLAYER CONNECTION
            // ==========================================

            let player;
            let attempts = 0;

            const maxAttempts = 3;

            while (attempts < maxAttempts) {

                await nodeManager.ensureNodeAvailable();

                try {

                    player = client.riffy.createConnection({
                        guildId: interaction.guildId,
                        voiceChannel: userVoiceChannel,
                        textChannel: interaction.channelId,
                        deaf: true
                    });

                    break;

                } catch (err) {

                    attempts++;

                    const msg = err?.message || '';

                    if (
                        attempts < maxAttempts &&
                        (
                            msg.includes('No nodes are available') ||
                            msg.includes('fetch failed')
                        )
                    ) {

                        await nodeManager.reconnectNodesNow?.(5000)
                            .catch(() => {});

                        await nodeManager.ensureNodeAvailable();

                        await new Promise(resolve =>
                            setTimeout(resolve, 700)
                        );

                        continue;
                    }

                    if (attempts >= maxAttempts) {

                        await nodeManager.refreshRiffy?.();

                        await nodeManager.ensureNodeAvailable();

                        player = client.riffy.createConnection({
                            guildId: interaction.guildId,
                            voiceChannel: userVoiceChannel,
                            textChannel: interaction.channelId,
                            deaf: true
                        });

                        break;
                    }

                    throw err;
                }
            }

            // ==========================================
            // TRACK PROCESSING
            // ==========================================

            let tracksToQueue = [];
            let isPlaylist = false;

            if (query.includes('spotify.com')) {

                try {

                    const spotifyData = await getData(query);

                    if (spotifyData.type === 'track') {

                        const trackName =
                            `${spotifyData.name} - ${spotifyData.artists.map(a => a.name).join(', ')}`;

                        tracksToQueue.push(trackName);

                    } else if (spotifyData.type === 'playlist') {

                        isPlaylist = true;

                        const playlistId =
                            query.split('/playlist/')[1].split('?')[0];

                        tracksToQueue =
                            await getSpotifyPlaylistTracks(playlistId);
                    }

                } catch (err) {

                    console.error(
                        'Error fetching Spotify data:',
                        err
                    );

                    return sendErrorResponse(
                        interaction,

                        t.spotifyError.title + '\n\n' +
                        t.spotifyError.message + '\n' +
                        t.spotifyError.note,

                        5000
                    );
                }

            } else {

                // ==========================================
                // NORMAL SONG SEARCH
                // ==========================================

                let resolve;

                try {

                    resolve = await client.riffy.resolve({
                        query,
                        requester: interaction.user.username
                    });

                } catch (err) {

                    const msg = err?.message || '';

                    if (
                        msg.includes('fetch failed') ||
                        msg.includes('No nodes are available') ||
                        (
                            err.cause &&
                            err.cause.code === 'ECONNREFUSED'
                        )
                    ) {

                        await nodeManager.reconnectNodesNow?.(5000)
                            .catch(() => {});

                        await nodeManager.ensureNodeAvailable();

                        resolve = await client.riffy.resolve({
                            query,
                            requester: interaction.user.username
                        });

                    } else {

                        throw err;
                    }
                }

                if (
                    !resolve ||
                    typeof resolve !== 'object' ||
                    !Array.isArray(resolve.tracks)
                ) {

                    return sendErrorResponse(
                        interaction,

                        t.invalidResponse.title + '\n\n' +
                        t.invalidResponse.message + '\n' +
                        t.invalidResponse.note,

                        5000
                    );
                }

                if (resolve.loadType === 'playlist') {

                    isPlaylist = true;

                    for (const track of resolve.tracks) {

                        track.info.requester =
                            interaction.user.username;

                        player.queue.add(track);

                        requesters.set(
                            track.info.uri,
                            interaction.user.username
                        );
                    }

                } else if (
                    resolve.loadType === 'search' ||
                    resolve.loadType === 'track'
                ) {

                    const track = resolve.tracks.shift();

                    if (!track) {

                        return sendErrorResponse(
                            interaction,

                            t.noResults.title + '\n\n' +
                            t.noResults.message + '\n' +
                            t.noResults.note,

                            5000
                        );
                    }

                    track.info.requester =
                        interaction.user.username;

                    player.queue.add(track);

                    requesters.set(
                        track.info.uri,
                        interaction.user.username
                    );

                } else {

                    return sendErrorResponse(
                        interaction,

                        t.noResults.title + '\n\n' +
                        t.noResults.message + '\n' +
                        t.noResults.note,

                        5000
                    );
                }
            }

            // ==========================================
            // ADD SPOTIFY TRACKS
            // ==========================================

            let queuedTracks = 0;

            const maxTracks = 200;

            for (
                let i = 0;
                i < Math.min(tracksToQueue.length, maxTracks);
                i++
            ) {

                const trackQuery = tracksToQueue[i];

                try {

                    const resolve = await client.riffy.resolve({
                        query: trackQuery,
                        requester: interaction.user.username
                    });

                    if (
                        resolve &&
                        resolve.tracks &&
                        resolve.tracks.length > 0
                    ) {

                        const trackInfo = resolve.tracks[0];

                        player.queue.add(trackInfo);

                        requesters.set(
                            trackInfo.info.uri,
                            interaction.user.username
                        );

                        queuedTracks++;
                    }

                } catch (error) {

                    console.error(
                        `Error resolving track ${trackQuery}:`,
                        error
                    );
                }
            }

            if (tracksToQueue.length > maxTracks) {

                console.warn(
                    `Playlist truncated: ${tracksToQueue.length} tracks requested, only ${maxTracks} queued`
                );
            }

            // ==========================================
            // WAIT FOR CONNECTION
            // ==========================================

            const connected =
                await waitForPlayerConnection(player);

            if (!connected) {

                throw new Error(
                    'Voice connection was not established. The bot did not join the voice channel.'
                );
            }

            if (!player.playing && !player.paused) {
                player.play();
            }

            // ==========================================
            // SUCCESS MESSAGE
            // ==========================================

            const successTitle = isPlaylist
                ? t.success.titlePlaylist
                : t.success.titleTrack;

            const titleIcon = isPlaylist
                ? (getEmoji('playlist') || '📚')
                : (getEmoji('music') || '🎵');

            const addedIcon = isPlaylist
                ? (getEmoji('playlist') || '📚')
                : (getEmoji('success') || '✅');

            const statusIcon = player.playing
                ? (getEmoji('play') || '▶️')
                : (getEmoji('pause') || '⏸️');

            const statusText = stripLeadingIcons(
                player.playing
                    ? t.success.nowPlaying
                    : t.success.queueReady
            );

            const successContainer = buildPaleCard(
                `${titleIcon} ${sanitizeTitle(successTitle, 'Play')}`,
                [
                    `### ${addedIcon} Added\n` +
                    (
                        isPlaylist
                            ? t.success.playlistAdded.replace(
                                '{count}',
                                queuedTracks
                            )
                            : t.success.trackAdded
                    ),

                    `### ${statusIcon} Status\n` +
                    statusText
                ]
            );

            const message = await interaction.editReply({
                components: [successContainer],
                flags: MessageFlags.IsComponentsV2,
                fetchReply: true
            });

            setTimeout(() => {
                message.delete().catch(() => {});
            }, 3000);

        } catch (error) {

            console.error('[PLAY COMMAND ERROR]', error);

            const lang = await getLang(interaction.guildId)
                .catch(() => ({
                    music: {
                        play: {
                            errors: {}
                        }
                    }
                }));

            const t = lang.music?.play?.errors || {};

            return handleCommandError(
                interaction,
                error,
                'play',
                (t.title || '## ❌ Error') +
                '\n\n' +
                (
                    t.message ||
                    'An error occurred while processing the request.\nPlease try again later.'
                )
            );
        }
    },

    requesters: requesters
};
