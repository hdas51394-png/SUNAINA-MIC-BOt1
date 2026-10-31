
// Handle autocomplete
if (interaction.isAutocomplete()) {
    if (interaction.commandName !== 'play') return;

    let responded = false;

    const safeRespond = async (choices = []) => {
        if (responded) return;
        responded = true;

        try {
            if (interaction.responded) return;
            await interaction.respond(choices.slice(0, 25));
        } catch (error) {
            console.error('[PLAY AUTOCOMPLETE] Response error:', error.message);
        }
    };

    try {
        const focusedOption = interaction.options.getFocused(true);

        if (focusedOption.name !== 'name') {
            return safeRespond([]);
        }

        const query = focusedOption.value?.trim();

        if (!query || query.length < 2) {
            return safeRespond([]);
        }

        // Give Discord a response before its 3-second timeout
        const searchPromise = (async () => {
            const nodeManager = getLavalinkManager();

            if (!nodeManager) return [];

            await nodeManager.ensureNodeAvailable();

            const resolve = await client.riffy.resolve({
                query,
                requester: interaction.user.username
            });

            if (!resolve || !Array.isArray(resolve.tracks)) {
                return [];
            }

            return resolve.tracks.slice(0, 25).map(track => {
                const info = track.info || {};

                const duration = formatDuration(info.length || 0);

                const title = `${info.title || 'Unknown'} - ${info.author || 'Unknown'} (${duration})`;

                // Discord choice name/value limit is 100 characters
                return {
                    name: title.substring(0, 100),
                    value: (info.uri && info.uri.length <= 100)
                        ? info.uri
                        : query.substring(0, 100)
                };
            });
        })();

        const timeoutPromise = new Promise(resolve => {
            setTimeout(() => resolve([]), 1800);
        });

        const choices = await Promise.race([
            searchPromise,
            timeoutPromise
        ]);

        await safeRespond(choices);

    } catch (error) {
        console.error('[PLAY AUTOCOMPLETE ERROR]', error);
        await safeRespond([]);
    }

    return;
}
