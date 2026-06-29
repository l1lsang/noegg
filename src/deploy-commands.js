const config = require('./config');
const { syncCommands } = require('./sync-commands');

async function main() {
  const scope = config.syncScope === 'global' ? 'global' : 'guild';
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
