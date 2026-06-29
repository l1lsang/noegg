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
  syncScope: (process.env.SYNC_SCOPE || '').toLowerCase(),
  startingBalance: toPositiveInt(process.env.STARTING_BALANCE, 1000),
  fishingCooldownMs: toPositiveInt(process.env.FISHING_COOLDOWN_SECONDS, 300) * 1000,
  storageBackend: (process.env.STORAGE_BACKEND || 'firestore').toLowerCase(),
  firestoreProjectId: process.env.FIRESTORE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT,
  firestoreCollection: process.env.FIRESTORE_COLLECTION || 'nocoinBot',
  firestoreDocument: process.env.FIRESTORE_DOCUMENT || 'state',
  firebaseServiceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
  firebaseServiceAccountBase64: process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
  dataFile,
  port: process.env.PORT,
};
