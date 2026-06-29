const { REST, Routes } = require('discord.js');
const { buildCommandData } = require('./commands');

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
  syncCommands,
};
