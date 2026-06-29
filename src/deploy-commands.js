const config = require('./config');
const { syncCommands } = require('./sync-commands');

async function main() {
  const scope = config.syncScope === 'global' ? 'global' : 'guild';
  const missing = [
    ['DISCORD_TOKEN', config.token],
    ['DISCORD_CLIENT_ID', config.clientId],
    ...(scope === 'guild' ? [['DISCORD_GUILD_ID', config.guildId]] : []),
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      [
        `Missing required env: ${missing.join(', ')}`,
        'Create a .env file from .env.example or set these variables in your host dashboard.',
        'For fast updates, keep SYNC_SCOPE=guild and set DISCORD_GUILD_ID to your server ID.',
      ].join('\n'),
    );
  }

  const result = await syncCommands({
    token: config.token,
    clientId: config.clientId,
    guildId: config.guildId,
    scope,
  });

  const target = result.scope === 'global' ? 'global commands' : `guild ${result.guildId}`;
  console.log(`Synced ${result.count} commands to ${target}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
