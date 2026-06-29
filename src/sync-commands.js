const { REST, Routes } = require('discord.js');
const { buildCommandData } = require('./commands');

function resolveCommandScope({ configuredScope, guildId }) {
  if (configuredScope === 'guild') {
    return guildId ? 'guild' : 'global';
  }

  if (configuredScope === 'global') {
    return 'global';
  }

  return guildId ? 'guild' : 'global';
}

async function syncCommands({ token, clientId, guildId, scope = 'guild' }) {
  if (!token) {
    throw new Error('DISCORD_TOKEN is required.');
  }

  if (!clientId) {
    throw new Error('DISCORD_CLIENT_ID is required.');
  }

  const rest = new REST({ version: '10' }).setToken(token);
  const body = buildCommandData();

  if (scope === 'global') {
    await rest.put(Routes.applicationCommands(clientId), { body });
    return {
      scope: 'global',
      count: body.length,
    };
  }

  if (!guildId) {
    throw new Error('DISCORD_GUILD_ID is required for guild command sync.');
  }

  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
  return {
    scope: 'guild',
    guildId,
    count: body.length,
  };
}

module.exports = {
  resolveCommandScope,
  syncCommands,
};
