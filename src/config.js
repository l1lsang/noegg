const path = require('node:path');

require('dotenv').config();

function toBoolean(value, fallback = false) {
  if (value == null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function splitIds(value) {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

const dataFile =
  process.env.DATA_FILE ||
  path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'db.json');

module.exports = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  guildId: process.env.DISCORD_GUILD_ID,
  ownerIds: splitIds(process.env.BOT_OWNER_IDS),
  autoSyncCommands: toBoolean(process.env.AUTO_SYNC_COMMANDS, false),
  syncScope: (process.env.SYNC_SCOPE || 'guild').toLowerCase(),
  startingBalance: toPositiveInt(process.env.STARTING_BALANCE, 1000),
  fishingCooldownMs: toPositiveInt(process.env.FISHING_COOLDOWN_SECONDS, 300) * 1000,
  beggingCooldownMs: toPositiveInt(process.env.BEGGING_COOLDOWN_SECONDS, 600) * 1000,
  dataFile,
  port: process.env.PORT,
};
