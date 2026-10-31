
const { Events } = require('discord.js');
const { getLavalinkManager } = require('../../lavalink.js');

function formatDuration(ms) {
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / 60000) % 60);
    const hours = Math.floor(ms / 3600000);

    return [
        hours ? `${hours}h` : null,
        minutes ? `${minutes}m` : null,
        `${seconds}s`
    ].filter(Boolean).join(' ');
}

module.exports = {
    name: Events.InteractionCreate,

    async execute(interaction, client) {

        if (!interaction.isAutocomplete()) return;

        if (interaction.commandName !== 'play') {
            return interaction.respond([]).catch(() => {});
        }

        let responded = false;

        const safeRespond = async (choices = []) => {
            if (responded || interaction.responded) return;

            responded = true;

            try {
                await interaction.respond(
                    Array.isArray(choices) ? choices.slice(0, 25) : []
                );
            } catch (error) {
                console.error('[AUTOCOMPLETE RESPONSE]', error);
            }
        };

        let timeout;

        try {
            const focused = interaction.options.getFocused(true);

            if (focused.name !== 'name') {
                return await safeRespond([]);
            }

            const query = String(focused.value || '').trim();

            if (query.length < 2) {
                return await safeRespond([]);
            }

            const searchPromise = (async () => {
                const manager = getLavalinkManager();

                if (!manager || !client.riffy) return [];

                await manager.ensureNodeAvailable();

                const result = await client.riffy.resolve({
                    query,
                    requester: interaction.user.username
                });

                if (!result || !Array.isArray(result.tracks)) {
                    return [];
                }

                return result.tracks.slice(0, 25).map(track => {
                    const info = track.info || {};

                    const title =
                        `${info.title || 'Unknown'} - ${info.author || 'Unknown'} (${formatDuration(info.length || 0)})`;

                    return {
                        name: title.length > 100
                            ? title.substring(0, 97) + '...'
                            : title,

                        value:
                            typeof info.uri === 'string' &&
                            info.uri.length > 0 &&
                            info.uri.length <= 100
                                ? info.uri
                                : query.substring(0, 100)
                    };
                });
            })();

            const timeoutPromise = new Promise(resolve => {
                timeout = setTimeout(() => resolve([]), 1800);
            });

            const choices = await Promise.race([
                searchPromise,
                timeoutPromise
            ]);

            clearTimeout(timeout);

            await safeRespond(choices);

        } catch (error) {
            clearTimeout(timeout);

            console.error('[PLAY AUTOCOMPLETE ERROR]', error);

            await safeRespond([]);
        }
    }
};
