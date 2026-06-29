const config = require('./config');
const { resolveCommandScope, syncCommands } = require('./sync-commands');

async function main() {
  const scope = resolveCommandScope({
    configuredScope: config.syncScope,
    guildId: config.guildId,
  });
  const missing = [
    ['DISCORD_TOKEN', config.token],
    ['DISCORD_CLIENT_ID', config.clientId],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      [
        `Missing required env: ${missing.join(', ')}`,
        'Create a .env file from .env.example or set these variables in your host dashboard.',
        'DISCORD_GUILD_ID is optional. Without it, commands are registered globally and can take longer to appear.',
      ].join('\n'),
    );
  }

  if (scope === 'global' && !config.guildId) {
    console.warn('DISCORD_GUILD_ID is not set. Registering global commands; Discord may take a while to show them.');
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
