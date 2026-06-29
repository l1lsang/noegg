const fs = require('node:fs');
const path = require('node:path');
const { cert, getApp, getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore, initializeFirestore } = require('firebase-admin/firestore');

const DEFAULT_DATA = {
  version: 1,
  guilds: {},
};

function cloneDefaultData() {
  return structuredClone(DEFAULT_DATA);
}

function parseServiceAccount(rawJson, rawBase64) {
  const raw = rawJson || (rawBase64 ? Buffer.from(rawBase64, 'base64').toString('utf8') : null);
  if (!raw) {
    return null;
  }

  const serviceAccount = JSON.parse(raw);
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replaceAll('\\n', '\n');
  }

  return serviceAccount;
}

function getFirebaseApp(appOptions) {
  if (getApps().length > 0) {
    return getApp();
  }

  return initializeApp(appOptions);
}

class BaseStore {
  constructor(startingBalance) {
    this.startingBalance = startingBalance;
  }

  normalizeData(data) {
    const normalized = data && typeof data === 'object' ? data : cloneDefaultData();
    normalized.version = 1;
    normalized.guilds ||= {};
    return normalized;
  }

  ensureGuild(data, guildId) {
    data.guilds[guildId] ||= {
      users: {},
      bets: {},
      blackjackGames: {},
      nextBetNumber: 1,
      cooldowns: {
        fishing: {},
        begging: {},
      },
      dailyActions: {
        begging: {},
      },
    };

    const guild = data.guilds[guildId];
    guild.users ||= {};
    guild.bets ||= {};
    guild.blackjackGames ||= {};
    guild.nextBetNumber ||= 1;
    guild.cooldowns ||= {};
    guild.cooldowns.fishing ||= {};
    guild.cooldowns.begging ||= {};
    guild.dailyActions ||= {};
    guild.dailyActions.begging ||= {};
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
        gamblingWon: 0,
        gamblingLost: 0,
        gamblingPushed: 0,
        gamblingProfit: 0,
        blackjackWon: 0,
        blackjackLost: 0,
        blackjackPushed: 0,
        battlesWon: 0,
        battlesLost: 0,
        battleProfit: 0,
        itemsUsed: 0,
      },
      inventory: {},
      evolutions: {},
      power: {
        attack: 1,
        defense: 1,
        luck: 1,
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
    record.stats.gamblingWon ||= 0;
    record.stats.gamblingLost ||= 0;
    record.stats.gamblingPushed ||= 0;
    record.stats.gamblingProfit ||= 0;
    record.stats.blackjackWon ||= 0;
    record.stats.blackjackLost ||= 0;
    record.stats.blackjackPushed ||= 0;
    record.stats.battlesWon ||= 0;
    record.stats.battlesLost ||= 0;
    record.stats.battleProfit ||= 0;
    record.stats.itemsUsed ||= 0;
    record.inventory = record.inventory && typeof record.inventory === 'object' ? record.inventory : {};
    record.evolutions = record.evolutions && typeof record.evolutions === 'object' ? record.evolutions : {};
    record.power = record.power && typeof record.power === 'object' ? record.power : {};
    record.power.attack = Number.isFinite(record.power.attack) ? Math.max(1, Math.floor(record.power.attack)) : 1;
    record.power.defense = Number.isFinite(record.power.defense) ? Math.max(1, Math.floor(record.power.defense)) : 1;
    record.power.luck = Number.isFinite(record.power.luck) ? Math.max(1, Math.floor(record.power.luck)) : 1;

    if (typeof discordUser !== 'string') {
      record.username = discordUser.username;
      record.displayName = discordUser.globalName || discordUser.username;
    }

    record.updatedAt = new Date().toISOString();
    return record;
  }
}

class JsonStore extends BaseStore {
  constructor(filePath, startingBalance) {
    super(startingBalance);
    this.filePath = filePath;
    this.data = this.load();
  }

  load() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      return cloneDefaultData();
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return this.normalizeData(parsed);
    } catch (error) {
      const backupPath = `${this.filePath}.broken-${Date.now()}`;
      fs.renameSync(this.filePath, backupPath);
      console.warn(`Data file was invalid. Moved it to ${backupPath}`);
      return cloneDefaultData();
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempFile = `${this.filePath}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(this.data, null, 2));
    fs.renameSync(tempFile, this.filePath);
  }

  async run(mutator) {
    const result = mutator(this.data);
    this.save();
    return result;
  }
}

class FirestoreStore extends BaseStore {
  constructor(options) {
    super(options.startingBalance);
    this.collection = options.collection || 'nocoinBot';
    this.document = options.document || 'state';

    const serviceAccount = parseServiceAccount(
      options.serviceAccountJson,
      options.serviceAccountBase64,
    );
    const appOptions = {};

    if (serviceAccount) {
      appOptions.credential = cert(serviceAccount);
      appOptions.projectId = options.projectId || serviceAccount.project_id;
    } else if (options.projectId) {
      appOptions.projectId = options.projectId;
    }

    const app = getFirebaseApp(appOptions);
    try {
      this.db = initializeFirestore(app, { ignoreUndefinedProperties: true });
    } catch (error) {
      this.db = getFirestore(app);
    }
    this.docRef = this.db.collection(this.collection).doc(this.document);
  }

  async run(mutator) {
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(this.docRef);
      const data = this.normalizeData(snapshot.exists ? snapshot.data() : cloneDefaultData());
      const result = mutator(data);
      transaction.set(this.docRef, data);
      return result;
    });
  }
}

function createStore(config) {
  const backend = (config.storageBackend || 'firestore').toLowerCase();

  if (backend === 'json') {
    console.warn('Using JSON data store. Set STORAGE_BACKEND=firestore for Firestore persistence.');
    return new JsonStore(config.dataFile, config.startingBalance);
  }

  return new FirestoreStore({
    startingBalance: config.startingBalance,
    projectId: config.firestoreProjectId,
    collection: config.firestoreCollection,
    document: config.firestoreDocument,
    serviceAccountJson: config.firebaseServiceAccountJson,
    serviceAccountBase64: config.firebaseServiceAccountBase64,
  });
}

module.exports = {
  createStore,
  FirestoreStore,
  JsonStore,
};
