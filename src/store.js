const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DATA = {
  version: 1,
  guilds: {},
};

class JsonStore {
  constructor(filePath, startingBalance) {
    this.filePath = filePath;
    this.startingBalance = startingBalance;
    this.data = this.load();
  }

  load() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      return structuredClone(DEFAULT_DATA);
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return this.normalizeData(parsed);
    } catch (error) {
      const backupPath = `${this.filePath}.broken-${Date.now()}`;
      fs.renameSync(this.filePath, backupPath);
      console.warn(`Data file was invalid. Moved it to ${backupPath}`);
      return structuredClone(DEFAULT_DATA);
    }
  }

  normalizeData(data) {
    const normalized = data && typeof data === 'object' ? data : structuredClone(DEFAULT_DATA);
    normalized.version = 1;
    normalized.guilds ||= {};
    return normalized;
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempFile = `${this.filePath}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(this.data, null, 2));
    fs.renameSync(tempFile, this.filePath);
  }

  run(mutator) {
    const result = mutator(this.data);
    this.save();
    return result;
  }

  ensureGuild(data, guildId) {
    data.guilds[guildId] ||= {
      users: {},
      bets: {},
      nextBetNumber: 1,
      cooldowns: {
        fishing: {},
        begging: {},
      },
    };

    const guild = data.guilds[guildId];
    guild.users ||= {};
    guild.bets ||= {};
    guild.nextBetNumber ||= 1;
    guild.cooldowns ||= {};
    guild.cooldowns.fishing ||= {};
    guild.cooldowns.begging ||= {};
    return guild;
  }

  ensureUser(guild, discordUser) {
    const userId = typeof discordUser === 'string' ? discordUser : discordUser.id;
    guild.users[userId] ||= {
      balance: this.startingBalance,
      stats: {
        fishing: 0,
        begging: 0,
        betsWon: 0,
        betsLost: 0,
      },
      createdAt: new Date().toISOString(),
    };

    const record = guild.users[userId];
    record.balance = Number.isFinite(record.balance) ? Math.max(0, Math.floor(record.balance)) : 0;
    record.stats ||= {};
    record.stats.fishing ||= 0;
    record.stats.begging ||= 0;
    record.stats.betsWon ||= 0;
    record.stats.betsLost ||= 0;

    if (typeof discordUser !== 'string') {
      record.username = discordUser.username;
      record.displayName = discordUser.globalName || discordUser.username;
    }

    record.updatedAt = new Date().toISOString();
    return record;
  }
}

module.exports = {
  JsonStore,
};
