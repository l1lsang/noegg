const http = require('node:http');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { Resvg } = require('@resvg/resvg-js');
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const config = require('./config');
const { createStore } = require('./store');
const { resolveCommandScope, syncCommands } = require('./sync-commands');
const {
  fetchPolymarketMarket,
  fetchPolymarketPriceCharts,
  formatPolymarketPrice,
  searchPolymarketMarkets,
} = require('./polymarket');
const {
  begReward,
  findOption,
  fishReward,
  formatCoins,
  formatRemaining,
  getItemEnhancementCost,
  getItemEnhancementRates,
  getItemEvolution,
  getItemGradeConfig,
  getItemUseChance,
  getFishingFailureChance,
  getFishingProtectionTicketChance,
  listFishingItems,
  listItemGradeDropRates,
  nextBetId,
  normalizeKey,
  optionPools,
  parseOptions,
  randomInt,
  rollItemEnhancement,
  rollItemUse,
  totalBetPool,
} = require('./game');

const store = createStore(config);
const ownerIds = new Set(config.ownerIds);
const economyMultiplier = Math.max(1, Math.floor(config.economyMultiplier || 1));
const quickBetAmounts = [100, 500, 1000].map((amount) => amount * economyMultiplier);
const koreaTimeZone = 'Asia/Seoul';
const assetRoot = path.join(__dirname, '..', 'assets');
const fontRoot = path.join(assetRoot, 'fonts');
const dashboardFontFiles = [
  path.join(fontRoot, 'NotoSansCJKkr-Regular.otf'),
  path.join(fontRoot, 'NotoSansCJKkr-Bold.otf'),
].filter((fontPath) => fs.existsSync(fontPath));
const casinoWinChances = {
  coinFlip: 0.48,
  dice: 0.15,
  waterGun: 0.3,
};
const waterGunContestants = [
  {
    key: 'choya',
    label: '초야',
    motion: '낮게 깔린 정액줄기로 안정적인 직선을 만들었습니다.',
  },
  {
    key: 'senyang',
    label: '세냥',
    motion: '순간적으로 힘을 몰아넣어 정액을 길게 뽑았습니다.',
  },
  {
    key: 'namraeng',
    label: '남랭',
    motion: '각도를 높게 잡고 끝까지 압력을 버텼습니다.',
  },
];
const blackjackSuits = ['♠', '♥', '♦', '♣'];
const blackjackRanks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const battleChallenges = new Map();
const battleChallengeTtlMs = 5 * 60 * 1000;
const battleSessions = new Map();
const battleSessionTtlMs = 20 * 60 * 1000;
const battleMaxTurns = 12;
const pendingItemEnhancements = new Map();
const itemEnhancementTtlMs = 5 * 60 * 1000;
const itemSynthesisRequirement = 4;
const itemSynthesisGradeSteps = [
  { source: 'common', target: 'uncommon' },
  { source: 'uncommon', target: 'rare' },
  { source: 'rare', target: 'epic' },
  { source: 'epic', target: 'legendary' },
  { source: 'legendary', target: 'mythic' },
];
const shopGradePriceMultipliers = {
  common: 12,
  uncommon: 18,
  rare: 28,
  epic: 45,
  legendary: 75,
  mythic: 120,
};
const weaponGradeBattleProfiles = {
  common: { base: { attack: 14, defense: 12, luck: 5 }, biasScale: 4, levelScale: 1, enhanceScale: 3 },
  uncommon: { base: { attack: 28, defense: 22, luck: 10 }, biasScale: 7, levelScale: 2, enhanceScale: 6 },
  rare: { base: { attack: 52, defense: 40, luck: 18 }, biasScale: 12, levelScale: 4, enhanceScale: 11 },
  epic: { base: { attack: 90, defense: 70, luck: 32 }, biasScale: 20, levelScale: 7, enhanceScale: 20 },
  legendary: { base: { attack: 145, defense: 110, luck: 50 }, biasScale: 32, levelScale: 11, enhanceScale: 34 },
  mythic: { base: { attack: 230, defense: 170, luck: 80 }, biasScale: 50, levelScale: 18, enhanceScale: 55 },
};

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

function startHealthServer() {
  if (!config.port) {
    return;
  }

  const server = http.createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, bot: client.user?.tag || null }));
      return;
    }

    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Nocoin Discord bot is running.');
  });

  server.listen(Number(config.port), () => {
    console.log(`Health server listening on port ${config.port}`);
  });
}

async function requireGuild(interaction) {
  if (interaction.guildId) {
    return true;
  }

  await interaction.reply({
    content: '이 명령어는 Discord 서버 안에서만 사용할 수 있습니다.',
    flags: MessageFlags.Ephemeral,
  });
  return false;
}

function isBotManager(interaction) {
  if (ownerIds.has(interaction.user.id)) {
    return true;
  }

  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

function canCloseBet(interaction, bet) {
  if (ownerIds.has(interaction.user.id)) {
    return true;
  }

  if (bet.createdBy === interaction.user.id) {
    return true;
  }

  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}

async function reply(interaction, payload) {
  const normalized = typeof payload === 'string' ? { content: payload } : payload;

  await sendInteractionResponse(interaction, normalized);
}

function isDiscordErrorCode(error, code) {
  return error?.code === code || error?.rawError?.code === code;
}

function isAlreadyAcknowledgedError(error) {
  return isDiscordErrorCode(error, 40060)
    || /already been acknowledged/i.test(String(error?.message || ''));
}

function isExpiredInteractionError(error) {
  return isDiscordErrorCode(error, 10062)
    || /unknown interaction/i.test(String(error?.message || ''));
}

function isInteractionNotRepliedError(error) {
  return error?.code === 'InteractionNotReplied'
    || /reply to this interaction has not been sent or deferred/i.test(String(error?.message || ''));
}

async function sendInteractionFollowUp(interaction, payload) {
  const normalized = typeof payload === 'string' ? { content: payload } : payload;

  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(normalized);
      return;
    }

    if (interaction.webhook) {
      await interaction.webhook.send(normalized);
      return;
    }

    await interaction.followUp(normalized);
  } catch (error) {
    if (isInteractionNotRepliedError(error) && interaction.webhook) {
      await interaction.webhook.send(normalized);
      return;
    }

    throw error;
  }
}

async function sendInteractionResponse(interaction, payload) {
  const normalized = typeof payload === 'string' ? { content: payload } : payload;

  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(normalized);
      return;
    }

    await interaction.reply(normalized);
  } catch (error) {
    if (!isAlreadyAcknowledgedError(error) && !isInteractionNotRepliedError(error)) {
      throw error;
    }

    await sendInteractionFollowUp(interaction, normalized);
  }
}

async function safeErrorReply(interaction, message) {
  const payload = {
    content: message,
    flags: MessageFlags.Ephemeral,
  };

  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: message, embeds: [], components: [] });
      return;
    }

    await interaction.reply(payload);
  } catch (error) {
    if (isAlreadyAcknowledgedError(error) || isInteractionNotRepliedError(error)) {
      try {
        await sendInteractionFollowUp(interaction, payload);
      } catch (followUpError) {
        if (!isExpiredInteractionError(followUpError) && !isInteractionNotRepliedError(followUpError)) {
          console.warn(`Failed to send interaction error follow-up: ${followUpError.message}`);
        }
      }
      return;
    }

    if (!isExpiredInteractionError(error)) {
      console.warn(`Failed to send interaction error response: ${error.message}`);
    }
  }
}

function getKoreaDateParts(dateInput = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: koreaTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(dateInput));

  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

function getKoreaDayKey(dateInput = new Date()) {
  const parts = getKoreaDateParts(dateInput);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getNextKoreaMidnightMs(now = Date.now()) {
  const parts = getKoreaDateParts(now);
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + 1, -9, 0, 0, 0);
}

function truncateText(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) {
    return text;
  }

  return maxLength <= 3 ? text.slice(0, maxLength) : `${text.slice(0, maxLength - 3)}...`;
}

function formatPercent(value, total) {
  if (total <= 0) {
    return '0%';
  }

  return `${Math.round((value / total) * 100)}%`;
}

function progressBar(value, total, size = 12) {
  if (total <= 0 || value <= 0) {
    return '░'.repeat(size);
  }

  const filled = Math.min(size, Math.max(1, Math.round((value / total) * size)));
  return `${'█'.repeat(filled)}${'░'.repeat(size - filled)}`;
}

const uiTheme = {
  footer: '노코인 게임봇',
  colors: {
    primary: 0x5865f2,
    success: 0x57f287,
    danger: 0xed4245,
    warning: 0xfee75c,
    muted: 0x95a5a6,
    economy: 0xf1c40f,
    inventory: 0x3498db,
    battle: 0xed4245,
    market: 0x27ae60,
  },
};

function createUiEmbed({ title, description, color = uiTheme.colors.primary } = {}) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setFooter({ text: uiTheme.footer })
    .setTimestamp();

  if (title) {
    embed.setTitle(title);
  }

  if (description) {
    embed.setDescription(description);
  }

  return embed;
}

function normalizeGradeConfig(grade) {
  return getItemGradeConfig(typeof grade === 'string' ? grade : grade?.key);
}

function formatItemGradeLabel(grade) {
  const config = normalizeGradeConfig(grade);
  return `${config.swatch || '⬜'} [${config.label}]`;
}

function getItemGradeColor(grade, fallback = uiTheme.colors.inventory) {
  const config = normalizeGradeConfig(grade);
  return config.color || fallback;
}

function getShopItemPrice(item) {
  const grade = normalizeGradeConfig(item.grade);
  const multiplier = shopGradePriceMultipliers[grade.key] || 20;
  return Math.max(grade.baseCost * 2, Math.ceil(item.averageAmount * multiplier));
}

function getShopItems() {
  const protectionTicketGrade = getItemGradeConfig('legendary');
  const protectionTicket = {
    name: '강화 방지권',
    aliases: ['방지권'],
    type: 'protection_ticket',
    protectionTicket: true,
    grade: protectionTicketGrade,
    price: protectionTicketGrade.baseCost * 2,
  };

  return listFishingItems(economyMultiplier)
    .map((item) => ({
      ...item,
      price: getShopItemPrice(item),
    }))
    .concat(protectionTicket);
}

function findShopItem(rawName) {
  const wanted = normalizeKey(rawName);
  return getShopItems().find((item) =>
    normalizeKey(item.name) === wanted
    || normalizeKey(item.evolution?.evolution) === wanted
    || (item.aliases || []).some((alias) => normalizeKey(alias) === wanted)
  );
}

function getItemRepairCost(evolution) {
  const grade = normalizeGradeConfig(evolution.grade || evolution.definition?.grade);
  const maxDurability = Math.max(1, Math.floor(evolution.maxDurability || grade.maxDurability));
  const durability = Math.max(0, Math.min(maxDurability, Math.floor(evolution.durability || 0)));
  const missing = maxDurability - durability;

  if (missing <= 0) {
    return 0;
  }

  const enhanceLevel = Math.max(0, Math.floor(evolution.enhanceLevel || 0));
  const fullRepairCost = Math.ceil(grade.baseCost * (0.75 + enhanceLevel * 0.18));
  return Math.max(1, Math.ceil((fullRepairCost * missing) / maxDurability));
}

function formatStatLine(power) {
  return `공격 ${power.attack} / 방어 ${power.defense} / 행운 ${power.luck}`;
}

function formatDurabilityLine(current, max, size = 10) {
  const safeCurrent = Math.max(0, Math.floor(current || 0));
  const safeMax = Math.max(1, Math.floor(max || 1));
  const label = safeCurrent <= 0 ? '파손' : safeCurrent <= Math.ceil(safeMax * 0.25) ? '위험' : '정상';
  return `${progressBar(safeCurrent, safeMax, size)} ${safeCurrent}/${safeMax} (${label})`;
}

function formatCommandList(commands) {
  return commands.map(([name, text]) => `\`${name}\` ${text}`).join('\n');
}

function getKoreaDateKey(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: koreaTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function getPreviousDateKey(dateKey) {
  const [year, month, day] = String(dateKey || '').split('-').map((part) => Number.parseInt(part, 10));
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - 1);
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function getAttendanceReward(streak) {
  const streakBonus = Math.min(30, Math.max(1, Math.floor(streak))) * 150;
  return Math.floor((1000 + streakBonus) * economyMultiplier);
}

const lotteryTiers = [
  { threshold: 0.0075, label: '대박', multiplier: 20, color: uiTheme.colors.success },
  { threshold: 0.0475, label: '큰 당첨', multiplier: 5, color: uiTheme.colors.success },
  { threshold: 0.1975, label: '당첨', multiplier: 2, color: uiTheme.colors.economy },
  { threshold: 0.3975, label: '본전', multiplier: 1, color: uiTheme.colors.warning },
];

const placementExamIconBaseUrl = 'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-shared-components/global/default/images';
const placementExamTiers = [
  { key: 'challenger', name: '챌린저', multiplier: 100, chancePercent: 0.02, color: 0xcfefff, accent: 0xf2d16b, iconUrl: `${placementExamIconBaseUrl}/challenger.png` },
  { key: 'grandmaster', name: '그랜드마스터', multiplier: 50, chancePercent: 0.04, color: 0xd04d4d, accent: 0xf0b878, iconUrl: `${placementExamIconBaseUrl}/grandmaster.png` },
  { key: 'master', name: '마스터', multiplier: 20, chancePercent: 0.34, color: 0x9a59ff, accent: 0xf0dcff, iconUrl: `${placementExamIconBaseUrl}/master.png` },
  { key: 'diamond', name: '다이아몬드', multiplier: 5, chancePercent: 2.6, color: 0x5c8cff, accent: 0xb5d7ff, iconUrl: `${placementExamIconBaseUrl}/diamond.png` },
  { key: 'emerald', name: '에메랄드', multiplier: 3, chancePercent: 5, color: 0x39b474, accent: 0xa6f0c5, iconUrl: `${placementExamIconBaseUrl}/emerald.png` },
  { key: 'platinum', name: '플래티넘', multiplier: 2, chancePercent: 9.5, color: 0x7bd0c0, accent: 0xd7fff5, iconUrl: `${placementExamIconBaseUrl}/platinum.png` },
  { key: 'gold', name: '골드', multiplier: 1, chancePercent: 28, color: 0xd6a64d, accent: 0xffe6a3, iconUrl: `${placementExamIconBaseUrl}/gold.png` },
  { key: 'silver', name: '실버', multiplier: -1, chancePercent: 30, color: 0x9aa7c7, accent: 0xe1e7f4, iconUrl: `${placementExamIconBaseUrl}/silver.png` },
  { key: 'bronze', name: '브론즈', multiplier: -2, chancePercent: 20, color: 0xb06f55, accent: 0xf0b18f, iconUrl: `${placementExamIconBaseUrl}/bronze.png` },
  { key: 'iron', name: '아이언', multiplier: -5, chancePercent: 4.5, color: 0x6b5c60, accent: 0xbda7aa, iconUrl: `${placementExamIconBaseUrl}/iron.png` },
];
const placementExamMaxLossMultiplier = Math.max(
  ...placementExamTiers.map((tier) => Math.max(0, -tier.multiplier)),
);
const placementExamWarning = '주의: 베팅을 건 금액보다 더 큰 금액을 잃을 수 있습니다.';

function getLotteryTierChance(tier, index) {
  const previousThreshold = index > 0 ? lotteryTiers[index - 1].threshold : 0;
  return tier.threshold - previousThreshold;
}

function formatLotteryOdds() {
  const tierLines = lotteryTiers
    .map((tier, index) => `${tier.label} ${formatChance(getLotteryTierChance(tier, index))} (${tier.multiplier}배)`);
  const missChance = 1 - lotteryTiers[lotteryTiers.length - 1].threshold;
  return [...tierLines, `꽝 ${formatChance(missChance)} (0배)`].join('\n');
}

function formatPlacementExamChance(tier) {
  return `${tier.chancePercent}%`;
}

function formatPlacementExamMultiplier(tier) {
  const sign = tier.multiplier > 0 ? '+' : '-';
  return `${sign} 베팅액 x ${Math.abs(tier.multiplier)}배`;
}

function formatPlacementExamProfit(profit) {
  if (profit > 0) {
    return `+ ${formatCoins(profit)}`;
  }

  if (profit < 0) {
    return `- ${formatCoins(Math.abs(profit))}`;
  }

  return formatCoins(0);
}

function escapeSvgText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function colorToHex(color) {
  return `#${Math.max(0, Math.min(0xffffff, color)).toString(16).padStart(6, '0')}`;
}

function createPlacementTierBadgeSvg(tier, x, y, size = 54) {
  const centerX = x + size / 2;
  const centerY = y + size / 2;
  const primary = colorToHex(tier.color);
  const accent = colorToHex(tier.accent);
  const dark = '#111827';

  return [
    `<circle cx="${centerX}" cy="${centerY}" r="${size * 0.47}" fill="${dark}" stroke="${primary}" stroke-width="3"/>`,
    `<path d="M ${centerX} ${y + 4} L ${x + size - 9} ${centerY} L ${centerX} ${y + size - 4} L ${x + 9} ${centerY} Z" fill="${primary}" opacity="0.95"/>`,
    `<path d="M ${centerX} ${y + 14} L ${x + size - 22} ${centerY} L ${centerX} ${y + size - 15} L ${x + 22} ${centerY} Z" fill="${dark}"/>`,
    `<path d="M ${centerX} ${y + 21} L ${x + size - 30} ${centerY} L ${centerX} ${y + size - 23} L ${x + 30} ${centerY} Z" fill="${accent}"/>`,
    `<circle cx="${centerX}" cy="${centerY}" r="${tier.multiplier < 0 ? 4 : 6}" fill="#f8fafc"/>`,
  ].join('');
}

function createPlacementExamOddsSvg() {
  const width = 1180;
  const headerHeight = 168;
  const warningHeight = 92;
  const rowHeight = 88;
  const tableTop = headerHeight + 34;
  const tableLeft = 54;
  const tableWidth = width - tableLeft * 2;
  const height = tableTop + 66 + placementExamTiers.length * rowHeight + warningHeight;
  const columns = {
    tier: tableLeft,
    name: tableLeft + 156,
    reward: tableLeft + 446,
    chance: tableLeft + 800,
  };
  const totalExpectedValue = placementExamTiers.reduce(
    (sum, tier) => sum + (tier.multiplier * tier.chancePercent) / 100,
    0,
  );

  const rows = placementExamTiers.map((tier, index) => {
    const y = tableTop + 66 + index * rowHeight;
    const rowFill = index % 2 === 0 ? '#101827' : '#172033';
    const rewardTone = tier.multiplier > 0 ? '#8ef7b6' : '#ff9d8b';
    const riskText = tier.multiplier > 0 ? '획득' : '손실';

    return `
      <rect x="${tableLeft}" y="${y}" width="${tableWidth}" height="${rowHeight}" fill="${rowFill}" stroke="#2b3547"/>
      ${createPlacementTierBadgeSvg(tier, columns.tier + 48, y + 17, 54)}
      <text x="${columns.name}" y="${y + 54}" class="tier-name">${escapeSvgText(tier.name)}</text>
      <text x="${columns.reward}" y="${y + 54}" class="reward" fill="${rewardTone}">${escapeSvgText(formatPlacementExamMultiplier(tier))}</text>
      <text x="${columns.chance}" y="${y + 54}" class="chance">${escapeSvgText(formatPlacementExamChance(tier))}</text>
      <text x="${tableLeft + tableWidth - 64}" y="${y + 54}" class="risk" fill="${rewardTone}" text-anchor="end">${riskText}</text>
    `;
  }).join('');

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <linearGradient id="page" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#08111f"/>
          <stop offset="55%" stop-color="#101827"/>
          <stop offset="100%" stop-color="#1d2335"/>
        </linearGradient>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#000000" flood-opacity="0.36"/>
        </filter>
      </defs>
      <style>
        text { font-family: "Noto Sans CJK KR", "Noto Sans KR", sans-serif; }
        .eyebrow { font-size: 26px; fill: #7dd3fc; font-weight: 700; letter-spacing: 2px; }
        .title { font-size: 56px; fill: #f8fafc; font-weight: 900; }
        .subtitle { font-size: 24px; fill: #cbd5e1; font-weight: 500; }
        .header { font-size: 26px; fill: #93a4bd; font-weight: 800; }
        .tier-name { font-size: 34px; fill: #f8fafc; font-weight: 800; }
        .reward { font-size: 31px; font-weight: 800; }
        .chance { font-size: 34px; fill: #e5e7eb; font-weight: 900; }
        .risk { font-size: 24px; font-weight: 800; }
        .warning { font-size: 28px; fill: #fff7ed; font-weight: 900; }
        .small { font-size: 20px; fill: #94a3b8; font-weight: 500; }
      </style>
      <rect width="${width}" height="${height}" fill="url(#page)"/>
      <circle cx="1000" cy="120" r="220" fill="#2563eb" opacity="0.12"/>
      <circle cx="120" cy="760" r="260" fill="#f59e0b" opacity="0.08"/>

      <text x="54" y="64" class="eyebrow">NOCOIN PLACEMENT</text>
      <text x="54" y="126" class="title">롤 배치고사 확률표</text>
      <text x="54" y="162" class="subtitle">보상은 순손익 기준입니다. 손실 티어는 잔액이 마이너스가 될 수 있습니다.</text>

      <rect x="${tableLeft}" y="${tableTop}" width="${tableWidth}" height="${66 + placementExamTiers.length * rowHeight}" rx="22" fill="#0f172a" filter="url(#shadow)" stroke="#2b3547"/>
      <rect x="${tableLeft}" y="${tableTop}" width="${tableWidth}" height="66" rx="22" fill="#172033"/>
      <rect x="${tableLeft}" y="${tableTop + 38}" width="${tableWidth}" height="28" fill="#172033"/>
      <text x="${columns.tier + 42}" y="${tableTop + 43}" class="header">종류</text>
      <text x="${columns.name}" y="${tableTop + 43}" class="header">이름</text>
      <text x="${columns.reward}" y="${tableTop + 43}" class="header">보상</text>
      <text x="${columns.chance}" y="${tableTop + 43}" class="header">확률</text>
      ${rows}

      <rect x="54" y="${height - warningHeight - 34}" width="${tableWidth}" height="${warningHeight}" rx="22" fill="#7f1d1d" opacity="0.96" stroke="#fb923c"/>
      <text x="88" y="${height - warningHeight + 22}" class="warning">${escapeSvgText(placementExamWarning)}</text>
      <text x="88" y="${height - warningHeight + 56}" class="small">최대 손실: 베팅액 x ${placementExamMaxLossMultiplier}배 · 기대값: ${(totalExpectedValue * 100).toFixed(1)}%</text>
    </svg>
  `;
}

function createPlacementExamOddsPngFile() {
  const svg = createPlacementExamOddsSvg();
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'original' },
    font: {
      fontFiles: dashboardFontFiles,
      loadSystemFonts: dashboardFontFiles.length === 0,
      defaultFontFamily: 'Noto Sans CJK KR',
    },
  });
  const png = resvg.render().asPng();
  const fileName = 'placement-odds.png';

  return {
    fileName,
    attachment: new AttachmentBuilder(png, { name: fileName }),
  };
}

function drawLottery(wager) {
  const roll = Math.random();
  const tier = lotteryTiers.find((entry) => roll < entry.threshold) || {
    label: '꽝',
    multiplier: 0,
    color: uiTheme.colors.danger,
  };
  const payout = Math.floor(wager * tier.multiplier);

  return {
    ...tier,
    payout,
    profit: payout - wager,
  };
}

function drawPlacementExam() {
  const roll = Math.random() * 100;
  let cumulative = 0;

  for (const tier of placementExamTiers) {
    cumulative += tier.chancePercent;
    if (roll < cumulative) {
      return tier;
    }
  }

  return placementExamTiers[placementExamTiers.length - 1];
}

function rollCasinoWin(chance) {
  return Math.random() < chance;
}

function pickDifferentValue(values, excludedValue) {
  const candidates = values.filter((value) => value !== excludedValue);
  return candidates[randomInt(0, candidates.length - 1)];
}

function getRankingMetric(user, metric) {
  if (metric === 'power') {
    const bestWeapon = getBestBattleWeapon(user);
    return bestWeapon ? Math.floor(getPowerScore(bestWeapon.power)) : Math.floor(getPowerScore(getUserPower(user)));
  }

  if (metric === 'enhance') {
    return getUserEvolutions(user).reduce((sum, evolution) => sum + evolution.enhanceLevel, 0);
  }

  if (metric === 'fishing') {
    return user.stats?.fishing || 0;
  }

  return user.balance || 0;
}

function getRankingLabel(metric) {
  return {
    balance: '잔액',
    power: '전투력',
    enhance: '강화',
    fishing: '낚시',
  }[metric] || '잔액';
}

function formatRankingValue(metric, value) {
  if (metric === 'balance') {
    return formatCoins(value);
  }

  if (metric === 'enhance') {
    return `총 +${value}`;
  }

  if (metric === 'fishing') {
    return `${value}회`;
  }

  return `${value}점`;
}

function getWaterGunContestant(key) {
  return waterGunContestants.find((contestant) => contestant.key === key) || null;
}

function formatWaterGunDistance(cm) {
  return `${(cm / 100).toFixed(2)}m`;
}

function buildWaterGunContestWithWinner(winnerKey) {
  const winnerDistance = randomInt(1450, 1850);
  const shots = waterGunContestants
    .map((contestant, index) => {
      const distance = contestant.key === winnerKey
        ? winnerDistance
        : randomInt(650, Math.max(651, winnerDistance - 1));
      return {
        ...contestant,
        order: index + 1,
        distance,
      };
    });
  const results = shots.slice().sort((a, b) => b.distance - a.distance);

  return {
    shots,
    results,
    winner: results[0],
  };
}

function simulateWaterGunContest(selectedKey = null) {
  if (selectedKey) {
    const selectedWins = rollCasinoWin(casinoWinChances.waterGun);
    const winnerKey = selectedWins
      ? selectedKey
      : pickDifferentValue(waterGunContestants.map((contestant) => contestant.key), selectedKey);
    return buildWaterGunContestWithWinner(winnerKey);
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const shots = waterGunContestants
      .map((contestant, index) => ({
        ...contestant,
        order: index + 1,
        distance: randomInt(650, 1850),
      }));
    const results = shots.slice().sort((a, b) => b.distance - a.distance);
    const winners = results.filter((result) => result.distance === results[0].distance);

    if (winners.length === 1) {
      return {
        shots,
        results,
        winner: results[0],
      };
    }
  }

  const shots = waterGunContestants
    .map((contestant, index) => ({
      ...contestant,
      order: index + 1,
      distance: randomInt(650, 1850) + randomInt(0, 99) / 100,
    }));
  const results = shots.slice().sort((a, b) => b.distance - a.distance);

  return {
    shots,
    results,
    winner: results[0],
  };
}

function getDisplayName(target, user = {}) {
  return target.globalName || target.username || user.displayName || user.username || target.id;
}

function sampleValues(values, maxPoints) {
  if (values.length <= maxPoints) {
    return values;
  }

  return Array.from({ length: maxPoints }, (_, index) => {
    const sourceIndex = Math.round((index / (maxPoints - 1)) * (values.length - 1));
    return values[sourceIndex];
  });
}

function createSparkline(values, size = 28) {
  const validValues = values.filter((value) => Number.isFinite(value));
  if (validValues.length === 0) {
    return null;
  }

  const sampled = sampleValues(validValues, size);
  const min = Math.min(...sampled);
  const max = Math.max(...sampled);
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

  if (max === min) {
    return blocks[3].repeat(sampled.length);
  }

  return sampled
    .map((value) => {
      const ratio = (value - min) / (max - min);
      return blocks[Math.min(blocks.length - 1, Math.max(0, Math.round(ratio * (blocks.length - 1))))];
    })
    .join('');
}

function formatPricePercent(value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }

  return `${Math.round(value * 100)}%`;
}

function formatPolymarketChartField(charts) {
  const lines = (charts || [])
    .map((chart) => {
      if (!chart.ok || chart.points.length === 0) {
        return `${truncateText(chart.outcome, 32)}: 차트 없음`;
      }

      const prices = chart.points.map((point) => point.price);
      const sparkline = createSparkline(prices);
      const first = prices[0];
      const last = prices[prices.length - 1];
      return [
        `${truncateText(chart.outcome, 32)} ${formatPricePercent(first)} -> ${formatPricePercent(last)}`,
        sparkline,
      ].filter(Boolean).join('\n');
    })
    .filter(Boolean);

  return lines.length > 0
    ? lines.join('\n')
    : '가격 히스토리를 표시할 수 없습니다.';
}

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngCrcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = pngCrcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createPngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type);
  const lengthBuffer = Buffer.alloc(4);
  const crcBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(data.length, 0);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
}

function getRgbParts(color) {
  return [
    (color >> 16) & 0xff,
    (color >> 8) & 0xff,
    color & 0xff,
  ];
}

function createPixelBuffer(width, height, backgroundColor) {
  const pixels = Buffer.alloc(width * height * 4);
  const [red, green, blue] = getRgbParts(backgroundColor);

  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = red;
    pixels[index + 1] = green;
    pixels[index + 2] = blue;
    pixels[index + 3] = 255;
  }

  return pixels;
}

function drawPixel(pixels, width, height, x, y, color) {
  const safeX = Math.round(x);
  const safeY = Math.round(y);
  if (safeX < 0 || safeX >= width || safeY < 0 || safeY >= height) {
    return;
  }

  const index = (safeY * width + safeX) * 4;
  const [red, green, blue] = getRgbParts(color);
  pixels[index] = red;
  pixels[index + 1] = green;
  pixels[index + 2] = blue;
  pixels[index + 3] = 255;
}

function drawFilledRect(pixels, width, height, x, y, rectWidth, rectHeight, color) {
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(width, Math.ceil(x + rectWidth));
  const bottom = Math.min(height, Math.ceil(y + rectHeight));

  for (let drawY = top; drawY < bottom; drawY += 1) {
    for (let drawX = left; drawX < right; drawX += 1) {
      drawPixel(pixels, width, height, drawX, drawY, color);
    }
  }
}

function drawLine(pixels, width, height, startX, startY, endX, endY, color, thickness = 1) {
  const dx = Math.abs(Math.round(endX) - Math.round(startX));
  const dy = Math.abs(Math.round(endY) - Math.round(startY));
  const steps = Math.max(dx, dy, 1);
  const radius = Math.max(0, Math.floor(thickness / 2));

  for (let step = 0; step <= steps; step += 1) {
    const ratio = step / steps;
    const x = startX + (endX - startX) * ratio;
    const y = startY + (endY - startY) * ratio;

    for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
      for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
        if ((offsetX * offsetX) + (offsetY * offsetY) <= radius * radius + 1) {
          drawPixel(pixels, width, height, x + offsetX, y + offsetY, color);
        }
      }
    }
  }
}

function drawCircle(pixels, width, height, centerX, centerY, radius, color) {
  for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
    for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
      if ((offsetX * offsetX) + (offsetY * offsetY) <= radius * radius) {
        drawPixel(pixels, width, height, centerX + offsetX, centerY + offsetY, color);
      }
    }
  }
}

const bitmapFont = {
  ' ': ['000', '000', '000', '000', '000', '000', '000'],
  '!': ['010', '010', '010', '010', '010', '000', '010'],
  '#': ['01010', '01010', '11111', '01010', '11111', '01010', '01010'],
  '%': ['11001', '11010', '00100', '01000', '10011', '01011', '10011'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '/': ['00001', '00010', '00100', '01000', '10000', '00000', '00000'],
  ':': ['000', '010', '010', '000', '010', '010', '000'],
  '.': ['000', '000', '000', '000', '000', '010', '010'],
  ',': ['000', '000', '000', '000', '010', '010', '100'],
  '(': ['001', '010', '100', '100', '100', '010', '001'],
  ')': ['100', '010', '001', '001', '001', '010', '100'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '11100'],
  'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  'B': ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  'C': ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  'D': ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  'F': ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  'G': ['01111', '10000', '10000', '10011', '10001', '10001', '01110'],
  'H': ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  'I': ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  'J': ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  'K': ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  'L': ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  'M': ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  'N': ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  'P': ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  'Q': ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  'S': ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  'U': ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  'V': ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  'W': ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  'X': ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  'Y': ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  'Z': ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100'],
};

function drawBitmapText(pixels, width, height, rawText, x, y, color, scale = 2) {
  const text = String(rawText || '').toUpperCase();
  let cursorX = x;
  let cursorY = y;

  for (const character of text) {
    if (character === '\n') {
      cursorX = x;
      cursorY += 9 * scale;
      continue;
    }

    const glyph = bitmapFont[character] || bitmapFont['?'];
    const glyphWidth = glyph[0].length;
    glyph.forEach((row, rowIndex) => {
      for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
        if (row[columnIndex] !== '1') {
          continue;
        }

        drawFilledRect(
          pixels,
          width,
          height,
          cursorX + columnIndex * scale,
          cursorY + rowIndex * scale,
          scale,
          scale,
          color,
        );
      }
    });

    cursorX += (glyphWidth + 1) * scale;
  }
}

function drawRectBorder(pixels, width, height, x, y, rectWidth, rectHeight, color, thickness = 2) {
  drawFilledRect(pixels, width, height, x, y, rectWidth, thickness, color);
  drawFilledRect(pixels, width, height, x, y + rectHeight - thickness, rectWidth, thickness, color);
  drawFilledRect(pixels, width, height, x, y, thickness, rectHeight, color);
  drawFilledRect(pixels, width, height, x + rectWidth - thickness, y, thickness, rectHeight, color);
}

function drawMetricCard(pixels, width, height, x, y, rectWidth, rectHeight, label, value, color) {
  drawFilledRect(pixels, width, height, x, y, rectWidth, rectHeight, 0x111827);
  drawRectBorder(pixels, width, height, x, y, rectWidth, rectHeight, 0x293447, 2);
  drawFilledRect(pixels, width, height, x, y, 8, rectHeight, color);
  drawBitmapText(pixels, width, height, label, x + 20, y + 18, 0x9ca3af, 2);
  drawBitmapText(pixels, width, height, value, x + 20, y + 48, 0xf8fafc, 3);
}

function drawProgressBarImage(pixels, width, height, x, y, barWidth, barHeight, ratio, color) {
  const safeRatio = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  drawFilledRect(pixels, width, height, x, y, barWidth, barHeight, 0x1f2937);
  drawFilledRect(pixels, width, height, x, y, Math.max(2, Math.floor(barWidth * safeRatio)), barHeight, color);
  drawRectBorder(pixels, width, height, x, y, barWidth, barHeight, 0x374151, 2);
}

function compactNumber(value) {
  const number = Number.isFinite(value) ? Math.floor(value) : 0;
  const sign = number < 0 ? '-' : '';
  const abs = Math.abs(number);

  if (abs >= 1000000000) {
    return `${sign}${Math.floor(abs / 100000000) / 10}B`;
  }

  if (abs >= 1000000) {
    return `${sign}${Math.floor(abs / 100000) / 10}M`;
  }

  if (abs >= 10000) {
    return `${sign}${Math.floor(abs / 100) / 10}K`;
  }

  return `${number}`;
}

function toAsciiText(value, fallback = 'ITEM') {
  const text = String(value || '')
    .replace(/[^\x20-\x7e]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text || fallback;
}

function getDashboardGradeColor(gradeKey) {
  return {
    common: 0xbfc7d5,
    uncommon: 0x40c463,
    rare: 0x3b82f6,
    epic: 0xa855f7,
    legendary: 0xfacc15,
    mythic: 0xef4444,
  }[gradeKey] || 0x94a3b8;
}

function drawFilledPolygon(pixels, width, height, points, color) {
  const minY = Math.max(0, Math.floor(Math.min(...points.map((point) => point.y))));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(...points.map((point) => point.y))));

  for (let y = minY; y <= maxY; y += 1) {
    const intersections = [];

    for (let index = 0; index < points.length; index += 1) {
      const start = points[index];
      const end = points[(index + 1) % points.length];

      if ((start.y <= y && end.y > y) || (end.y <= y && start.y > y)) {
        const ratio = (y - start.y) / (end.y - start.y);
        intersections.push(start.x + ratio * (end.x - start.x));
      }
    }

    intersections.sort((a, b) => a - b);
    for (let index = 0; index < intersections.length; index += 2) {
      const left = Math.max(0, Math.ceil(intersections[index]));
      const right = Math.min(width - 1, Math.floor(intersections[index + 1]));

      for (let x = left; x <= right; x += 1) {
        drawPixel(pixels, width, height, x, y, color);
      }
    }
  }
}

function drawMirroredPolygon(pixels, width, height, points, color) {
  drawFilledPolygon(pixels, width, height, points, color);
  drawFilledPolygon(
    pixels,
    width,
    height,
    points.map((point) => ({ x: width - point.x, y: point.y })),
    color,
  );
}

function drawPlacementExamTierIcon(pixels, width, height, tier) {
  const centerX = width / 2;
  const centerY = height / 2;
  const primary = tier.color;
  const accent = tier.accent;
  const isLossTier = tier.multiplier < 0;
  const highTierScale = tier.multiplier >= 20 ? 1 : tier.multiplier >= 5 ? 0.82 : tier.multiplier > 0 ? 0.68 : 0.56;

  drawCircle(pixels, width, height, centerX, centerY, 116, 0x111827);
  drawCircle(pixels, width, height, centerX, centerY, 104, 0x182234);
  drawCircle(pixels, width, height, centerX, centerY, 92, 0x0b1020);

  drawMirroredPolygon(
    pixels,
    width,
    height,
    [
      { x: centerX, y: 42 },
      { x: centerX - 82 * highTierScale, y: 76 },
      { x: centerX - 36 * highTierScale, y: 112 },
      { x: centerX - 100 * highTierScale, y: 160 },
      { x: centerX - 28 * highTierScale, y: 148 },
    ],
    primary,
  );
  drawMirroredPolygon(
    pixels,
    width,
    height,
    [
      { x: centerX, y: 64 },
      { x: centerX - 56 * highTierScale, y: 90 },
      { x: centerX - 24 * highTierScale, y: 118 },
      { x: centerX - 66 * highTierScale, y: 150 },
      { x: centerX - 18 * highTierScale, y: 140 },
    ],
    0x0b1020,
  );

  drawFilledPolygon(
    pixels,
    width,
    height,
    [
      { x: centerX, y: 34 },
      { x: centerX + 44, y: centerY },
      { x: centerX, y: 222 },
      { x: centerX - 44, y: centerY },
    ],
    primary,
  );
  drawFilledPolygon(
    pixels,
    width,
    height,
    [
      { x: centerX, y: 58 },
      { x: centerX + 28, y: centerY },
      { x: centerX, y: 196 },
      { x: centerX - 28, y: centerY },
    ],
    0x0b1020,
  );
  drawFilledPolygon(
    pixels,
    width,
    height,
    [
      { x: centerX, y: 76 },
      { x: centerX + 18, y: centerY },
      { x: centerX, y: 178 },
      { x: centerX - 18, y: centerY },
    ],
    accent,
  );

  if (!isLossTier) {
    drawFilledPolygon(
      pixels,
      width,
      height,
      [
        { x: centerX, y: 24 },
        { x: centerX + 16, y: 54 },
        { x: centerX, y: 70 },
        { x: centerX - 16, y: 54 },
      ],
      accent,
    );
  }

  drawLine(pixels, width, height, centerX - 74, 196, centerX, 224, accent, 5);
  drawLine(pixels, width, height, centerX + 74, 196, centerX, 224, accent, 5);
  drawCircle(pixels, width, height, centerX, centerY, isLossTier ? 10 : 13, 0xffffff);
  drawCircle(pixels, width, height, centerX, centerY, isLossTier ? 5 : 7, accent);
}

function createPlacementExamTierIconFile(tier) {
  const width = 256;
  const height = 256;
  const pixels = createPixelBuffer(width, height, 0x070b14);
  const fileName = `placement-${tier.key}.png`;

  drawPlacementExamTierIcon(pixels, width, height, tier);

  return {
    fileName,
    attachment: new AttachmentBuilder(encodePng(width, height, pixels), { name: fileName }),
  };
}

function createStatusCardFile(target, user) {
  const width = 1280;
  const height = 1580;
  const displayName = getDisplayName(target, user);
  const evolutions = getUserEvolutions(user);
  const activeEvolutions = evolutions.filter((evolution) => evolution.durability > 0);
  const bestWeapon = getBestBattleWeapon(user);
  const battlePower = bestWeapon?.power || getUserPower(user);
  const stats = user.stats || {};
  const score = Math.floor(getPowerScore(battlePower));
  const totalDurability = evolutions.reduce((sum, evolution) => sum + evolution.durability, 0);
  const maxDurability = evolutions.reduce((sum, evolution) => sum + evolution.maxDurability, 0);
  const durabilityRatio = maxDurability > 0 ? totalDurability / maxDurability : 0;
  const statMax = Math.max(1, battlePower.attack, battlePower.defense, battlePower.luck);
  const fileName = `status-${target.id || 'user'}.png`;
  const activeText = activeEvolutions.length > 0
    ? `전투 가능 진화 ${activeEvolutions.length}개 / 전체 ${evolutions.length}개`
    : '아직 전투 진화가 준비되지 않았습니다.';
  const bestWeaponText = bestWeapon
    ? `${bestWeapon.evolution.grade.label} ${bestWeapon.evolution.itemName} +${bestWeapon.evolution.enhanceLevel}`
    : '전투 가능 무기 없음';
  const nextTarget = evolutions[0];
  const nextAction = nextTarget
    ? `/아이템강화 아이템:${nextTarget.itemName}`
    : '/낚시 후 /아이템사용';
  const statRows = [
    ['공격', battlePower.attack, 0xef4444],
    ['방어', battlePower.defense, 0x38bdf8],
    ['행운', battlePower.luck, 0xa78bfa],
  ].map(([label, value, color], index) => {
    const y = 560 + index * 82;
    const ratio = Math.max(0, Math.min(1, value / statMax));
    return `
      <text x="92" y="${y + 14}" class="small-label">${escapeSvgText(label)}</text>
      <rect x="190" y="${y - 8}" width="382" height="30" rx="15" fill="#1f2937"/>
      <rect x="190" y="${y - 8}" width="${Math.max(8, Math.floor(382 * ratio))}" height="30" rx="15" fill="${colorToHex(color)}"/>
      <text x="602" y="${y + 16}" class="metric-number">${escapeSvgText(String(value))}</text>
    `;
  }).join('');
  const evolutionRows = evolutions.slice(0, 6).map((evolution, index) => {
    const y = 960 + index * 78;
    const enhanceText = evolution.enhanceLevel > 0 ? `+${evolution.enhanceLevel}` : '+0';
    const nextCost = getItemEnhancementCost(evolution.grade.key, evolution.enhanceLevel);
    const nextRates = getItemEnhancementRates(evolution.grade.key, evolution.enhanceLevel);
    const status = evolution.durability > 0 ? '사용 가능' : '파손';
    const barRatio = evolution.maxDurability > 0 ? evolution.durability / evolution.maxDurability : 0;
    const gradeColor = colorToHex(getDashboardGradeColor(evolution.grade.key));
    return `
      <g>
        <rect x="72" y="${y - 36}" width="1136" height="62" rx="18" fill="${index % 2 === 0 ? '#101827' : '#172033'}" stroke="#293447"/>
        <rect x="94" y="${y - 17}" width="18" height="18" rx="5" fill="${gradeColor}"/>
        <text x="130" y="${y - 4}" class="item-title">${escapeSvgText(`${evolution.grade.label} ${evolution.itemName} ${enhanceText}`)}</text>
        <text x="560" y="${y - 4}" class="item-sub">${escapeSvgText(status)}</text>
        <rect x="650" y="${y - 24}" width="210" height="18" rx="9" fill="#1f2937"/>
        <rect x="650" y="${y - 24}" width="${Math.max(4, Math.floor(210 * barRatio))}" height="18" rx="9" fill="${barRatio > 0.35 ? '#34d399' : '#ef4444'}"/>
        <text x="880" y="${y - 6}" class="item-sub">${escapeSvgText(`${evolution.durability}/${evolution.maxDurability}`)}</text>
        <text x="130" y="${y + 18}" class="item-sub">${escapeSvgText(`다음 강화 ${formatEnhancementRates(nextRates)} / ${formatCoins(nextCost)}`)}</text>
      </g>
    `;
  }).join('') || `
    <rect x="72" y="924" width="1136" height="112" rx="24" fill="#101827" stroke="#293447"/>
    <text x="108" y="990" class="empty">해금된 진화 아이템이 없습니다. /아이템사용으로 먼저 해금해 주세요.</text>
  `;
  const moreEvolutionText = evolutions.length > 6
    ? `<text x="92" y="1454" class="tiny">외 ${evolutions.length - 6}개 진화 아이템은 /보관함에서 확인</text>`
    : '';
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <linearGradient id="status-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#07111f"/>
          <stop offset="54%" stop-color="#101827"/>
          <stop offset="100%" stop-color="#1f2937"/>
        </linearGradient>
        <linearGradient id="hero" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#2563eb"/>
          <stop offset="100%" stop-color="#7c3aed"/>
        </linearGradient>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="16" stdDeviation="18" flood-color="#000000" flood-opacity="0.35"/>
        </filter>
      </defs>
      <style>
        text { font-family: "Noto Sans CJK KR", "Noto Sans KR", sans-serif; }
        .eyebrow { font-size: 26px; fill: #bfdbfe; font-weight: 800; letter-spacing: 2px; }
        .title { font-size: 58px; fill: #f8fafc; font-weight: 900; }
        .subtitle { font-size: 26px; fill: #dbeafe; font-weight: 600; }
        .card-label { font-size: 24px; fill: #9ca3af; font-weight: 800; }
        .card-value { font-size: 38px; fill: #f8fafc; font-weight: 900; }
        .section-title { font-size: 34px; fill: #f8fafc; font-weight: 900; }
        .small-label { font-size: 28px; fill: #cbd5e1; font-weight: 800; }
        .metric-number { font-size: 31px; fill: #f8fafc; font-weight: 900; }
        .body { font-size: 27px; fill: #e5e7eb; font-weight: 700; }
        .body-muted { font-size: 24px; fill: #aab6c9; font-weight: 600; }
        .item-title { font-size: 23px; fill: #f8fafc; font-weight: 900; }
        .item-sub { font-size: 18px; fill: #aab6c9; font-weight: 600; }
        .empty { font-size: 26px; fill: #cbd5e1; font-weight: 700; }
        .tiny { font-size: 20px; fill: #94a3b8; font-weight: 500; }
      </style>
      <rect width="${width}" height="${height}" fill="url(#status-bg)"/>
      <circle cx="1080" cy="134" r="260" fill="#2563eb" opacity="0.12"/>
      <circle cx="90" cy="1420" r="300" fill="#f59e0b" opacity="0.08"/>

      <rect x="48" y="48" width="1184" height="210" rx="34" fill="url(#hero)" filter="url(#shadow)"/>
      <text x="88" y="106" class="eyebrow">NOCOIN STATUS</text>
      <text x="88" y="176" class="title">${escapeSvgText(displayName)}님의 상태</text>
      <text x="88" y="222" class="subtitle">${escapeSvgText(activeText)}</text>

      <g filter="url(#shadow)">
        <rect x="48" y="302" width="270" height="132" rx="26" fill="#111827" stroke="#293447"/>
        <rect x="348" y="302" width="270" height="132" rx="26" fill="#111827" stroke="#293447"/>
        <rect x="648" y="302" width="270" height="132" rx="26" fill="#111827" stroke="#293447"/>
        <rect x="948" y="302" width="284" height="132" rx="26" fill="#111827" stroke="#293447"/>
      </g>
      <text x="78" y="354" class="card-label">잔액</text>
      <text x="78" y="404" class="card-value">${escapeSvgText(formatCoins(user.balance || 0))}</text>
      <text x="378" y="354" class="card-label">전투력</text>
      <text x="378" y="404" class="card-value">${escapeSvgText(`${score}점`)}</text>
      <text x="678" y="354" class="card-label">진화 무기</text>
      <text x="678" y="404" class="card-value">${activeEvolutions.length}/${evolutions.length}개</text>
      <text x="978" y="354" class="card-label">방지권</text>
      <text x="978" y="404" class="card-value">${user.protectionTickets || 0}장</text>

      <rect x="48" y="482" width="584" height="334" rx="30" fill="#111827" stroke="#293447" filter="url(#shadow)"/>
      <text x="84" y="532" class="section-title">대표 무기와 스탯</text>
      <text x="84" y="864" class="body">${escapeSvgText(bestWeaponText)}</text>
      ${statRows}

      <rect x="672" y="482" width="560" height="334" rx="30" fill="#111827" stroke="#293447" filter="url(#shadow)"/>
      <text x="708" y="532" class="section-title">내구도와 기록</text>
      <rect x="708" y="574" width="408" height="34" rx="17" fill="#1f2937"/>
      <rect x="708" y="574" width="${Math.max(6, Math.floor(408 * durabilityRatio))}" height="34" rx="17" fill="${durabilityRatio > 0.35 ? '#34d399' : '#ef4444'}"/>
      <text x="1134" y="603" class="metric-number">${Math.round(durabilityRatio * 100)}%</text>
      <text x="708" y="666" class="body">${escapeSvgText(`전체 내구도 ${totalDurability}/${maxDurability || 0}`)}</text>
      <text x="708" y="716" class="body-muted">${escapeSvgText(`결투 ${stats.battlesWon || 0}승 ${stats.battlesLost || 0}패 / 수익 ${formatCoins(stats.battleProfit || 0)}`)}</text>
      <text x="708" y="762" class="body-muted">${escapeSvgText(`강화 ${stats.itemEnhanceSuccesses || 0}/${stats.itemEnhanceAttempts || 0} 성공 / 사용 ${formatCoins(stats.itemEnhanceSpent || 0)}`)}</text>

      <rect x="48" y="872" width="1184" height="610" rx="30" fill="#0f172a" stroke="#293447" filter="url(#shadow)"/>
      <text x="84" y="930" class="section-title">아이템 상태</text>
      ${evolutionRows}
      ${moreEvolutionText}

      <rect x="48" y="1502" width="1184" height="44" rx="22" fill="#172033"/>
      <text x="82" y="1533" class="tiny">${escapeSvgText(`다음 행동: ${nextAction} · 상세 보관함은 /보관함`)}</text>
    </svg>
  `;
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'original' },
    font: {
      fontFiles: dashboardFontFiles,
      loadSystemFonts: dashboardFontFiles.length === 0,
      defaultFontFamily: 'Noto Sans CJK KR',
    },
  });

  return {
    fileName,
    attachment: new AttachmentBuilder(resvg.render().asPng(), { name: fileName }),
  };
}

function createInventoryCardFile(target, user) {
  const width = 960;
  const height = 620;
  const pixels = createPixelBuffer(width, height, 0x08111d);
  const displayName = toAsciiText(getDisplayName(target, user), 'USER');
  const items = getInventoryItems(user);
  const totalCount = items.reduce((sum, item) => sum + item.count, 0);
  const totalValue = items.reduce((sum, item) => sum + item.totalValue, 0);
  const gradeCounts = new Map();
  const fileName = `inventory-${target.id || 'user'}.png`;

  for (const item of items) {
    const grade = getItemGradeConfig(getItemEvolution(item.name).grade);
    gradeCounts.set(grade.key, (gradeCounts.get(grade.key) || 0) + item.count);
  }

  drawFilledRect(pixels, width, height, 0, 0, width, 96, 0x102033);
  drawFilledRect(pixels, width, height, 0, 96, width, 4, uiTheme.colors.inventory);
  drawBitmapText(pixels, width, height, 'INVENTORY BOARD', 36, 28, 0xf8fafc, 3);
  drawBitmapText(pixels, width, height, displayName.slice(0, 28), 566, 34, 0x7dd3fc, 2);

  drawMetricCard(pixels, width, height, 36, 124, 205, 96, 'TYPES', `${items.length}`, 0x38bdf8);
  drawMetricCard(pixels, width, height, 263, 124, 205, 96, 'TOTAL', `${totalCount}`, 0x34d399);
  drawMetricCard(pixels, width, height, 490, 124, 205, 96, 'VALUE', compactNumber(totalValue), 0xfacc15);
  drawMetricCard(pixels, width, height, 717, 124, 205, 96, 'TICKETS', `${user.protectionTickets || 0}`, 0xf472b6);

  drawFilledRect(pixels, width, height, 36, 248, 420, 316, 0x111827);
  drawRectBorder(pixels, width, height, 36, 248, 420, 316, 0x293447, 2);
  drawBitmapText(pixels, width, height, 'GRADE MIX', 60, 274, 0xf8fafc, 2);
  ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'].forEach((gradeKey, index) => {
    const y = 320 + index * 38;
    const count = gradeCounts.get(gradeKey) || 0;
    const ratio = totalCount > 0 ? count / totalCount : 0;
    drawBitmapText(pixels, width, height, gradeKey.slice(0, 6), 60, y, 0x9ca3af, 2);
    drawProgressBarImage(pixels, width, height, 174, y - 4, 190, 18, ratio, getDashboardGradeColor(gradeKey));
    drawBitmapText(pixels, width, height, `${count}`, 382, y - 2, 0xf8fafc, 2);
  });

  drawFilledRect(pixels, width, height, 504, 248, 418, 316, 0x111827);
  drawRectBorder(pixels, width, height, 504, 248, 418, 316, 0x293447, 2);
  drawBitmapText(pixels, width, height, 'TOP ITEMS', 528, 274, 0xf8fafc, 2);

  if (items.length === 0) {
    drawBitmapText(pixels, width, height, 'EMPTY INVENTORY', 528, 336, 0x9ca3af, 2);
  } else {
    items.slice(0, 7).forEach((item, index) => {
      const grade = getItemGradeConfig(getItemEvolution(item.name).grade);
      const y = 320 + index * 34;
      drawFilledRect(pixels, width, height, 528, y, 14, 14, getDashboardGradeColor(grade.key));
      drawBitmapText(
        pixels,
        width,
        height,
        `#${index + 1} ${grade.key.slice(0, 4)} X${item.count} V${compactNumber(item.bestValue || 0)}`,
        552,
        y - 2,
        0xd1d5db,
        2,
      );
    });
  }

  return {
    fileName,
    attachment: new AttachmentBuilder(encodePng(width, height, pixels), { name: fileName }),
  };
}

function encodePng(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    pngSignature,
    createPngChunk('IHDR', ihdr),
    createPngChunk('IDAT', zlib.deflateSync(raw)),
    createPngChunk('IEND'),
  ]);
}

function clampChartPrice(value) {
  return Math.max(0, Math.min(1, value));
}

function createPolymarketChartFile(market, charts = []) {
  const drawableCharts = (charts || [])
    .filter((chart) => chart.ok && chart.points?.some((point) => Number.isFinite(point.price)))
    .map((chart) => ({
      outcome: chart.outcome,
      points: sampleValues(
        chart.points
          .map((point) => Number(point.price))
          .filter((price) => Number.isFinite(price))
          .map(clampChartPrice),
        96,
      ),
    }))
    .filter((chart) => chart.points.length > 0);

  if (drawableCharts.length === 0) {
    return null;
  }

  const width = 900;
  const height = 420;
  const margin = { left: 56, right: 32, top: 40, bottom: 44 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const pixels = createPixelBuffer(width, height, 0xf8fafc);
  const palette = [0x27ae60, 0xe74c3c, 0x3498db, 0x9b59b6];

  drawFilledRect(pixels, width, height, margin.left, margin.top, plotWidth, plotHeight, 0xffffff);

  for (let index = 0; index <= 4; index += 1) {
    const y = margin.top + (plotHeight / 4) * index;
    drawLine(pixels, width, height, margin.left, y, margin.left + plotWidth, y, 0xdbe3ea, index === 2 ? 2 : 1);
  }

  for (let index = 0; index <= 6; index += 1) {
    const x = margin.left + (plotWidth / 6) * index;
    drawLine(pixels, width, height, x, margin.top, x, margin.top + plotHeight, 0xedf2f7, 1);
  }

  drawLine(pixels, width, height, margin.left, margin.top, margin.left, margin.top + plotHeight, 0x94a3b8, 2);
  drawLine(pixels, width, height, margin.left, margin.top + plotHeight, margin.left + plotWidth, margin.top + plotHeight, 0x94a3b8, 2);

  drawableCharts.slice(0, 4).forEach((chart, chartIndex) => {
    const color = palette[chartIndex % palette.length];
    const points = chart.points.map((price, pointIndex) => {
      const x = chart.points.length === 1
        ? margin.left
        : margin.left + (plotWidth * pointIndex) / (chart.points.length - 1);
      const y = margin.top + plotHeight * (1 - price);
      return { x, y };
    });

    drawFilledRect(pixels, width, height, margin.left + chartIndex * 48, 20, 32, 10, color);

    for (let pointIndex = 1; pointIndex < points.length; pointIndex += 1) {
      drawLine(
        pixels,
        width,
        height,
        points[pointIndex - 1].x,
        points[pointIndex - 1].y,
        points[pointIndex].x,
        points[pointIndex].y,
        color,
        4,
      );
    }

    drawCircle(pixels, width, height, points[0].x, points[0].y, 5, color);
    drawCircle(pixels, width, height, points[points.length - 1].x, points[points.length - 1].y, 6, color);
  });

  const fileSlug = String(market.id || market.conditionId || 'chart')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'chart';
  const fileName = `polymarket-${fileSlug}.png`;
  return {
    fileName,
    attachment: new AttachmentBuilder(encodePng(width, height, pixels), { name: fileName }),
  };
}

function getUnixTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : Math.floor(date.getTime() / 1000);
}

function countBetParticipants(bet) {
  return Object.keys(bet.wagers || {}).length;
}

function getBetOptionByIndex(bet, rawIndex) {
  const index = Number.parseInt(rawIndex, 10);
  if (!Number.isInteger(index) || index < 0 || index >= bet.options.length) {
    return null;
  }

  return {
    index,
    option: bet.options[index],
  };
}

function betCustomId(...parts) {
  return ['bet', ...parts].join(':');
}

function parseBetCustomId(customId) {
  const parts = String(customId || '').split(':');
  if (parts[0] !== 'bet') {
    return null;
  }

  return {
    action: parts[1],
    parts: parts.slice(2),
  };
}

function polymarketCustomId(...parts) {
  return ['poly', ...parts].join(':');
}

function parsePolymarketCustomId(customId) {
  const parts = String(customId || '').split(':');
  if (parts[0] !== 'poly') {
    return null;
  }

  return {
    action: parts[1],
    parts: parts.slice(2),
  };
}

function battleCustomId(action, challengeId, ...parts) {
  return ['battle', action, challengeId, ...parts].join(':');
}

function parseBattleCustomId(customId) {
  const parts = String(customId || '').split(':');
  if (parts[0] !== 'battle') {
    return null;
  }

  return {
    action: parts[1],
    challengeId: parts[2],
    parts: parts.slice(3),
  };
}

function itemEnhanceCustomId(action, requestId) {
  return ['itemEnhance', action, requestId].join(':');
}

function parseItemEnhanceCustomId(customId) {
  const parts = String(customId || '').split(':');
  if (parts[0] !== 'itemEnhance') {
    return null;
  }

  return {
    action: parts[1],
    requestId: parts[2],
  };
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createBattleChallengeId() {
  return randomUUID().replaceAll('-', '').slice(0, 16);
}

function createItemEnhancementRequestId() {
  return randomUUID().replaceAll('-', '').slice(0, 16);
}

function getPendingItemEnhancement(requestId, guildId) {
  const request = pendingItemEnhancements.get(requestId);
  if (!request || request.guildId !== guildId) {
    return null;
  }

  if (Date.now() - request.createdAt > itemEnhancementTtlMs) {
    pendingItemEnhancements.delete(requestId);
    return null;
  }

  return request;
}

function getBattleChallenge(challengeId, guildId) {
  const challenge = battleChallenges.get(challengeId);
  if (!challenge || challenge.guildId !== guildId) {
    return null;
  }

  if (Date.now() - challenge.createdAt > battleChallengeTtlMs) {
    battleChallenges.delete(challengeId);
    return null;
  }

  return challenge;
}

function getBattleSession(sessionId, guildId) {
  const session = battleSessions.get(sessionId);
  if (!session || session.guildId !== guildId) {
    return null;
  }

  if (Date.now() - session.updatedAt > battleSessionTtlMs) {
    battleSessions.delete(sessionId);
    return null;
  }

  return session;
}

function getUserPower(user) {
  const power = user.power && typeof user.power === 'object' ? user.power : {};
  return {
    attack: Number.isFinite(power.attack) ? Math.max(1, Math.floor(power.attack)) : 1,
    defense: Number.isFinite(power.defense) ? Math.max(1, Math.floor(power.defense)) : 1,
    luck: Number.isFinite(power.luck) ? Math.max(1, Math.floor(power.luck)) : 1,
  };
}

function getPowerScore(power) {
  return power.attack * 2 + power.defense * 1.6 + power.luck * 1.2;
}

function getEvolutionStatBias(evolution) {
  const bias = evolution?.statBias || {};
  return {
    attack: Number.isFinite(bias.attack) ? bias.attack : 0,
    defense: Number.isFinite(bias.defense) ? bias.defense : 0,
    luck: Number.isFinite(bias.luck) ? bias.luck : 0,
  };
}

function formatChance(chance) {
  return `${Math.round(chance * 1000) / 10}%`;
}

function formatEnhancementRates(rates) {
  return [
    `성공 ${formatChance(rates.successChance)}`,
    `실패 ${formatChance(rates.failureChance)}`,
    `파괴 ${formatChance(rates.destructionChance)}`,
  ].join(' / ');
}

function getUserEvolutions(user) {
  const evolutions = user.evolutions && typeof user.evolutions === 'object' ? user.evolutions : {};
  return Object.entries(evolutions)
    .map(([key, rawEvolution]) => {
      const record = rawEvolution && typeof rawEvolution === 'object' ? rawEvolution : {};
      const itemName = record.itemName || key;
      const definition = getItemEvolution(itemName);
      const grade = getItemGradeConfig(record.grade || definition.grade);
      const maxDurability = Number.isFinite(record.maxDurability)
        ? Math.max(1, Math.floor(record.maxDurability))
        : grade.maxDurability;
      const durability = Number.isFinite(record.durability)
        ? Math.max(0, Math.min(maxDurability, Math.floor(record.durability)))
        : maxDurability;
      const enhanceLevel = Number.isFinite(record.enhanceLevel)
        ? Math.max(0, Math.floor(record.enhanceLevel))
        : 0;
      const rawEnhancePowerBonus = record.enhancePowerBonus && typeof record.enhancePowerBonus === 'object'
        ? record.enhancePowerBonus
        : {};
      const enhancePowerBonus = {
        attack: Number.isFinite(rawEnhancePowerBonus.attack) ? Math.max(0, Math.floor(rawEnhancePowerBonus.attack)) : 0,
        defense: Number.isFinite(rawEnhancePowerBonus.defense) ? Math.max(0, Math.floor(rawEnhancePowerBonus.defense)) : 0,
        luck: Number.isFinite(rawEnhancePowerBonus.luck) ? Math.max(0, Math.floor(rawEnhancePowerBonus.luck)) : 0,
      };
      return {
        key,
        itemName,
        name: record.name || definition.evolution,
        level: Number.isFinite(record.level) ? Math.max(1, Math.floor(record.level)) : 1,
        enhanceLevel,
        enhancePowerBonus,
        used: Number.isFinite(record.used) ? Math.max(1, Math.floor(record.used)) : 1,
        lastUsedAt: record.lastUsedAt || null,
        grade,
        durability,
        maxDurability,
        definition,
      };
    })
    .sort((a, b) =>
      (b.level + b.enhanceLevel) - (a.level + a.enhanceLevel)
      || b.used - a.used
      || a.name.localeCompare(b.name, 'ko-KR')
    );
}

function findUserEvolutionByKey(user, rawKey) {
  const wanted = normalizeKey(rawKey);
  return getUserEvolutions(user).find((evolution) => evolution.key === wanted);
}

function getWeaponBattlePower(evolution) {
  if (!evolution || evolution.durability <= 0) {
    return { attack: 6, defense: 6, luck: 2 };
  }

  const grade = normalizeGradeConfig(evolution.grade || evolution.definition?.grade);
  const profile = weaponGradeBattleProfiles[grade.key] || weaponGradeBattleProfiles.common;
  const bias = getEvolutionStatBias(evolution.definition);
  const level = Math.max(1, Math.floor(evolution.level || 1));
  const enhanceLevel = Math.max(0, Math.floor(evolution.enhanceLevel || 0));
  const enhancePowerBonus = evolution.enhancePowerBonus && typeof evolution.enhancePowerBonus === 'object'
    ? evolution.enhancePowerBonus
    : {};
  const durabilityRatio = Math.max(0.35, Math.min(1, evolution.durability / Math.max(1, evolution.maxDurability)));

  return {
    attack: Math.max(1, Math.floor((
      profile.base.attack
      + Math.max(0, bias.attack) * profile.biasScale
      + level * profile.levelScale
      + enhanceLevel * profile.enhanceScale
      + Math.max(0, Math.floor(enhancePowerBonus.attack || 0))
    ) * durabilityRatio)),
    defense: Math.max(1, Math.floor((
      profile.base.defense
      + Math.max(0, bias.defense) * profile.biasScale
      + level * profile.levelScale
      + enhanceLevel * profile.enhanceScale
      + Math.max(0, Math.floor(enhancePowerBonus.defense || 0))
    ) * durabilityRatio)),
    luck: Math.max(1, Math.floor((
      profile.base.luck
      + Math.max(0, bias.luck) * Math.max(2, Math.floor(profile.biasScale * 0.7))
      + level * Math.max(1, Math.floor(profile.levelScale * 0.7))
      + enhanceLevel * Math.max(1, Math.floor(profile.enhanceScale * 0.65))
      + Math.max(0, Math.floor(enhancePowerBonus.luck || 0))
    ) * durabilityRatio)),
  };
}

function getBestBattleWeapon(user) {
  return getUserEvolutions(user)
    .filter((evolution) => evolution.durability > 0)
    .map((evolution) => ({
      evolution,
      power: getWeaponBattlePower(evolution),
    }))
    .sort((a, b) => getPowerScore(b.power) - getPowerScore(a.power))[0] || null;
}

function getBattleStyle(user, weaponKey) {
  const weapon = weaponKey ? findUserEvolutionByKey(user, weaponKey) : getBestBattleWeapon(user)?.evolution;

  if (!weapon || weapon.durability <= 0) {
    return {
      weapon: null,
      evolutions: [],
      power: { attack: 6, defense: 6, luck: 2 },
      attackBonus: 0,
      defenseBonus: 0,
      luckBonus: 0,
    };
  }

  const power = getWeaponBattlePower(weapon);

  return {
    weapon,
    evolutions: [weapon],
    power,
    attackBonus: Math.floor(power.attack * 0.12),
    defenseBonus: Math.floor(power.defense * 0.12),
    luckBonus: Math.floor(power.luck * 0.15),
  };
}

function formatEvolutionSummary(user, maxItems = 4) {
  const evolutions = getUserEvolutions(user);
  if (evolutions.length === 0) {
    return '아직 진화가 없습니다. `/아이템사용`으로 낚시 아이템을 사용해 진화할 수 있습니다.';
  }

  return evolutions
    .slice(0, maxItems)
    .map((evolution) => {
      const enhanceText = evolution.enhanceLevel > 0 ? ` +${evolution.enhanceLevel}` : '';
      const nextCost = getItemEnhancementCost(evolution.grade.key, evolution.enhanceLevel);
      const nextRates = getItemEnhancementRates(evolution.grade.key, evolution.enhanceLevel);
      return `${formatItemGradeLabel(evolution.grade)} ${evolution.name} Lv.${evolution.level}${enhanceText} (${evolution.itemName}) · 내구도 ${evolution.durability}/${evolution.maxDurability} · 다음 ${formatCoins(nextCost)} / ${formatEnhancementRates(nextRates)}`;
    })
    .join('\n');
}

function pickBattleEvolution(style, round, luckRoll) {
  if (style.evolutions.length === 0) {
    return {
      name: '맨몸 도전자',
      level: 1,
      definition: {
        evolution: '맨몸 도전자',
        attack: '정면 타격',
        motion: '자세를 낮추고 빈틈을 향해 곧장 파고듭니다.',
        ultimate: '마지막 집중',
        ultimateMotion: '남은 힘을 모아 한 번 더 밀어붙입니다.',
        statBias: { attack: 0, defense: 0, luck: 0 },
      },
    };
  }

  return style.evolutions[(round + luckRoll) % style.evolutions.length];
}

function resolveBattleMove({
  attackerId,
  defenderId,
  records,
  attackerPower,
  defenderPower,
  attackerStyle,
  defenderStyle,
  round,
}) {
  const luckRoll = randomInt(0, Math.max(1, attackerPower.luck + attackerStyle.luckBonus));
  const evolution = pickBattleEvolution(attackerStyle, round - 1, luckRoll);
  const definition = evolution.definition;
  const shouldUltimate = round >= 3 || luckRoll >= Math.max(4, defenderPower.luck + 4);
  const attackName = shouldUltimate ? definition.ultimate : definition.attack;
  const motion = shouldUltimate ? definition.ultimateMotion : definition.motion;
  const baseDamage = randomInt(12, 28);
  const evolutionLevel = Math.max(1, (evolution.level || 1) + (evolution.enhanceLevel || 0));
  const rawDamage = baseDamage
    + attackerPower.attack * 3
    + attackerStyle.attackBonus
    + evolutionLevel * (shouldUltimate ? 5 : 2)
    + luckRoll;
  const mitigation = Math.floor((defenderPower.defense * 1.4) + (defenderStyle.defenseBonus * 0.7));
  const damage = Math.max(1, rawDamage - mitigation);

  return {
    damage,
    isUltimate: shouldUltimate,
    text: [
      `${getBattleDisplayName(attackerId, records)} [${evolution.grade?.label || '일반'} ${evolution.name} Lv.${evolutionLevel}]`,
      `${shouldUltimate ? '궁극기' : '기술'}: ${attackName}`,
      `${motion}`,
      `<@${defenderId}>에게 ${damage} 피해`,
    ].join('\n'),
  };
}

function createBattleSession(challenge, challengerRecord, opponentRecord) {
  const challengerWeaponKey = challenge.weaponKeys?.[challenge.challengerId];
  const opponentWeaponKey = challenge.weaponKeys?.[challenge.opponentId];
  const challengerStyle = getBattleStyle(challengerRecord, challengerWeaponKey);
  const opponentStyle = getBattleStyle(opponentRecord, opponentWeaponKey);
  const challengerPower = challengerStyle.power;
  const opponentPower = opponentStyle.power;
  const challengerMaxHp = 140 + challengerPower.defense * 6 + challengerStyle.defenseBonus * 3;
  const opponentMaxHp = 140 + opponentPower.defense * 6 + opponentStyle.defenseBonus * 3;
  const firstUserId = (challengerPower.luck + challengerStyle.luckBonus) >= (opponentPower.luck + opponentStyle.luckBonus)
    ? challenge.challengerId
    : challenge.opponentId;
  const now = Date.now();

  return {
    id: challenge.id,
    guildId: challenge.guildId,
    channelId: challenge.channelId,
    challengerId: challenge.challengerId,
    opponentId: challenge.opponentId,
    wager: challenge.wager,
    weaponKeys: {
      [challenge.challengerId]: challengerWeaponKey,
      [challenge.opponentId]: opponentWeaponKey,
    },
    createdAt: now,
    updatedAt: now,
    status: 'active',
    turnUserId: firstUserId,
    turnNumber: 1,
    hp: {
      [challenge.challengerId]: challengerMaxHp,
      [challenge.opponentId]: opponentMaxHp,
    },
    maxHp: {
      [challenge.challengerId]: challengerMaxHp,
      [challenge.opponentId]: opponentMaxHp,
    },
    powers: {
      [challenge.challengerId]: challengerPower,
      [challenge.opponentId]: opponentPower,
    },
    styles: {
      [challenge.challengerId]: challengerStyle,
      [challenge.opponentId]: opponentStyle,
    },
    records: {
      [challenge.challengerId]: challengerRecord,
      [challenge.opponentId]: opponentRecord,
    },
    shields: {
      [challenge.challengerId]: 0,
      [challenge.opponentId]: 0,
    },
    ultimateUsed: {
      [challenge.challengerId]: false,
      [challenge.opponentId]: false,
    },
    log: [
      `결투가 시작되었습니다. ${getBattleDisplayName(firstUserId, {
        [challenge.challengerId]: challengerRecord,
        [challenge.opponentId]: opponentRecord,
      })}님이 먼저 움직입니다.`,
    ],
  };
}

function getBattleOpponentId(session, userId) {
  return userId === session.challengerId ? session.opponentId : session.challengerId;
}

function getSessionEvolutionSummary(style, maxItems = 2) {
  if (!style?.evolutions?.length) {
    return '맨몸 도전자';
  }

  return style.evolutions
    .slice(0, maxItems)
    .map((evolution) => {
      const enhanceText = evolution.enhanceLevel > 0 ? ` +${evolution.enhanceLevel}` : '';
      return `${formatItemGradeLabel(evolution.grade)} ${evolution.name} Lv.${evolution.level}${enhanceText} 내구도 ${evolution.durability}/${evolution.maxDurability} · ${formatStatLine(getWeaponBattlePower(evolution))}`;
    })
    .join(', ');
}

function createBattleHpLine(session, userId) {
  const hp = Math.max(0, Math.floor(session.hp[userId] || 0));
  const maxHp = Math.max(1, Math.floor(session.maxHp[userId] || 1));
  const shield = Math.max(0, Math.floor(session.shields[userId] || 0));
  const shieldText = shield > 0 ? ` / 방어막 ${shield}` : '';
  return `<@${userId}> ${progressBar(hp, maxHp, 10)} ${hp}/${maxHp}${shieldText}`;
}

function resolveBattleAction(session, actorId, action) {
  const defenderId = getBattleOpponentId(session, actorId);
  const records = session.records;
  const actorPower = session.powers[actorId];
  const defenderPower = session.powers[defenderId];
  const actorStyle = session.styles[actorId];
  const defenderStyle = session.styles[defenderId];
  const round = Math.max(1, Math.ceil(session.turnNumber / 2));

  if (action === 'guard') {
    const guardAmount = 16 + Math.floor(actorPower.defense * 1.2) + actorStyle.defenseBonus + randomInt(0, Math.max(2, Math.floor(actorPower.luck * 0.5)));
    session.shields[actorId] = Math.min(999, (session.shields[actorId] || 0) + guardAmount);
    return `${getBattleDisplayName(actorId, records)}님이 방어 자세를 잡았습니다. 다음 피해를 ${guardAmount}만큼 흡수합니다.`;
  }

  const luckRoll = randomInt(0, Math.max(1, Math.floor((actorPower.luck + actorStyle.luckBonus) * 0.55)));
  const evolution = pickBattleEvolution(actorStyle, round - 1, luckRoll);
  const definition = evolution.definition;
  const isUltimate = action === 'ultimate';

  if (isUltimate && session.ultimateUsed[actorId]) {
    return `${getBattleDisplayName(actorId, records)}님은 이미 궁극기를 사용했습니다. 짧은 견제로 턴을 넘깁니다.`;
  }

  const actionConfig = {
    attack: {
      label: '기본 공격',
      baseMin: 10,
      baseMax: 20,
      multiplier: 0.85,
      bonus: 0,
      name: definition.attack,
      motion: definition.motion,
    },
    skill: {
      label: '기술',
      baseMin: 14,
      baseMax: 30,
      multiplier: 1.1,
      bonus: 4,
      name: definition.attack,
      motion: definition.motion,
    },
    ultimate: {
      label: '궁극기',
      baseMin: 24,
      baseMax: 45,
      multiplier: 1.65,
      bonus: 14,
      name: definition.ultimate,
      motion: definition.ultimateMotion,
    },
  }[action] || {
    label: '기본 공격',
    baseMin: 10,
    baseMax: 20,
    multiplier: 0.85,
    bonus: 0,
    name: definition.attack,
    motion: definition.motion,
  };

  const evolutionLevel = Math.max(1, (evolution.level || 1) + (evolution.enhanceLevel || 0));
  const rawDamage = randomInt(actionConfig.baseMin, actionConfig.baseMax)
    + Math.floor(actorPower.attack * 1.35)
    + actorStyle.attackBonus
    + evolutionLevel * (isUltimate ? 3 : 1)
    + luckRoll
    + actionConfig.bonus;
  const mitigation = Math.floor((defenderPower.defense * 0.85) + (defenderStyle.defenseBonus * 0.7));
  const beforeShieldDamage = Math.max(1, Math.floor(rawDamage * actionConfig.multiplier) - mitigation);
  const shield = Math.max(0, Math.floor(session.shields[defenderId] || 0));
  const shieldUsed = Math.min(shield, beforeShieldDamage);
  const damage = Math.max(0, beforeShieldDamage - shieldUsed);

  session.shields[defenderId] = Math.max(0, shield - shieldUsed);
  session.hp[defenderId] = Math.max(0, Math.floor(session.hp[defenderId] || 0) - damage);
  if (isUltimate) {
    session.ultimateUsed[actorId] = true;
  }

  const shieldText = shieldUsed > 0 ? ` 방어막이 ${shieldUsed} 피해를 흡수했습니다.` : '';
  return [
    `${getBattleDisplayName(actorId, records)} ${formatItemGradeLabel(evolution.grade)} ${evolution.name} Lv.${evolutionLevel}`,
    `${actionConfig.label}: ${actionConfig.name}`,
    actionConfig.motion,
    `<@${defenderId}>에게 ${damage} 피해.${shieldText}`,
  ].join('\n');
}

function finishBattleSession(session) {
  if (session.hp[session.challengerId] === session.hp[session.opponentId]) {
    const challengerScore = getPowerScore(session.powers[session.challengerId])
      + session.styles[session.challengerId].luckBonus
      + randomInt(1, 30);
    const opponentScore = getPowerScore(session.powers[session.opponentId])
      + session.styles[session.opponentId].luckBonus
      + randomInt(1, 30);
    session.winnerId = challengerScore >= opponentScore ? session.challengerId : session.opponentId;
  } else {
    session.winnerId = session.hp[session.challengerId] > session.hp[session.opponentId]
      ? session.challengerId
      : session.opponentId;
  }

  session.loserId = getBattleOpponentId(session, session.winnerId);
  session.status = 'finished';
  session.updatedAt = Date.now();
  battleSessions.delete(session.id);
  return session;
}

function advanceBattleTurn(session, actorId, action) {
  const resultText = resolveBattleAction(session, actorId, action);
  const defenderId = getBattleOpponentId(session, actorId);
  session.log.push(resultText);
  session.updatedAt = Date.now();

  if (session.hp[defenderId] <= 0 || session.turnNumber >= battleMaxTurns) {
    return finishBattleSession(session);
  }

  session.turnUserId = defenderId;
  session.turnNumber += 1;
  return session;
}

function createBattleTurnEmbed(session, finalResult = null) {
  const isFinished = session.status === 'finished' || finalResult;
  const embed = createUiEmbed({
    color: isFinished ? uiTheme.colors.success : uiTheme.colors.battle,
    title: isFinished ? '결투 종료' : `턴제 결투 ${session.turnNumber}/${battleMaxTurns}`,
    description: [
      `<@${session.challengerId}> vs <@${session.opponentId}>`,
      session.wager > 0 ? `판돈 ${formatCoins(session.wager)}씩 / 총 ${formatCoins(session.wager * 2)}` : '판돈 없음',
    ].join('\n'),
  });

  embed.addFields(
    {
      name: '체력',
      value: [
        createBattleHpLine(session, session.challengerId),
        createBattleHpLine(session, session.opponentId),
      ].join('\n'),
      inline: false,
    },
    {
      name: '선택 무기',
      value: [
        `<@${session.challengerId}> ${getSessionEvolutionSummary(session.styles[session.challengerId])}`,
        `<@${session.opponentId}> ${getSessionEvolutionSummary(session.styles[session.opponentId])}`,
      ].join('\n\n'),
      inline: false,
    },
    {
      name: isFinished ? '결과' : '현재 턴',
      value: isFinished
        ? `<@${finalResult?.winnerId || session.winnerId}> 승리${session.wager > 0 ? ` / 상금 ${formatCoins(finalResult?.payout || session.wager * 2)}` : ''}`
        : `<@${session.turnUserId}>님이 행동을 선택할 차례입니다.`,
      inline: false,
    },
    {
      name: '중계 로그',
      value: truncateText(session.log.slice(-5).join('\n\n'), 1024),
      inline: false,
    },
  );

  if (!isFinished) {
    embed.addFields({
      name: '행동 버튼',
      value: '공격: 안정적 피해 / 기술: 높은 피해 / 궁극기: 1회 사용 / 방어: 보호막 생성',
      inline: false,
    });
  }

  if (isFinished && finalResult?.durabilityLoss) {
    embed.addFields({
      name: '내구도 감소',
      value: [
        `<@${finalResult.winnerId}> 선택 무기 ${finalResult.durabilityLoss.winnerItemsChanged}개 -${finalResult.durabilityLoss.winner}`,
        `<@${finalResult.loserId}> 선택 무기 ${finalResult.durabilityLoss.loserItemsChanged}개 -${finalResult.durabilityLoss.loser}`,
      ].join('\n'),
      inline: false,
    });
  }

  return embed;
}

function createBattleTurnComponents(session) {
  if (session.status !== 'active') {
    return [];
  }

  const ultimateDisabled = Boolean(session.ultimateUsed[session.turnUserId]);
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(battleCustomId('move', session.id, 'attack'))
        .setLabel('기본 공격')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(battleCustomId('move', session.id, 'skill'))
        .setLabel('전투 기술')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(battleCustomId('move', session.id, 'ultimate'))
        .setLabel('궁극기')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(ultimateDisabled),
      new ButtonBuilder()
        .setCustomId(battleCustomId('move', session.id, 'guard'))
        .setLabel('방어 태세')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function getInventoryItems(user) {
  const inventory = user.inventory && typeof user.inventory === 'object' ? user.inventory : {};
  return Object.entries(inventory)
    .map(([key, rawItem]) => {
      if (typeof rawItem === 'number') {
        return {
          key,
          name: key,
          count: Math.max(0, Math.floor(rawItem)),
          bestValue: 0,
          totalValue: 0,
          weight: null,
        };
      }

      const item = rawItem && typeof rawItem === 'object' ? rawItem : {};
      const count = Number.isFinite(item.count) ? Math.max(0, Math.floor(item.count)) : 0;
      const bestValue = Number.isFinite(item.bestValue)
        ? Math.max(0, Math.floor(item.bestValue))
        : Math.max(0, Math.floor(item.value || 0));

      return {
        key,
        name: item.name || key,
        count,
        bestValue,
        totalValue: Number.isFinite(item.totalValue) ? Math.max(0, Math.floor(item.totalValue)) : bestValue * count,
        weight: Number.isFinite(item.weight) ? item.weight : null,
        lastFoundAt: item.lastFoundAt || null,
      };
    })
    .filter((item) => item.count > 0)
    .sort((a, b) => b.bestValue - a.bestValue || b.count - a.count || a.name.localeCompare(b.name, 'ko-KR'));
}

function addInventoryItem(user, reward) {
  user.inventory ||= {};
  const key = normalizeKey(reward.label);
  const existing = user.inventory[key];
  const current = existing && typeof existing === 'object'
    ? existing
    : { name: reward.label, count: Number.isFinite(existing) ? Math.max(0, Math.floor(existing)) : 0 };
  const bestValue = Math.max(
    Number.isFinite(current.bestValue) ? current.bestValue : 0,
    Number.isFinite(current.value) ? current.value : 0,
    reward.amount,
  );

  user.inventory[key] = {
    name: reward.label,
    count: Math.max(0, Math.floor(current.count || 0)) + 1,
    bestValue: Math.floor(bestValue),
    totalValue: Math.max(0, Math.floor(current.totalValue || 0)) + reward.amount,
    weight: reward.weight ?? current.weight ?? null,
    lastFoundAt: new Date().toISOString(),
  };

  return user.inventory[key];
}

function findInventoryItem(user, rawName) {
  const wanted = normalizeKey(rawName);
  return getInventoryItems(user).find((item) => item.key === wanted || normalizeKey(item.name) === wanted);
}

function getItemSynthesisStep(sourceGradeKey) {
  return itemSynthesisGradeSteps.find((step) => step.source === sourceGradeKey) || null;
}

function getSynthesisMaterialItems(user, sourceGradeKey) {
  return getInventoryItems(user)
    .filter((item) => getItemGradeConfig(getItemEvolution(item.name).grade).key === sourceGradeKey)
    .sort((a, b) =>
      a.bestValue - b.bestValue
      || a.count - b.count
      || a.name.localeCompare(b.name, 'ko-KR')
    );
}

function removeInventoryItemCount(user, item, count) {
  const current = user.inventory?.[item.key];
  const removeCount = Math.max(1, Math.floor(count));

  if (current && typeof current === 'object') {
    current.count = Math.max(0, Math.floor(current.count || 0) - removeCount);
    if (current.count <= 0) {
      delete user.inventory[item.key];
    }
    return;
  }

  if (Number.isFinite(current)) {
    const remaining = Math.max(0, Math.floor(current) - removeCount);
    if (remaining > 0) {
      user.inventory[item.key] = remaining;
    } else {
      delete user.inventory[item.key];
    }
  }
}

function consumeSynthesisMaterials(user, sourceGradeKey) {
  const materialItems = getSynthesisMaterialItems(user, sourceGradeKey);
  const available = materialItems.reduce((sum, item) => sum + item.count, 0);
  if (available < itemSynthesisRequirement) {
    return {
      ok: false,
      consumed: [],
      missing: itemSynthesisRequirement - available,
      available,
    };
  }

  let remaining = itemSynthesisRequirement;
  const consumed = [];

  for (const item of materialItems) {
    if (remaining <= 0) {
      break;
    }

    const count = Math.min(item.count, remaining);
    removeInventoryItemCount(user, item, count);
    consumed.push({
      name: item.name,
      count,
    });
    remaining -= count;
  }

  return {
    ok: remaining <= 0,
    consumed,
    missing: Math.max(0, remaining),
    available,
  };
}

function pickSynthesisRewardItem(targetGradeKey) {
  const candidates = listFishingItems(economyMultiplier)
    .filter((item) => item.grade.key === targetGradeKey);

  if (candidates.length === 0) {
    return null;
  }

  const totalWeight = candidates.reduce((sum, item) => sum + item.weight, 0);
  let roll = Math.random() * totalWeight;

  for (const item of candidates) {
    roll -= item.weight;
    if (roll <= 0) {
      return item;
    }
  }

  return candidates[candidates.length - 1];
}

function getItemPowerGain(item) {
  const value = Math.max(1, item.bestValue || Math.floor((item.totalValue || 0) / Math.max(1, item.count)));
  const tier = Math.max(1, Math.floor(Math.sqrt(value) / 10));
  const evolution = getItemEvolution(item.name);
  const bias = getEvolutionStatBias(evolution);
  const gains = {
    attack: 1 + Math.max(0, bias.attack) * tier,
    defense: 1 + Math.max(0, bias.defense) * tier,
    luck: 1 + Math.max(0, bias.luck) * tier,
  };

  return {
    ...gains,
    evolution,
  };
}

function applyItemEvolution(user, item, evolution, uses = 1) {
  const useCount = Math.max(1, Math.floor(uses));
  user.evolutions ||= {};
  const current = user.evolutions[item.key] && typeof user.evolutions[item.key] === 'object'
    ? user.evolutions[item.key]
    : {};
  const level = Math.max(0, Math.floor(current.level || 0)) + useCount;
  const enhanceLevel = Number.isFinite(current.enhanceLevel) ? Math.max(0, Math.floor(current.enhanceLevel)) : 0;
  const grade = getItemGradeConfig(evolution.grade);
  const maxDurability = Number.isFinite(current.maxDurability)
    ? Math.max(1, Math.floor(current.maxDurability))
    : grade.maxDurability;

  user.evolutions[item.key] = {
    itemName: item.name,
    name: evolution.evolution,
    grade: grade.key,
    level,
    enhanceLevel,
    durability: maxDurability,
    maxDurability,
    enhanceAttempts: Math.max(0, Math.floor(current.enhanceAttempts || 0)),
    enhanceSuccesses: Math.max(0, Math.floor(current.enhanceSuccesses || 0)),
    enhancePowerBonus: current.enhancePowerBonus || { attack: 0, defense: 0, luck: 0 },
    used: Math.max(0, Math.floor(current.used || 0)) + useCount,
    attack: evolution.attack,
    ultimate: evolution.ultimate,
    lastUsedAt: new Date().toISOString(),
  };

  return user.evolutions[item.key];
}

function findUserEvolution(user, rawName) {
  const wanted = normalizeKey(rawName);
  return getUserEvolutions(user).find((evolution) =>
    evolution.key === wanted
    || normalizeKey(evolution.itemName) === wanted
    || normalizeKey(evolution.name) === wanted
  );
}

function createAutocompleteChoices(items, focusedValue, buildChoice) {
  const query = normalizeKey(focusedValue);
  return items
    .map(buildChoice)
    .filter((choice) => choice?.name && choice?.value)
    .filter((choice) => {
      if (!query) {
        return true;
      }

      return normalizeKey(choice.name).includes(query) || normalizeKey(choice.value).includes(query);
    })
    .slice(0, 25)
    .map((choice) => ({
      name: truncateText(choice.name, 100),
      value: truncateText(choice.value, 100),
    }));
}

function getInventoryAutocompleteChoices(user, focusedValue) {
  return createAutocompleteChoices(getInventoryItems(user), focusedValue, (item) => {
    const grade = getItemGradeConfig(getItemEvolution(item.name).grade);
    return {
      name: `${formatItemGradeLabel(grade)} ${item.name} x${item.count}`,
      value: item.name,
    };
  });
}

function getEvolutionAutocompleteChoices(user, focusedValue, damagedOnly = false) {
  const evolutions = getUserEvolutions(user).filter((evolution) =>
    !damagedOnly || evolution.durability < evolution.maxDurability
  );

  return createAutocompleteChoices(evolutions, focusedValue, (evolution) => {
    const enhanceText = evolution.enhanceLevel > 0 ? ` +${evolution.enhanceLevel}` : '';
    return {
      name: `${formatItemGradeLabel(evolution.grade)} ${evolution.itemName}${enhanceText} ${evolution.durability}/${evolution.maxDurability}`,
      value: evolution.itemName,
    };
  });
}

function getShopAutocompleteChoices(focusedValue) {
  return createAutocompleteChoices(getShopItems(), focusedValue, (item) => ({
    name: `${formatItemGradeLabel(item.grade)} ${item.name} · ${formatCoins(item.price)}`,
    value: item.name,
  }));
}

function getEnhancementPowerGain(evolution) {
  const bias = getEvolutionStatBias(evolution.definition);
  const grade = evolution.grade?.key
    ? evolution.grade
    : getItemGradeConfig(evolution.grade || evolution.definition?.grade);
  const gain = {
    attack: Math.max(0, bias.attack) * grade.statGain,
    defense: Math.max(0, bias.defense) * grade.statGain,
    luck: Math.max(0, bias.luck) * grade.statGain,
  };

  if (gain.attack + gain.defense + gain.luck <= 0) {
    gain.attack = grade.statGain;
  }

  return gain;
}

function subtractPower(user, powerBonus = {}) {
  user.power.attack = Math.max(1, Math.floor((user.power.attack || 1) - (powerBonus.attack || 0)));
  user.power.defense = Math.max(1, Math.floor((user.power.defense || 1) - (powerBonus.defense || 0)));
  user.power.luck = Math.max(1, Math.floor((user.power.luck || 1) - (powerBonus.luck || 0)));
}

function applyBattleDurabilityLoss(user, amount, weaponKey = null) {
  const evolutions = user.evolutions && typeof user.evolutions === 'object' ? user.evolutions : {};
  let changed = 0;

  for (const [key, record] of Object.entries(evolutions)) {
    if (!record || typeof record !== 'object') {
      continue;
    }

    if (weaponKey && key !== weaponKey) {
      continue;
    }

    const definition = getItemEvolution(record.itemName);
    const grade = getItemGradeConfig(record.grade || definition.grade);
    record.maxDurability = Number.isFinite(record.maxDurability)
      ? Math.max(1, Math.floor(record.maxDurability))
      : grade.maxDurability;
    record.durability = Number.isFinite(record.durability)
      ? Math.max(0, Math.floor(record.durability))
      : record.maxDurability;
    const nextDurability = Math.max(0, record.durability - amount);
    if (nextDurability !== record.durability) {
      changed += 1;
    }
    record.durability = nextDurability;
  }

  return changed;
}

function createInventoryEmbed(target, user) {
  const items = getInventoryItems(user);
  const bestWeapon = getBestBattleWeapon(user);
  const stats = user.stats || {};
  const displayName = getDisplayName(target, user);
  const totalCount = items.reduce((sum, item) => sum + item.count, 0);
  const itemLines = items.length > 0
    ? items.slice(0, 12).map((item, index) => {
      const grade = getItemGradeConfig(getItemEvolution(item.name).grade);
      const valueText = item.bestValue > 0 ? `최고 ${formatCoins(item.bestValue)}` : '가치 미기록';
      return `${index + 1}. ${formatItemGradeLabel(grade)} ${item.name} x${item.count} · ${valueText} · 사용 ${formatChance(getItemUseChance(grade.key))}`;
    }).join('\n')
    : '아직 보관함이 비어 있습니다. `/낚시`로 첫 아이템을 잡아보세요.';

  const embed = createUiEmbed({
    color: uiTheme.colors.inventory,
    title: `${displayName}님의 보관함`,
    description: `총 ${items.length}종 / ${totalCount}개 보유`,
  })
    .addFields(
      {
        name: '낚시 아이템',
        value: truncateText(itemLines, 1024),
        inline: false,
      },
      {
        name: '성장 요약',
        value: [
          bestWeapon
            ? `대표 무기: ${formatItemGradeLabel(bestWeapon.evolution.grade)} ${bestWeapon.evolution.itemName} · ${formatStatLine(bestWeapon.power)}`
            : '대표 무기: 전투 가능 무기 없음',
          `방지권: ${user.protectionTickets || 0}장`,
          `아이템 사용: ${stats.itemsUsed || 0}회`,
          `상점 구매: ${stats.itemShopPurchases || 0}개 / 수리 ${stats.itemRepairCount || 0}회`,
        ].join('\n'),
        inline: false,
      },
      {
        name: '진화',
        value: truncateText(formatEvolutionSummary(user, 5), 1024),
        inline: false,
      },
      {
        name: '전투 기록',
        value: `${stats.battlesWon || 0}승 ${stats.battlesLost || 0}패 / 수익 ${formatCoins(stats.battleProfit || 0)}`,
        inline: true,
      },
      {
        name: '강화 기록',
        value: `${stats.itemEnhanceSuccesses || 0}/${stats.itemEnhanceAttempts || 0} 성공 / 사용 ${formatCoins(stats.itemEnhanceSpent || 0)}`,
        inline: true,
      },
    );

  if (items.length > 12) {
    embed.setFooter({ text: `${uiTheme.footer} · 총 ${items.length}종 중 가치 높은 12종 표시` });
  }

  return embed;
}

function createItemRatesEmbed() {
  const gradeRates = listItemGradeDropRates();
  const protectionChance = getFishingProtectionTicketChance();
  const failureChance = getFishingFailureChance();
  const gradeLines = gradeRates
    .map((rate) => [
      `${formatItemGradeLabel(rate.grade)} ${formatChance(rate.chance)}`,
      `아이템 풀 기준 ${formatChance(rate.itemPoolChance)} · ${rate.itemCount}종`,
    ].join(' · '))
    .join('\n');
  const useLines = gradeRates
    .map((rate) => `${formatItemGradeLabel(rate.grade)} ${formatChance(getItemUseChance(rate.grade.key))}`)
    .join('\n');

  return createUiEmbed({
    color: uiTheme.colors.inventory,
    title: '아이템 등급별 낚시 확률',
    description: '아래 확률은 `/낚시` 1회 기준입니다.',
  })
    .addFields(
      { name: '등급별 확률', value: gradeLines || '확률 정보가 없습니다.', inline: false },
      { name: '아이템 사용 성공률', value: useLines || '확률 정보가 없습니다.', inline: false },
      { name: '특수 획득', value: `강화 방지권 ${formatChance(protectionChance)}`, inline: true },
      { name: '실패', value: `빈손 ${formatChance(failureChance)}`, inline: true },
    );
}

function createShopEmbed(user) {
  const shopItems = getShopItems();
  const grouped = new Map();

  for (const item of shopItems) {
    const key = item.grade.key;
    const current = grouped.get(key) || {
      grade: item.grade,
      lines: [],
    };
    current.lines.push(`${item.name} · ${formatCoins(item.price)}`);
    grouped.set(key, current);
  }

  const embed = createUiEmbed({
    color: uiTheme.colors.economy,
    title: '아이템 상점',
    description: [
      `보유 잔액: ${formatCoins(user.balance || 0)}`,
      '상점 아이템은 낚시 평균 가치보다 비싸게 판매됩니다.',
      '강화 방지권은 구매 즉시 방지권 보유량에 추가됩니다.',
    ].join('\n'),
  });

  for (const group of grouped.values()) {
    embed.addFields({
      name: formatItemGradeLabel(group.grade),
      value: truncateText(group.lines.join('\n'), 1024),
      inline: false,
    });
  }

  return embed;
}

function createItemPurchaseEmbed({ user, item, quantity, totalCost, balance, inventoryItem, protectionTickets }) {
  const embed = createUiEmbed({
    color: getItemGradeColor(item.grade, uiTheme.colors.economy),
    title: '아이템 구매 완료',
    description: `${user}님이 **${formatItemGradeLabel(item.grade)} ${item.name}** ${quantity}개를 구매했습니다.`,
  })
    .addFields(
      { name: '결제 금액', value: formatCoins(totalCost), inline: true },
      { name: '남은 잔액', value: formatCoins(balance), inline: true },
    );

  if (item.protectionTicket) {
    embed.addFields({ name: '보유 방지권', value: `${protectionTickets || quantity}장`, inline: true });
  } else {
    embed.addFields({ name: '보관 수량', value: `${inventoryItem?.count || quantity}개`, inline: true });
  }

  return embed;
}

function createItemSynthesisEmbed({ user, sourceGrade, targetGrade, consumed, rewardItem, inventoryItem }) {
  const consumedLines = consumed
    .map((item) => `${item.name} x${item.count}`)
    .join('\n');

  return createUiEmbed({
    color: getItemGradeColor(targetGrade, uiTheme.colors.success),
    title: '아이템 합성 완료',
    description: `${user}님이 ${formatItemGradeLabel(sourceGrade)} 아이템 ${itemSynthesisRequirement}개를 합성해 **${formatItemGradeLabel(targetGrade)} ${rewardItem.name}** 1개를 얻었습니다.`,
  })
    .addFields(
      { name: '소모 재료', value: truncateText(consumedLines, 1024), inline: false },
      { name: '획득 아이템', value: `${rewardItem.name} x${inventoryItem?.count || 1}`, inline: true },
      { name: '합성 단계', value: `${sourceGrade.label} -> ${targetGrade.label}`, inline: true },
    );
}

function createItemRepairEmbed({ user, evolution, cost, balance, previousDurability, nextDurability }) {
  const grade = normalizeGradeConfig(evolution.grade);
  return createUiEmbed({
    color: getItemGradeColor(grade, uiTheme.colors.success),
    title: '아이템 수리 완료',
    description: `${user}님이 **${formatItemGradeLabel(grade)} ${evolution.itemName}**을 수리했습니다.`,
  })
    .addFields(
      { name: '내구도', value: `${previousDurability}/${evolution.maxDurability} -> ${nextDurability}/${evolution.maxDurability}`, inline: false },
      { name: '수리 비용', value: formatCoins(cost), inline: true },
      { name: '남은 잔액', value: formatCoins(balance), inline: true },
    );
}

function createItemUseEmbed({
  user,
  item,
  gain,
  weaponPower,
  remaining,
  evolutionRecord,
  usedCount = 1,
  successCount = 0,
  failedCount = 0,
  useChance,
}) {
  const evolution = gain?.evolution || getItemEvolution(item.name);
  const grade = getItemGradeConfig(evolutionRecord?.grade || evolution.grade);
  const success = successCount > 0 && evolutionRecord;
  const usedLabel = usedCount > 1 ? `${usedCount}개를 사용해` : '1개를 사용해';
  const embed = createUiEmbed({
    color: success ? getItemGradeColor(grade, uiTheme.colors.success) : uiTheme.colors.danger,
    title: success ? '아이템 진화 성공' : '아이템 사용 실패',
    description: success
      ? `${user}님이 **${formatItemGradeLabel(grade)} ${item.name}** ${usedLabel} **${evolutionRecord.name} Lv.${evolutionRecord.level}**로 진화했습니다.`
      : `${user}님이 **${formatItemGradeLabel(grade)} ${item.name}** ${usedLabel}했지만 진화에 실패했습니다.`,
  }).addFields(
    { name: '사용 결과', value: `성공 ${successCount}개 / 실패 ${failedCount}개`, inline: true },
    { name: '사용 확률', value: formatChance(useChance), inline: true },
    { name: '남은 아이템', value: `${remaining}개`, inline: true },
  );

  if (!success) {
    embed.addFields({
      name: '처리',
      value: '사용한 아이템은 소모됐고 진화 레벨은 오르지 않았습니다.',
      inline: false,
    });
    return embed;
  }

  const enhanceLevel = Number.isFinite(evolutionRecord.enhanceLevel)
    ? Math.max(0, Math.floor(evolutionRecord.enhanceLevel))
    : 0;
  const nextCost = getItemEnhancementCost(grade.key, enhanceLevel);
  const nextRates = getItemEnhancementRates(grade.key, enhanceLevel);

  embed.addFields(
    { name: '무기 성장', value: `레벨 +${successCount} / 현재 Lv.${evolutionRecord.level}`, inline: false },
    { name: '전투 능력', value: formatStatLine(weaponPower), inline: false },
    { name: '전투 기술', value: `${evolution.attack}\n궁극기: ${evolution.ultimate}`, inline: false },
    { name: '다음 강화', value: `${formatCoins(nextCost)} / ${formatEnhancementRates(nextRates)}`, inline: false },
  );

  return embed;
}

function createItemEnhanceEmbed({
  user,
  evolution,
  success,
  chance,
  rates,
  cost,
  previousLevel,
  nextLevel,
  protectedByTicket,
  destroyed,
  protectionTickets,
  weaponPower,
  gain,
  balance,
}) {
  const grade = evolution.grade || getItemGradeConfig(evolution.definition.grade);
  const displayRates = rates || {
    successChance: chance,
    failureChance: destroyed ? 0 : Math.max(0, 1 - chance),
    destructionChance: destroyed ? Math.max(0, 1 - chance) : 0,
  };
  const color = success
    ? getItemGradeColor(grade, uiTheme.colors.success)
    : destroyed
      ? uiTheme.colors.danger
      : uiTheme.colors.warning;
  const currentLevel = destroyed ? 0 : nextLevel;
  const nextCost = destroyed ? null : getItemEnhancementCost(grade.key, currentLevel);
  const nextRates = destroyed ? null : getItemEnhancementRates(grade.key, currentLevel);
  const resultText = success
    ? `+${previousLevel} -> +${nextLevel}`
    : protectedByTicket
      ? `+${previousLevel} 유지`
      : destroyed
        ? `+${previousLevel} -> 파괴`
        : `+${previousLevel} 유지`;
  const embed = createUiEmbed({
    color,
    title: success
      ? '아이템 강화 성공'
      : protectedByTicket
        ? '강화 실패 - 방지권 발동'
        : destroyed
          ? '강화 실패 - 아이템 파괴'
          : '아이템 강화 실패',
    description: `${user}님이 **${formatItemGradeLabel(grade)} ${evolution.itemName}** 강화에 도전했습니다.`,
  })
    .addFields(
      { name: '결과', value: resultText, inline: true },
      { name: '도전 확률', value: formatEnhancementRates(displayRates), inline: false },
      { name: '소모 노코인', value: formatCoins(cost), inline: true },
      { name: '보유 상태', value: `잔액 ${formatCoins(balance)}\n방지권 ${protectionTickets || 0}장`, inline: false },
    );

  if (success) {
    embed.addFields(
      { name: '강화 성장치', value: `공격 계수 +${gain.attack} / 방어 계수 +${gain.defense} / 행운 계수 +${gain.luck}`, inline: false },
      { name: '현재 무기 전투 능력', value: weaponPower ? formatStatLine(weaponPower) : '무기 파괴', inline: false },
    );
  } else {
    embed.addFields({
      name: '처리',
      value: protectedByTicket
        ? '방지권이 즉시 사용되어 아이템 파괴와 레벨 초기화를 막았습니다.'
        : destroyed
          ? '방지권이 없어 아이템 진화가 삭제되었습니다. 다시 사용하려면 같은 아이템을 `/아이템사용`으로 해금해야 합니다.'
          : '아이템은 유지됐지만 강화 단계는 오르지 않았습니다.',
      inline: false,
    });
  }

  if (!destroyed) {
    embed.addFields({
      name: '다음 강화',
      value: `${formatCoins(nextCost)} / ${formatEnhancementRates(nextRates)}`,
      inline: false,
    });
  }

  return embed;
}

function createItemEnhanceConfirmEmbed({
  user,
  evolution,
  cost,
  balance,
  previousLevel,
  rates,
  protectionTickets,
}) {
  const grade = evolution.grade || getItemGradeConfig(evolution.definition.grade);
  const nextLevel = previousLevel + 1;
  const safeText = rates.destructionChance <= 0
    ? '현재 단계는 파괴되지 않고 실패만 발생합니다.'
    : '파괴 판정이 나면 방지권이 있을 때 자동으로 1장을 사용합니다.';

  return createUiEmbed({
    color: getItemGradeColor(grade, uiTheme.colors.warning),
    title: '아이템 강화 확인',
    description: `${user}님, **${formatItemGradeLabel(grade)} ${evolution.itemName}** +${previousLevel} -> +${nextLevel} 강화를 진행할까요?`,
  })
    .addFields(
      { name: '강화 비용', value: formatCoins(cost), inline: true },
      { name: '현재 잔액', value: formatCoins(balance), inline: true },
      { name: '강화 확률', value: formatEnhancementRates(rates), inline: false },
      { name: '파괴 규칙', value: safeText, inline: false },
      { name: '보유 방지권', value: `${protectionTickets || 0}장`, inline: true },
    );
}

function createItemEnhanceConfirmComponents(requestId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(itemEnhanceCustomId('confirm', requestId))
        .setLabel('강화하기')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(itemEnhanceCustomId('cancel', requestId))
        .setLabel('취소')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function createWaterGunShotArt(distance) {
  const maxDistance = 1900;
  const size = 24;
  const filled = distance > 0
    ? Math.min(size, Math.max(1, Math.round((distance / maxDistance) * size)))
    : 0;
  return `발사대 |${'='.repeat(filled)}>${'.'.repeat(size - filled)}| ${formatWaterGunDistance(distance)}`;
}

function createWaterGunEmbed(stage, payload = {}) {
  if (stage === 'ready') {
    return createUiEmbed({
      color: uiTheme.colors.primary,
      title: '발사 준비',
      description: `${payload.user}님이 **${payload.picked.label}**에게 ${formatCoins(payload.wager)}을 걸었습니다.`,
    }).addFields(
      { name: '참가자', value: waterGunContestants.map((contestant) => contestant.label).join(' / '), inline: true },
      { name: '지급 배율', value: '적중 시 3배', inline: true },
      { name: '카지노 적중률', value: formatChance(casinoWinChances.waterGun), inline: true },
      { name: '진행', value: '초야부터 한 명씩 정액을 발사합니다.', inline: false },
    );
  }

  if (stage === 'shot') {
    const shot = payload.shot;
    const best = payload.best;
    return createUiEmbed({
      color: uiTheme.colors.inventory,
      title: `${shot.order}번째 발사 - ${shot.label}`,
      description: [
        shot.motion,
        '',
        '```',
        createWaterGunShotArt(shot.distance),
        '```',
      ].join('\n'),
    }).addFields(
      { name: '이번 기록', value: formatWaterGunDistance(shot.distance), inline: true },
      { name: '현재 1등', value: `${best.label} · ${formatWaterGunDistance(best.distance)}`, inline: true },
      { name: '내 선택', value: payload.picked.label, inline: true },
    );
  }

  const contest = payload.contest;
  const resultLines = contest.results
    .map((entry, index) =>
      `${index + 1}. ${entry.label} ${formatWaterGunDistance(entry.distance)} - ${entry.motion}`,
    )
    .join('\n');

  return createUiEmbed({
    color: payload.didWin ? uiTheme.colors.success : uiTheme.colors.danger,
    title: '사정 대회 결과',
    description: payload.didWin
      ? `${payload.user}님의 예측이 맞았습니다. ${contest.winner.label}이 가장 멀리 쐈습니다.`
      : `${payload.user}님의 예측이 빗나갔습니다. 이번 우승은 ${contest.winner.label}입니다.`,
  })
    .addFields(
      { name: '내 선택', value: payload.picked.label, inline: true },
      { name: '우승', value: `${contest.winner.label} · ${formatWaterGunDistance(contest.winner.distance)}`, inline: true },
      { name: '지급', value: formatCoins(payload.result.payout), inline: true },
      { name: '발사 기록', value: truncateText(resultLines, 1024), inline: false },
      { name: '현재 잔액', value: formatCoins(payload.result.balance), inline: true },
    );
}

function createFishingEmbed(stage, payload = {}) {
  const scenes = {
    cast: {
      color: uiTheme.colors.primary,
      title: '낚시 시작',
      text: '낚싯줄을 물가 깊숙이 던졌습니다.',
      art: [
        '      |',
        '      |',
        '~~~~~~|~~~~~~~~~~~~',
        '      J',
        '~~~~~~~~~~~~~~~~~~~',
      ].join('\n'),
    },
    bite: {
      color: uiTheme.colors.economy,
      title: '입질 감지',
      text: '수면 아래에서 무언가 낚싯줄을 강하게 잡아당깁니다.',
      art: [
        '      |',
        '      |   입질',
        '~~~~~~|~~><>~~~~~~',
        '      J',
        '~~~~~~~~~~~~~~~~~~~',
      ].join('\n'),
    },
    pull: {
      color: 0xe67e22,
      title: '끌어올리는 중',
      text: '줄이 끊어지지 않게 힘을 조절하며 천천히 끌어올립니다.',
      art: [
        '     \\|/',
        '      |',
        '~~~~~~|~~~~~~~~~~~~',
        '     /J\\',
        '~~~~~~~~~~><>~~~~~~',
      ].join('\n'),
    },
    caught: {
      color: uiTheme.colors.success,
      title: '잡혔다!',
      text: `${payload.user}님이 **${payload.reward?.label || '무언가'}**을 낚았습니다.`,
      art: [
        '      |',
        '      |',
        '~~~~~~|~~~~~~~~~~~~',
        '     /J\\   예아',
        '~~~~><>~~~~~~~~~~~~',
      ].join('\n'),
    },
    failed: {
      color: uiTheme.colors.muted,
      title: '낚시 실패',
      text: `${payload.user}님의 낚싯바늘이 텅 비어 있었습니다.`,
      art: [
        '      |',
        '      |',
        '~~~~~~|~~~~~~~~~~~~',
        '      J   ...',
        '~~~~~~~~~~~~~~~~~~~',
      ].join('\n'),
    },
  };
  const scene = scenes[stage] || scenes.cast;
  const embed = createUiEmbed({
    color: scene.color,
    title: scene.title,
    description: `${scene.text}\n\n\`\`\`\n${scene.art}\n\`\`\``,
  });

  if ((stage === 'caught' || stage === 'failed') && payload.reward) {
    if (payload.reward.failed) {
      embed.addFields(
        { name: '결과', value: '아무것도 얻지 못했습니다.', inline: false },
        { name: '실패 확률', value: formatChance(getFishingFailureChance()), inline: true },
        { name: '현재 잔액', value: formatCoins(payload.balance), inline: true },
      );
    } else if (payload.reward.protectionTicket) {
      embed.addFields(
        { name: '특수 획득', value: '강화 실패 시 자동으로 아이템 파괴를 막는 방지권을 얻었습니다.', inline: false },
        { name: '보유 방지권', value: `${payload.protectionTickets || 0}장`, inline: true },
        { name: '현재 잔액', value: formatCoins(payload.balance), inline: true },
      );
    } else {
      embed.addFields(
        { name: '획득 가치', value: formatCoins(payload.reward.amount), inline: true },
        { name: '보관함 추가', value: `${payload.inventoryItem?.name || payload.reward.label} x${payload.inventoryItem?.count || 1}`, inline: true },
        { name: '현재 잔액', value: formatCoins(payload.balance), inline: true },
      );
    }
  }

  return embed;
}

function createBattleChallengeEmbed(challenge) {
  const weaponKeys = challenge.weaponKeys || {};
  const embed = createUiEmbed({
    color: uiTheme.colors.warning,
    title: '결투 신청',
    description: `<@${challenge.challengerId}>님이 <@${challenge.opponentId}>님에게 결투를 신청했습니다.`,
  })
    .addFields(
      { name: '도전자', value: `<@${challenge.challengerId}>`, inline: true },
      { name: '상대', value: `<@${challenge.opponentId}>`, inline: true },
      { name: '베팅 코인', value: challenge.wager > 0 ? formatCoins(challenge.wager) : '없음', inline: true },
      {
        name: '무기 선택',
        value: [
          `<@${challenge.challengerId}> ${weaponKeys[challenge.challengerId] ? '선택 완료' : '미선택'}`,
          `<@${challenge.opponentId}> ${weaponKeys[challenge.opponentId] ? '선택 완료' : '미선택'}`,
        ].join('\n'),
        inline: false,
      },
      { name: '수락 제한', value: '5분 안에 양쪽이 무기를 고른 뒤 상대가 수락할 수 있습니다.', inline: false },
    );

  return embed;
}

function createBattleChallengeComponents(challengeId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(battleCustomId('equip', challengeId))
        .setLabel('무기 선택')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(battleCustomId('accept', challengeId))
        .setLabel('결투 수락')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(battleCustomId('decline', challengeId))
        .setLabel('거절')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function createBattleWeaponSelectComponents(challengeId, user) {
  const options = getUserEvolutions(user)
    .filter((evolution) => evolution.durability > 0)
    .slice(0, 25)
    .map((evolution) => {
      const power = getWeaponBattlePower(evolution);
      const enhanceText = evolution.enhanceLevel > 0 ? ` +${evolution.enhanceLevel}` : '';
      return {
        label: truncateText(`${evolution.itemName}${enhanceText}`, 100),
        value: evolution.key,
        description: truncateText(`${evolution.grade.label} · 공격 ${power.attack} / 방어 ${power.defense} / 행운 ${power.luck}`, 100),
      };
    });

  if (options.length === 0) {
    return [];
  }

  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(battleCustomId('weapon', challengeId))
        .setPlaceholder('이번 결투에 사용할 무기 선택')
        .addOptions(options),
    ),
  ];
}

function getBattleDisplayName(userId, records) {
  const record = records[userId] || {};
  return record.displayName || record.username || `<@${userId}>`;
}

function simulateBattle(challenge, challengerRecord, opponentRecord) {
  const records = {
    [challenge.challengerId]: challengerRecord,
    [challenge.opponentId]: opponentRecord,
  };
  const challengerPower = getUserPower(challengerRecord);
  const opponentPower = getUserPower(opponentRecord);
  const challengerStyle = getBattleStyle(challengerRecord);
  const opponentStyle = getBattleStyle(opponentRecord);
  let challengerHp = 120 + challengerPower.defense * 10 + challengerStyle.defenseBonus * 4;
  let opponentHp = 120 + opponentPower.defense * 10 + opponentStyle.defenseBonus * 4;
  const rounds = [];

  for (let round = 1; round <= 4 && challengerHp > 0 && opponentHp > 0; round += 1) {
    const challengerMove = resolveBattleMove({
      attackerId: challenge.challengerId,
      defenderId: challenge.opponentId,
      records,
      attackerPower: challengerPower,
      defenderPower: opponentPower,
      attackerStyle: challengerStyle,
      defenderStyle: opponentStyle,
      round,
    });
    const opponentMove = resolveBattleMove({
      attackerId: challenge.opponentId,
      defenderId: challenge.challengerId,
      records,
      attackerPower: opponentPower,
      defenderPower: challengerPower,
      attackerStyle: opponentStyle,
      defenderStyle: challengerStyle,
      round,
    });

    opponentHp = Math.max(0, opponentHp - challengerMove.damage);
    challengerHp = Math.max(0, challengerHp - opponentMove.damage);
    rounds.push({
      round,
      challengerDamage: challengerMove.damage,
      opponentDamage: opponentMove.damage,
      challengerHp,
      opponentHp,
      text: [
        `${round}라운드`,
        challengerMove.text,
        opponentMove.text,
        `남은 체력: ${getBattleDisplayName(challenge.challengerId, records)} ${challengerHp} / ${getBattleDisplayName(challenge.opponentId, records)} ${opponentHp}`,
      ].join('\n'),
    });
  }

  let winnerId = challengerHp === opponentHp ? null : challengerHp > opponentHp ? challenge.challengerId : challenge.opponentId;
  if (!winnerId) {
    const challengerTiebreak = getPowerScore(challengerPower)
      + challengerStyle.attackBonus
      + challengerStyle.luckBonus
      + randomInt(1, 30);
    const opponentTiebreak = getPowerScore(opponentPower)
      + opponentStyle.attackBonus
      + opponentStyle.luckBonus
      + randomInt(1, 30);
    winnerId = challengerTiebreak >= opponentTiebreak ? challenge.challengerId : challenge.opponentId;
    rounds.push({
      round: rounds.length + 1,
      challengerDamage: 0,
      opponentDamage: 0,
      challengerHp,
      opponentHp,
      text: `연장 판정: 진화 숙련도와 집중력 싸움 끝에 ${getBattleDisplayName(winnerId, records)}님이 앞섰습니다.`,
    });
  }

  return {
    challengerPower,
    opponentPower,
    challengerStyle,
    opponentStyle,
    challengerHp,
    opponentHp,
    rounds,
    winnerId,
    loserId: winnerId === challenge.challengerId ? challenge.opponentId : challenge.challengerId,
  };
}

function createBattleBroadcastEmbed(challenge, battle, visibleRounds = 0, finalResult = null) {
  const embed = createUiEmbed({
    color: finalResult ? uiTheme.colors.success : uiTheme.colors.battle,
    title: finalResult ? '결투 종료' : '결투 중계',
    description: `<@${challenge.challengerId}> vs <@${challenge.opponentId}>`,
  });

  if (!battle) {
    embed.addFields({ name: '대기', value: '상대가 결투장에 들어오는 중입니다.', inline: false });
    return embed;
  }

  const roundLines = battle.rounds.slice(0, visibleRounds).map((round) => round.text);
  const challengerEvolution = formatEvolutionSummary(
    {
      evolutions: Object.fromEntries(
        battle.challengerStyle.evolutions.map((evolution) => [evolution.key, {
          itemName: evolution.itemName,
          name: evolution.name,
          level: evolution.level,
          enhanceLevel: evolution.enhanceLevel,
          grade: evolution.grade.key,
          used: evolution.used,
        }]),
      ),
    },
    3,
  );
  const opponentEvolution = formatEvolutionSummary(
    {
      evolutions: Object.fromEntries(
        battle.opponentStyle.evolutions.map((evolution) => [evolution.key, {
          itemName: evolution.itemName,
          name: evolution.name,
          level: evolution.level,
          enhanceLevel: evolution.enhanceLevel,
          grade: evolution.grade.key,
          used: evolution.used,
        }]),
      ),
    },
    3,
  );
  embed.addFields(
    {
      name: '전투력',
      value:
        `<@${challenge.challengerId}> 공격 ${battle.challengerPower.attack} / 방어 ${battle.challengerPower.defense} / 행운 ${battle.challengerPower.luck}\n`
        + `<@${challenge.opponentId}> 공격 ${battle.opponentPower.attack} / 방어 ${battle.opponentPower.defense} / 행운 ${battle.opponentPower.luck}`,
      inline: false,
    },
    {
      name: '진화 상태',
      value: truncateText(
        `<@${challenge.challengerId}>\n${challengerEvolution}\n\n<@${challenge.opponentId}>\n${opponentEvolution}`,
        1024,
      ),
      inline: false,
    },
    {
      name: '중계',
      value: roundLines.length > 0 ? truncateText(roundLines.join('\n\n'), 1024) : '첫 합을 준비하고 있습니다.',
      inline: false,
    },
  );

  if (finalResult) {
    embed.addFields(
      { name: '승자', value: `<@${finalResult.winnerId}>`, inline: true },
      { name: '상금', value: finalResult.payout > 0 ? formatCoins(finalResult.payout) : '없음', inline: true },
      { name: '최종 체력', value: `<@${challenge.challengerId}> ${battle.challengerHp} / <@${challenge.opponentId}> ${battle.opponentHp}`, inline: false },
    );
  }

  return embed;
}

function createBetEmbed(bet) {
  const pools = optionPools(bet);
  const total = totalBetPool(bet);
  const participantCount = countBetParticipants(bet);
  const isOpen = bet.status === 'open';
  const status = isOpen ? '진행 중' : `종료됨: ${bet.winner || '정답 없음'}`;
  const createdAt = getUnixTimestamp(bet.createdAt);
  const closedAt = getUnixTimestamp(bet.closedAt);
  const summaryLines = [
    `상태: **${status}**`,
    `총 판돈: **${formatCoins(total)}**`,
    `참여자: **${participantCount}명**`,
  ];

  if (createdAt) {
    summaryLines.push(`생성: <t:${createdAt}:R>`);
  }

  if (closedAt) {
    summaryLines.push(`종료: <t:${closedAt}:R>`);
  }

  const embed = createUiEmbed({
    color: isOpen ? uiTheme.colors.battle : uiTheme.colors.primary,
    title: `베팅 ${bet.id}`,
    description: `**${bet.topic}**`,
  })
    .addFields(
      bet.options.map((option) => ({
        name: truncateText(option.name, 256),
        value: [
          `${progressBar(pools[option.name] || 0, total)} ${formatPercent(pools[option.name] || 0, total)}`,
          `판돈 ${formatCoins(pools[option.name] || 0)} · 예상 배당 ${
            total > 0 && pools[option.name] > 0 ? `${(total / pools[option.name]).toFixed(2)}x` : '대기 중'
          }`,
        ].join('\n'),
        inline: true,
      })),
    )
    .addFields({
      name: '요약',
      value: summaryLines.join('\n'),
      inline: false,
    })
    .setFooter({ text: `${uiTheme.footer} · 생성자 ${bet.createdBy}` })
    .setTimestamp(new Date(bet.createdAt));

  if (bet.source?.type === 'polymarket') {
    const sourceEndDate = bet.source.endDate ? getUnixTimestamp(bet.source.endDate) : null;
    const sourceLines = [
      `시장 ID: \`${bet.source.marketId}\``,
      bet.source.url ? `[Polymarket에서 보기](${bet.source.url})` : null,
      sourceEndDate ? `종료 예정: <t:${sourceEndDate}:R>` : null,
      '실제 주문이 아닌 노코인 모의 베팅입니다.',
    ].filter(Boolean);

    embed.addFields({
      name: 'Polymarket',
      value: sourceLines.join('\n'),
      inline: false,
    });
  }

  return embed;
}

function createPolymarketMarketEmbed(market, charts = [], chartFileName = null) {
  const endDate = market.endDate ? getUnixTimestamp(market.endDate) : null;
  const outcomeLines = market.outcomes.map((outcome, index) => {
    const price = market.outcomePrices[index];
    return `**${truncateText(outcome, 80)}** · ${formatPolymarketPrice(price)}`;
  });
  const status = market.closed ? '종료됨' : market.active ? '진행 중' : '비활성';

  const embed = createUiEmbed({
    color: market.active ? uiTheme.colors.market : uiTheme.colors.muted,
    title: truncateText(market.question, 256),
    description: [
      `[Polymarket에서 보기](${market.url})`,
      '이 봇은 시장 정보만 가져오며 실제 Polymarket 주문은 넣지 않습니다.',
    ].join('\n'),
  })
    .addFields(
      {
        name: '선택지',
        value: outcomeLines.slice(0, 10).join('\n') || '선택지 없음',
        inline: false,
      },
      {
        name: '상태',
        value: [
          status,
          `거래량: $${Math.floor(market.volume).toLocaleString('en-US')}`,
          `유동성: $${Math.floor(market.liquidity).toLocaleString('en-US')}`,
          endDate ? `종료 예정: <t:${endDate}:R>` : null,
        ].filter(Boolean).join('\n'),
        inline: false,
      },
      {
        name: '최근 가격 차트',
        value: formatPolymarketChartField(charts),
        inline: false,
      },
      {
        name: '시장 ID',
        value: `\`${market.id}\``,
        inline: false,
      },
    )
    .setFooter({ text: `${uiTheme.footer} · 노코인 모의 베팅용 정보` });

  if (chartFileName) {
    embed.setImage(`attachment://${chartFileName}`);
  }

  return embed;
}

function createPolymarketMarketView(market, charts = []) {
  let chartFile = null;
  try {
    chartFile = createPolymarketChartFile(market, charts);
  } catch (error) {
    console.warn(`Failed to render Polymarket chart image: ${error.message}`);
  }

  return {
    embed: createPolymarketMarketEmbed(market, charts, chartFile?.fileName),
    files: chartFile ? [chartFile.attachment] : [],
  };
}

function createPolymarketSearchEmbed(query, markets) {
  const embed = createUiEmbed({
    color: uiTheme.colors.market,
    title: 'Polymarket 검색',
    description: `검색어: **${truncateText(query, 180)}**`,
  });

  embed.addFields(
    markets.map((market, index) => ({
      name: `${index + 1}. ${truncateText(market.question, 240)}`,
      value: [
        `ID: \`${market.id}\``,
        market.outcomes.map((outcome, outcomeIndex) => (
          `${truncateText(outcome, 40)} ${formatPolymarketPrice(market.outcomePrices[outcomeIndex])}`
        )).slice(0, 4).join(' · '),
      ].join('\n'),
      inline: false,
    })),
  );

  return embed;
}

function createPolymarketSearchComponents(markets) {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(polymarketCustomId('select'))
        .setPlaceholder('노코인 베팅으로 만들 시장 선택')
        .addOptions(
          markets.map((market, index) => ({
            label: truncateText(`${index + 1}. ${market.question}`, 100),
            value: market.id,
            description: truncateText(market.outcomes.slice(0, 3).join(' / '), 100),
          })),
        ),
    ),
  ];
}

function createPolymarketMarketComponents(market) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(polymarketCustomId('create', market.id))
        .setLabel('노코인 베팅 생성')
        .setStyle(ButtonStyle.Success)
        .setDisabled(!market.active || market.closed || market.outcomes.length < 2),
    ),
  ];
}

function createBetListEmbed(openBets) {
  const embed = createUiEmbed({
    color: uiTheme.colors.battle,
    title: '진행 중인 베팅',
    description: `열린 베팅 ${openBets.length}개`,
  });

  embed.addFields(
    openBets.map((bet) => {
      const total = totalBetPool(bet);
      const participantCount = countBetParticipants(bet);
      const choices = bet.options.map((option) => option.name).join(', ');
      return {
        name: truncateText(`${bet.id} · ${bet.topic}`, 256),
        value: [
          `선택지: ${truncateText(choices, 180)}`,
          `총 판돈: ${formatCoins(total)} · 참여자: ${participantCount}명`,
        ].join('\n'),
        inline: false,
      };
    }),
  );

  return embed;
}

function createBetComponents(bet) {
  if (bet.status !== 'open') {
    return [];
  }

  const pools = optionPools(bet);
  const total = totalBetPool(bet);
  const optionRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(betCustomId('pick', bet.id))
      .setPlaceholder(`${bet.id} 선택지 고르기`)
      .addOptions(
        bet.options.map((option, index) => ({
          label: truncateText(option.name, 100),
          value: String(index),
          description: truncateText(
            `${formatCoins(pools[option.name] || 0)} · ${formatPercent(pools[option.name] || 0, total)}`,
            100,
          ),
        })),
      ),
  );

  const refreshRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(betCustomId('refresh', bet.id))
      .setLabel('새로고침')
      .setStyle(ButtonStyle.Secondary),
  );

  return [optionRow, refreshRow];
}

function createBetListComponents(openBets) {
  if (openBets.length === 0) {
    return [];
  }

  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(betCustomId('list'))
        .setPlaceholder('상세 볼 베팅 선택')
        .addOptions(
          openBets.map((bet) => ({
            label: truncateText(`${bet.id} · ${bet.topic}`, 100),
            value: bet.id,
            description: truncateText(
              `${formatCoins(totalBetPool(bet))} · ${countBetParticipants(bet)}명 참여`,
              100,
            ),
          })),
        ),
    ),
  ];
}

function createAmountComponents(bet, optionIndex, balance) {
  const amountButtons = quickBetAmounts.map((amount) =>
    new ButtonBuilder()
      .setCustomId(betCustomId('amount', bet.id, optionIndex, amount))
      .setLabel(formatCoins(amount))
      .setStyle(ButtonStyle.Primary)
      .setDisabled(balance < amount),
  );

  const percentButtons = [
    new ButtonBuilder()
      .setCustomId(betCustomId('amount', bet.id, optionIndex, 'half'))
      .setLabel('50%')
      .setStyle(ButtonStyle.Success)
      .setDisabled(balance < 2),
    new ButtonBuilder()
      .setCustomId(betCustomId('amount', bet.id, optionIndex, 'all'))
      .setLabel('100%')
      .setStyle(ButtonStyle.Success)
      .setDisabled(balance <= 0),
    new ButtonBuilder()
      .setCustomId(betCustomId('custom', bet.id, optionIndex))
      .setLabel('직접 입력')
      .setStyle(ButtonStyle.Secondary),
  ];

  return [
    new ActionRowBuilder().addComponents(amountButtons),
    new ActionRowBuilder().addComponents(percentButtons),
  ];
}

function createBetPickEmbed(bet, option, balance) {
  const pools = optionPools(bet);
  const total = totalBetPool(bet);
  const optionPool = pools[option.name] || 0;

  return createUiEmbed({
    color: uiTheme.colors.battle,
    title: `${bet.id} · ${truncateText(option.name, 120)}`,
    description: `**${truncateText(bet.topic, 240)}**`,
  })
    .addFields(
      {
        name: '내 잔액',
        value: formatCoins(balance),
        inline: true,
      },
      {
        name: '선택지 판돈',
        value: formatCoins(optionPool),
        inline: true,
      },
      {
        name: '총 판돈',
        value: formatCoins(total),
        inline: true,
      },
    );
}

function createBetSuccessContent(user, bet, optionName, amount, balance) {
  return `${user}님이 ${bet.id}의 **${optionName}**에 ${formatCoins(amount)}을 베팅했습니다. 남은 잔액: ${formatCoins(balance)}`;
}

function recordGamblingResult(user, outcome, profit, gameType) {
  user.stats.gamblingProfit = (user.stats.gamblingProfit || 0) + profit;

  if (outcome === 'win') {
    user.stats.gamblingWon = (user.stats.gamblingWon || 0) + 1;
  } else if (outcome === 'loss') {
    user.stats.gamblingLost = (user.stats.gamblingLost || 0) + 1;
  } else if (outcome === 'push') {
    user.stats.gamblingPushed = (user.stats.gamblingPushed || 0) + 1;
  }

  if (gameType === 'blackjack') {
    if (outcome === 'win') {
      user.stats.blackjackWon = (user.stats.blackjackWon || 0) + 1;
    } else if (outcome === 'loss') {
      user.stats.blackjackLost = (user.stats.blackjackLost || 0) + 1;
    } else if (outcome === 'push') {
      user.stats.blackjackPushed = (user.stats.blackjackPushed || 0) + 1;
    }
  }
}

async function settleInstantGamble({ guildId, discordUser, wager, multiplier, didWin }) {
  return store.run((data) => {
    const guild = store.ensureGuild(data, guildId);
    const user = store.ensureUser(guild, discordUser);

    if (user.balance < wager) {
      return {
        ok: false,
        reason: `노코인이 부족합니다. 현재 잔액: ${formatCoins(user.balance)}`,
      };
    }

    user.balance -= wager;
    const payout = didWin ? wager * multiplier : 0;
    user.balance += payout;
    recordGamblingResult(user, didWin ? 'win' : 'loss', payout - wager, 'instant');

    return {
      ok: true,
      payout,
      profit: payout - wager,
      balance: user.balance,
    };
  });
}

async function settlePlacementExam({ guildId, discordUser, wager }) {
  return store.run((data) => {
    const guild = store.ensureGuild(data, guildId);
    const user = store.ensureUser(guild, discordUser);
    const maxLoss = wager * placementExamMaxLossMultiplier;

    const tier = drawPlacementExam();
    const profit = wager * tier.multiplier;
    user.balance += profit;
    recordGamblingResult(user, profit > 0 ? 'win' : profit < 0 ? 'loss' : 'push', profit, 'placement');

    return {
      ok: true,
      tier,
      profit,
      maxLoss,
      balance: user.balance,
    };
  });
}

function createBlackjackDeck() {
  const deck = [];

  for (const suit of blackjackSuits) {
    for (const rank of blackjackRanks) {
      deck.push({ rank, suit });
    }
  }

  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
  }

  return deck;
}

function drawBlackjackCard(game) {
  if (!Array.isArray(game.deck) || game.deck.length === 0) {
    game.deck = createBlackjackDeck();
  }

  return game.deck.pop();
}

function getBlackjackCardValue(card) {
  if (card.rank === 'A') {
    return 11;
  }

  if (['J', 'Q', 'K'].includes(card.rank)) {
    return 10;
  }

  return Number(card.rank);
}

function getBlackjackHandDetails(cards) {
  let value = 0;
  let aces = 0;

  for (const card of cards) {
    value += getBlackjackCardValue(card);
    if (card.rank === 'A') {
      aces += 1;
    }
  }

  while (value > 21 && aces > 0) {
    value -= 10;
    aces -= 1;
  }

  return {
    value,
    soft: aces > 0,
  };
}

function getBlackjackHandValue(cards) {
  return getBlackjackHandDetails(cards).value;
}

function isBlackjackHand(cards) {
  return cards.length === 2 && getBlackjackHandValue(cards) === 21;
}

function shouldDealerDrawBlackjack(cards) {
  const details = getBlackjackHandDetails(cards);
  return details.value < 17 || (details.value === 17 && details.soft);
}

function formatBlackjackCard(card) {
  return `${card.rank}${card.suit}`;
}

function formatBlackjackHand(cards, hideFirst = false) {
  if (hideFirst) {
    return ['??', ...cards.slice(1).map(formatBlackjackCard)].join(' ');
  }

  return cards.map(formatBlackjackCard).join(' ');
}

function blackjackCustomId(action, userId) {
  return ['bj', action, userId].join(':');
}

function parseBlackjackCustomId(customId) {
  const parts = String(customId || '').split(':');
  if (parts[0] !== 'bj') {
    return null;
  }

  return {
    action: parts[1],
    userId: parts[2],
  };
}

function createBlackjackGame(userId, wager) {
  const game = {
    userId,
    wager,
    deck: createBlackjackDeck(),
    player: [],
    dealer: [],
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  game.player.push(drawBlackjackCard(game));
  game.dealer.push(drawBlackjackCard(game));
  game.player.push(drawBlackjackCard(game));
  game.dealer.push(drawBlackjackCard(game));
  return game;
}

function createBlackjackComponents(game) {
  if (game.status !== 'active') {
    return [];
  }

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(blackjackCustomId('hit', game.userId))
        .setLabel('히트')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(blackjackCustomId('stand', game.userId))
        .setLabel('스탠드')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(blackjackCustomId('surrender', game.userId))
        .setLabel('기권')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function createBlackjackEmbed(game, options = {}) {
  const revealDealer = options.revealDealer || game.status !== 'active';
  const playerValue = getBlackjackHandValue(game.player);
  const dealerValue = getBlackjackHandValue(game.dealer);
  const statusText = options.statusText || '히트로 카드를 더 받거나 스탠드로 승부를 봅니다.';
  const color = game.status === 'active' ? uiTheme.colors.economy : options.color || uiTheme.colors.primary;

  return createUiEmbed({
    color,
    title: '블랙잭',
    description: statusText,
  })
    .addFields(
      {
        name: '내 패',
        value: `${formatBlackjackHand(game.player)}\n합계: **${playerValue}**`,
        inline: false,
      },
      {
        name: '딜러 패',
        value: revealDealer
          ? `${formatBlackjackHand(game.dealer)}\n합계: **${dealerValue}**`
          : `${formatBlackjackHand(game.dealer, true)}\n합계: **?**`,
        inline: false,
      },
      {
        name: '베팅',
        value: formatCoins(game.wager),
        inline: true,
      },
    )
    .setFooter({ text: `${uiTheme.footer} · 21에 가까운 쪽이 승리` })
    .setTimestamp(new Date(game.updatedAt || game.createdAt));
}

function settleBlackjackGame(guild, game, outcome, statusText, payout) {
  const user = store.ensureUser(guild, game.userId);
  user.balance += payout;
  recordGamblingResult(user, outcome, payout - game.wager, 'blackjack');

  game.status = 'ended';
  game.outcome = outcome;
  game.payout = payout;
  game.balance = user.balance;
  game.statusText = `${statusText}\n지급: ${formatCoins(payout)} · 현재 잔액: ${formatCoins(user.balance)}`;
  game.updatedAt = new Date().toISOString();
  delete guild.blackjackGames[game.userId];
  return game;
}

function finishBlackjackStand(guild, game) {
  while (shouldDealerDrawBlackjack(game.dealer)) {
    game.dealer.push(drawBlackjackCard(game));
  }

  const playerValue = getBlackjackHandValue(game.player);
  const dealerValue = getBlackjackHandValue(game.dealer);

  if (dealerValue > 21 || playerValue > dealerValue) {
    return settleBlackjackGame(guild, game, 'win', '승리했습니다.', game.wager * 2);
  }

  if (playerValue === dealerValue) {
    return settleBlackjackGame(guild, game, 'push', '무승부입니다. 베팅금을 돌려받았습니다.', game.wager);
  }

  return settleBlackjackGame(guild, game, 'loss', '패배했습니다.', 0);
}

function ensureBet(guild, betId) {
  return guild.bets[String(betId || '').trim().toUpperCase()];
}

function resolveBetAmount(amount, balance) {
  if (amount === 'all') {
    return balance;
  }

  if (amount === 'half') {
    return Math.floor(balance * 0.5);
  }

  return Number.parseInt(amount, 10);
}

async function placeBet({ guildId, discordUser, betId, optionName, optionIndex, amount }) {
  return store.run((data) => {
    const guild = store.ensureGuild(data, guildId);
    const user = store.ensureUser(guild, discordUser);
    const bet = ensureBet(guild, betId);

    if (!bet) {
      return { ok: false, reason: '해당 베팅을 찾을 수 없습니다.' };
    }

    if (bet.status !== 'open') {
      return { ok: false, reason: '이미 종료된 베팅입니다.' };
    }

    const indexedOption = optionIndex == null ? null : getBetOptionByIndex(bet, optionIndex);
    const option = indexedOption?.option || findOption(bet, optionName);
    if (!option) {
      return {
        ok: false,
        reason: `선택지를 찾을 수 없습니다. 가능한 선택지: ${bet.options.map((item) => item.name).join(', ')}`,
      };
    }

    const wagerAmount = resolveBetAmount(amount, user.balance);
    if (!Number.isInteger(wagerAmount) || wagerAmount < 1) {
      return { ok: false, reason: '베팅 금액은 1 이상이어야 합니다.' };
    }

    if (user.balance < wagerAmount) {
      return {
        ok: false,
        reason: `노코인이 부족합니다. 현재 잔액: ${formatCoins(user.balance)}`,
      };
    }

    const previous = bet.wagers[discordUser.id];
    if (previous && previous.option !== option.name) {
      return {
        ok: false,
        reason: `이미 ${previous.option}에 베팅했습니다. 같은 선택지에는 추가 베팅할 수 있습니다.`,
      };
    }

    user.balance -= wagerAmount;
    bet.wagers[discordUser.id] = {
      option: option.name,
      amount: (previous?.amount || 0) + wagerAmount,
      updatedAt: new Date().toISOString(),
    };

    return {
      ok: true,
      bet,
      option: option.name,
      amount: wagerAmount,
      balance: user.balance,
    };
  });
}

async function createPolymarketBet({ guildId, discordUser, market }) {
  if (!market.id) {
    return { ok: false, reason: 'Polymarket 시장 ID를 확인할 수 없습니다.' };
  }

  if (!market.active || market.closed) {
    return { ok: false, reason: '이 Polymarket 시장은 현재 열려 있지 않습니다.' };
  }

  if (market.outcomes.length < 2) {
    return { ok: false, reason: '선택지가 부족해서 베팅을 만들 수 없습니다.' };
  }

  if (market.outcomes.length > 10) {
    return { ok: false, reason: '선택지가 10개를 넘어 Discord 베팅 UI로 만들 수 없습니다.' };
  }

  return store.run((data) => {
    const guild = store.ensureGuild(data, guildId);
    store.ensureUser(guild, discordUser);
    const existing = Object.values(guild.bets).find((bet) =>
      bet.status === 'open' &&
      bet.source?.type === 'polymarket' &&
      bet.source.marketId === market.id
    );

    if (existing) {
      return {
        ok: true,
        created: false,
        bet: existing,
      };
    }

    const id = nextBetId(guild);
    const bet = {
      id,
      topic: `[Polymarket] ${market.question}`,
      options: market.outcomes.map((name, index) => ({
        name: truncateText(name, 60),
        originalName: name,
        price: market.outcomePrices[index],
      })),
      wagers: {},
      status: 'open',
      createdBy: discordUser.id,
      createdAt: new Date().toISOString(),
      source: {
        type: 'polymarket',
        marketId: market.id,
        question: market.question,
        url: market.url,
        endDate: market.endDate,
        outcomePrices: market.outcomePrices,
        tokenIds: market.tokenIds,
        fetchedAt: new Date().toISOString(),
      },
    };

    guild.bets[id] = bet;
    return {
      ok: true,
      created: true,
      bet,
    };
  });
}

async function handleHelp(interaction) {
  const embed = createUiEmbed({
    color: uiTheme.colors.primary,
    title: '명령어 도움말',
    description: '필요한 메뉴를 골라 바로 실행하면 됩니다.',
  }).addFields(
    {
      name: '경제',
      value: formatCommandList([
        ['/지갑', '노코인과 성장 상태 확인'],
        ['/지급', '봇 오너 노코인 지급'],
        ['/낚시', '아이템과 노코인 획득'],
        ['/구걸', '5분마다 노코인 획득'],
        ['/출석', '하루 한 번 출석 보상'],
        ['/랭킹', '잔액/전투력/강화/낚시 순위'],
        ['/상점', '비싼 아이템 구매 목록'],
        ['/복권', '배율형 즉석 복권'],
      ]),
      inline: false,
    },
    {
      name: '아이템 / 성장',
      value: formatCommandList([
        ['/보관함', '낚시 아이템 목록'],
        ['/상태', '내구도와 다음 강화 확률'],
        ['/아이템사용', '아이템으로 유저 진화'],
        ['/아이템합성', '4개로 다음 등급 아이템 합성'],
        ['/아이템강화', '노코인으로 강화 도전'],
        ['/아이템확률', '등급별 낚시 확률'],
        ['/아이템구매', '상점 아이템 구매'],
        ['/아이템수리', '진화 아이템 내구도 회복'],
      ]),
      inline: false,
    },
    {
      name: '베팅 / Polymarket',
      value: formatCommandList([
        ['/베팅생성', '서버 베팅 생성'],
        ['/베팅목록', '진행 중인 베팅'],
        ['/베팅정보', '베팅 상세 UI'],
        ['/베팅', '노코인 걸기'],
        ['/베팅종료', '정답 선택 후 정산'],
        ['/폴리마켓검색', 'Polymarket 시장 검색'],
        ['/폴리마켓생성', '시장 ID로 베팅 생성'],
      ]),
      inline: false,
    },
    {
      name: '게임 / 결투',
      value: formatCommandList([
        ['/결투', '버튼으로 턴제 전투'],
        ['/동전던지기', '앞면/뒷면 도박'],
        ['/주사위', '1-6 숫자 맞히기'],
        ['/배치', '롤 배치고사 확률 도박'],
        ['/배치확률', '배치고사 전체 확률표 PNG'],
        ['/사정', '초야/세냥/남랭 거리 맞히기'],
        ['/블랙잭', '딜러와 블랙잭'],
      ]),
      inline: false,
    },
    {
      name: '관리',
      value: formatCommandList([
        ['/업데이트', '슬래시 명령어 동기화'],
      ]),
      inline: false,
    },
  );

  await reply(interaction, {
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleWallet(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const target = interaction.options.getUser('유저') || interaction.user;
  const result = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    const user = store.ensureUser(guild, target);
    return {
      balance: user.balance,
      stats: user.stats,
      bestWeapon: getBestBattleWeapon(user),
      itemCount: getInventoryItems(user).reduce((sum, item) => sum + item.count, 0),
      protectionTickets: user.protectionTickets,
    };
  });
  const stats = result.stats || {};

  const embed = createUiEmbed({
    color: uiTheme.colors.economy,
    title: `${getDisplayName(target)}님의 지갑`,
    description: `${target}님의 노코인 현황`,
  })
    .addFields(
      { name: '잔액', value: formatCoins(result.balance), inline: true },
      { name: '보관 아이템', value: `${result.itemCount}개`, inline: true },
      { name: '방지권', value: `${result.protectionTickets}장`, inline: true },
      {
        name: '대표 무기 전투력',
        value: result.bestWeapon
          ? `${formatItemGradeLabel(result.bestWeapon.evolution.grade)} ${result.bestWeapon.evolution.itemName}\n${formatStatLine(result.bestWeapon.power)}`
          : '전투 가능 무기 없음',
        inline: false,
      },
      {
        name: '활동 요약',
        value: [
          `낚시 ${stats.fishing || 0}회(실패 ${stats.fishingFailed || 0}회) / 구걸 ${stats.begging || 0}회`,
          `출석 ${stats.attendanceCount || 0}회 / 복권 ${stats.lotteryPlayed || 0}회`,
          `베팅 ${stats.betsWon || 0}승 ${stats.betsLost || 0}패`,
          `도박 ${stats.gamblingWon || 0}승 ${stats.gamblingLost || 0}패 ${stats.gamblingPushed || 0}무 / 수익 ${formatCoins(stats.gamblingProfit || 0)}`,
        ].join('\n'),
        inline: false,
      },
    );

  await reply(interaction, {
    embeds: [embed],
  });
}

async function handleRanking(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const metric = interaction.options.getString('기준') || 'balance';
  const result = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    const rows = Object.keys(guild.users || {})
      .map((userId) => {
        const user = store.ensureUser(guild, userId);
        return {
          userId,
          name: user.displayName || user.username || `<@${userId}>`,
          value: getRankingMetric(user, metric),
        };
      })
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name, 'ko-KR'))
      .slice(0, 10);

    return { rows };
  });

  const lines = result.rows.length > 0
    ? result.rows.map((row, index) =>
      `${index + 1}. ${row.name} · ${formatRankingValue(metric, row.value)}`,
    ).join('\n')
    : '아직 랭킹에 표시할 유저가 없습니다.';

  const embed = createUiEmbed({
    color: uiTheme.colors.economy,
    title: `${getRankingLabel(metric)} 랭킹`,
    description: truncateText(lines, 2048),
  });

  await reply(interaction, {
    embeds: [embed],
  });
}

async function handleAttendance(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const today = getKoreaDateKey();
  const yesterday = getPreviousDateKey(today);
  const result = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    const user = store.ensureUser(guild, interaction.user);
    user.attendance ||= { lastDate: null, streak: 0, bestStreak: 0 };

    if (user.attendance.lastDate === today) {
      return {
        ok: false,
        streak: user.attendance.streak || 0,
        balance: user.balance,
      };
    }

    const streak = user.attendance.lastDate === yesterday
      ? Math.max(0, Math.floor(user.attendance.streak || 0)) + 1
      : 1;
    const reward = getAttendanceReward(streak);
    user.balance += reward;
    user.attendance.lastDate = today;
    user.attendance.streak = streak;
    user.attendance.bestStreak = Math.max(Math.floor(user.attendance.bestStreak || 0), streak);
    guild.dailyActions.attendance[interaction.user.id] = today;
    user.stats.attendanceCount = (user.stats.attendanceCount || 0) + 1;
    user.stats.attendanceReward = (user.stats.attendanceReward || 0) + reward;

    return {
      ok: true,
      reward,
      streak,
      bestStreak: user.attendance.bestStreak,
      balance: user.balance,
    };
  });

  if (!result.ok) {
    await reply(interaction, {
      content: `오늘(${today}) 출석은 이미 받았습니다. 현재 연속 출석: ${result.streak}일`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const embed = createUiEmbed({
    color: uiTheme.colors.success,
    title: '출석 완료',
    description: `${interaction.user}님이 오늘(${today}) 출석 보상을 받았습니다.`,
  }).addFields(
    { name: '획득', value: formatCoins(result.reward), inline: true },
    { name: '연속 출석', value: `${result.streak}일`, inline: true },
    { name: '최고 기록', value: `${result.bestStreak}일`, inline: true },
    { name: '현재 잔액', value: formatCoins(result.balance), inline: false },
  );

  await reply(interaction, {
    embeds: [embed],
  });
}

async function handleLottery(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const wager = interaction.options.getInteger('금액', true);
  const result = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    const user = store.ensureUser(guild, interaction.user);

    if (user.balance < wager) {
      return {
        ok: false,
        reason: `노코인이 부족합니다. 현재 잔액: ${formatCoins(user.balance)}`,
      };
    }

    const lottery = drawLottery(wager);
    user.balance -= wager;
    user.balance += lottery.payout;
    user.stats.lotteryPlayed = (user.stats.lotteryPlayed || 0) + 1;
    user.stats.lotterySpent = (user.stats.lotterySpent || 0) + wager;
    user.stats.lotteryPayout = (user.stats.lotteryPayout || 0) + lottery.payout;
    if (lottery.payout > wager) {
      user.stats.lotteryWon = (user.stats.lotteryWon || 0) + 1;
    }

    recordGamblingResult(
      user,
      lottery.profit > 0 ? 'win' : lottery.profit < 0 ? 'loss' : 'push',
      lottery.profit,
      'lottery',
    );

    return {
      ok: true,
      lottery,
      balance: user.balance,
    };
  });

  if (!result.ok) {
    await reply(interaction, {
      content: result.reason,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const embed = createUiEmbed({
    color: result.lottery.color,
    title: `복권 ${result.lottery.label}`,
    description: `${interaction.user}님이 ${formatCoins(wager)} 복권을 긁었습니다.`,
  }).addFields(
    { name: '배율', value: `${result.lottery.multiplier}배`, inline: true },
    { name: '지급', value: formatCoins(result.lottery.payout), inline: true },
    { name: '손익', value: formatCoins(result.lottery.profit), inline: true },
    { name: '카지노 확률', value: formatLotteryOdds(), inline: false },
    { name: '현재 잔액', value: formatCoins(result.balance), inline: false },
  );

  await reply(interaction, {
    embeds: [embed],
  });
}

async function handleGrant(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  if (!ownerIds.has(interaction.user.id)) {
    await reply(interaction, {
      content: '노코인 지급은 BOT_OWNER_IDS에 등록된 봇 오너만 사용할 수 있습니다.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const target = interaction.options.getUser('유저', true);
  const amount = interaction.options.getInteger('금액', true);
  const reason = interaction.options.getString('사유')?.trim() || '관리자 지급';

  if (target.bot) {
    await reply(interaction, {
      content: '봇에게는 노코인을 지급할 수 없습니다.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const result = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    const user = store.ensureUser(guild, target);
    user.balance += amount;
    user.stats.grantsReceived += amount;

    return {
      balance: user.balance,
    };
  });

  const embed = createUiEmbed({
    color: uiTheme.colors.success,
    title: '노코인 지급 완료',
  })
    .addFields(
      { name: '대상', value: `${target}`, inline: true },
      { name: '지급액', value: formatCoins(amount), inline: true },
      { name: '현재 잔액', value: formatCoins(result.balance), inline: true },
      { name: '사유', value: truncateText(reason, 1024), inline: false },
    );

  await reply(interaction, {
    content: `${target}님에게 ${formatCoins(amount)}을 지급했습니다.`,
    embeds: [embed],
  });
}

async function handleInventory(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const target = interaction.options.getUser('유저') || interaction.user;
  const result = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    const user = store.ensureUser(guild, target);
    return {
      user,
    };
  });
  const imageFile = createInventoryCardFile(target, result.user);
  const embed = createInventoryEmbed(target, result.user)
    .setImage(`attachment://${imageFile.fileName}`);

  await reply(interaction, {
    embeds: [embed],
    files: [imageFile.attachment],
  });
}

async function handleStatus(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  await interaction.deferReply();

  const target = interaction.options.getUser('유저') || interaction.user;
  const result = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    const user = store.ensureUser(guild, target);
    return {
      user,
    };
  });
  const imageFile = createStatusCardFile(target, result.user);

  await interaction.editReply({
    content: `${target}님의 상태창`,
    files: [imageFile.attachment],
  });
}

async function handleItemRates(interaction) {
  await reply(interaction, {
    embeds: [createItemRatesEmbed()],
  });
}

async function handleShop(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const result = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    const user = store.ensureUser(guild, interaction.user);
    return { user };
  });

  await reply(interaction, {
    embeds: [createShopEmbed(result.user)],
  });
}

async function handleBuyItem(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const itemName = interaction.options.getString('아이템', true).trim();
  const quantity = interaction.options.getInteger('수량') || 1;
  const result = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    const user = store.ensureUser(guild, interaction.user);
    const shopItem = findShopItem(itemName);

    if (!shopItem) {
      const suggestions = getShopItems()
        .slice(0, 5)
        .map((item) => item.name)
        .join(', ');
      return {
        ok: false,
        reason: `상점에서 해당 아이템을 찾을 수 없습니다. 예: ${suggestions}`,
      };
    }

    const totalCost = shopItem.price * quantity;
    if (user.balance < totalCost) {
      return {
        ok: false,
        reason: `노코인이 부족합니다. 필요: ${formatCoins(totalCost)} / 현재 잔액: ${formatCoins(user.balance)}`,
      };
    }

    user.balance -= totalCost;
    user.stats.itemShopPurchases += quantity;
    user.stats.itemShopSpent += totalCost;

    let inventoryItem = null;
    if (shopItem.protectionTicket) {
      user.protectionTickets += quantity;
    } else {
      for (let index = 0; index < quantity; index += 1) {
        inventoryItem = addInventoryItem(user, {
          label: shopItem.name,
          amount: shopItem.averageAmount,
          baseAmount: shopItem.averageBaseAmount,
          weight: shopItem.weight,
        });
      }
    }

    return {
      ok: true,
      item: shopItem,
      quantity,
      totalCost,
      balance: user.balance,
      inventoryItem,
      protectionTickets: user.protectionTickets,
    };
  });

  if (!result.ok) {
    await reply(interaction, {
      content: result.reason,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await reply(interaction, {
    embeds: [
      createItemPurchaseEmbed({
        user: interaction.user,
        item: result.item,
        quantity: result.quantity,
        totalCost: result.totalCost,
        balance: result.balance,
        inventoryItem: result.inventoryItem,
        protectionTickets: result.protectionTickets,
      }),
    ],
  });
}

async function handleSynthesizeItem(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const sourceGradeKey = interaction.options.getString('등급', true);
  const result = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    const user = store.ensureUser(guild, interaction.user);
    const step = getItemSynthesisStep(sourceGradeKey);

    if (!step) {
      return {
        ok: false,
        reason: '합성할 수 없는 등급입니다.',
      };
    }

    const sourceGrade = getItemGradeConfig(step.source);
    const targetGrade = getItemGradeConfig(step.target);
    const rewardItem = pickSynthesisRewardItem(step.target);
    if (!rewardItem) {
      return {
        ok: false,
        reason: `${formatItemGradeLabel(targetGrade)} 합성 결과 아이템을 찾을 수 없습니다.`,
      };
    }

    const consumed = consumeSynthesisMaterials(user, step.source);
    if (!consumed.ok) {
      return {
        ok: false,
        reason: `${formatItemGradeLabel(sourceGrade)} 아이템이 부족합니다. 필요 ${itemSynthesisRequirement}개 / 현재 ${consumed.available || 0}개`,
      };
    }

    const inventoryItem = addInventoryItem(user, {
      label: rewardItem.name,
      amount: rewardItem.averageAmount,
      baseAmount: rewardItem.averageBaseAmount,
      weight: rewardItem.weight,
    });
    user.stats.itemSynthesisCount = (user.stats.itemSynthesisCount || 0) + 1;

    return {
      ok: true,
      sourceGrade,
      targetGrade,
      consumed: consumed.consumed,
      rewardItem,
      inventoryItem,
    };
  });

  if (!result.ok) {
    await reply(interaction, {
      content: result.reason,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await reply(interaction, {
    embeds: [
      createItemSynthesisEmbed({
        user: interaction.user,
        sourceGrade: result.sourceGrade,
        targetGrade: result.targetGrade,
        consumed: result.consumed,
        rewardItem: result.rewardItem,
        inventoryItem: result.inventoryItem,
      }),
    ],
  });
}

async function handleRepairItem(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const itemName = interaction.options.getString('아이템', true).trim();
  const result = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    const user = store.ensureUser(guild, interaction.user);
    const evolution = findUserEvolution(user, itemName);

    if (!evolution) {
      const suggestions = getUserEvolutions(user)
        .slice(0, 5)
        .map((item) => item.itemName)
        .join(', ');
      return {
        ok: false,
        reason: suggestions
          ? `수리할 진화 아이템을 찾을 수 없습니다. 예: ${suggestions}`
          : '수리할 진화 아이템이 없습니다. 먼저 `/아이템사용`으로 진화를 해금해 주세요.',
      };
    }

    const cost = getItemRepairCost(evolution);
    if (cost <= 0) {
      return {
        ok: false,
        reason: `${evolution.itemName}은 이미 내구도가 가득 찼습니다.`,
      };
    }

    if (user.balance < cost) {
      return {
        ok: false,
        reason: `노코인이 부족합니다. 필요: ${formatCoins(cost)} / 현재 잔액: ${formatCoins(user.balance)}`,
      };
    }

    const current = user.evolutions[evolution.key];
    const previousDurability = evolution.durability;
    current.maxDurability = evolution.maxDurability;
    current.durability = evolution.maxDurability;
    current.lastRepairedAt = new Date().toISOString();
    user.balance -= cost;
    user.stats.itemRepairCount += 1;
    user.stats.itemRepairSpent += cost;

    return {
      ok: true,
      evolution: {
        ...evolution,
        durability: current.durability,
      },
      previousDurability,
      nextDurability: current.durability,
      cost,
      balance: user.balance,
    };
  });

  if (!result.ok) {
    await reply(interaction, {
      content: result.reason,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await reply(interaction, {
    embeds: [
      createItemRepairEmbed({
        user: interaction.user,
        evolution: result.evolution,
        cost: result.cost,
        balance: result.balance,
        previousDurability: result.previousDurability,
        nextDurability: result.nextDurability,
      }),
    ],
  });
}

async function handleUseItem(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const itemName = interaction.options.getString('아이템', true).trim();
  const useAll = interaction.options.getBoolean('전부') === true;
  const result = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    const user = store.ensureUser(guild, interaction.user);
    const item = findInventoryItem(user, itemName);

    if (!item) {
      const suggestions = getInventoryItems(user)
        .slice(0, 5)
        .map((inventoryItem) => inventoryItem.name)
        .join(', ');

      return {
        ok: false,
        reason: suggestions
          ? `보관함에서 해당 아이템을 찾을 수 없습니다. 예: ${suggestions}`
          : '보관함이 비어 있습니다. `/낚시`로 아이템을 먼저 얻어 주세요.',
      };
    }

    const useCount = useAll ? item.count : 1;
    const baseGain = getItemPowerGain(item);
    const grade = getItemGradeConfig(baseGain.evolution.grade);
    const useChance = getItemUseChance(grade.key);
    let successCount = 0;

    for (let index = 0; index < useCount; index += 1) {
      if (rollItemUse(grade.key).success) {
        successCount += 1;
      }
    }

    const failedCount = useCount - successCount;
    const gain = {
      ...baseGain,
      attack: baseGain.attack * successCount,
      defense: baseGain.defense * successCount,
      luck: baseGain.luck * successCount,
    };
    user.stats.itemsUsed += useCount;
    user.stats.itemUseSuccesses = (user.stats.itemUseSuccesses || 0) + successCount;
    user.stats.itemUseFailures = (user.stats.itemUseFailures || 0) + failedCount;
    const evolutionRecord = successCount > 0
      ? applyItemEvolution(user, item, gain.evolution, successCount)
      : null;
    const evolvedWeapon = successCount > 0 ? findUserEvolutionByKey(user, item.key) : null;

    const current = user.inventory[item.key];
    if (current && typeof current === 'object') {
      current.count = Math.max(0, Math.floor(current.count || 0) - useCount);
      if (current.count <= 0) {
        delete user.inventory[item.key];
      }
    } else if (Number.isFinite(current)) {
      const remaining = Math.max(0, Math.floor(current) - useCount);
      if (remaining > 0) {
        user.inventory[item.key] = remaining;
      } else {
        delete user.inventory[item.key];
      }
    } else {
      delete user.inventory[item.key];
    }

    const remainingItem = user.inventory[item.key];
    const remaining = remainingItem && typeof remainingItem === 'object'
      ? Math.max(0, Math.floor(remainingItem.count || 0))
      : Number.isFinite(remainingItem)
        ? Math.max(0, Math.floor(remainingItem))
        : 0;

    return {
      ok: true,
      item,
      gain,
      evolutionRecord,
      usedCount: useCount,
      successCount,
      failedCount,
      useChance,
      weaponPower: evolvedWeapon ? getWeaponBattlePower(evolvedWeapon) : null,
      remaining,
    };
  });

  if (!result.ok) {
    await reply(interaction, {
      content: result.reason,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await reply(interaction, {
    embeds: [
      createItemUseEmbed({
        user: interaction.user,
        item: result.item,
        gain: result.gain,
        weaponPower: result.weaponPower,
        remaining: result.remaining,
        evolutionRecord: result.evolutionRecord,
        usedCount: result.usedCount,
        successCount: result.successCount,
        failedCount: result.failedCount,
        useChance: result.useChance,
      }),
    ],
  });
}

async function handleEnhanceItem(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const itemName = interaction.options.getString('아이템', true).trim();
  const result = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    const user = store.ensureUser(guild, interaction.user);
    const evolution = findUserEvolution(user, itemName);

    if (!evolution) {
      const suggestions = getUserEvolutions(user)
        .slice(0, 5)
        .map((item) => item.itemName)
        .join(', ');

      return {
        ok: false,
        reason: suggestions
          ? `아직 해당 아이템 진화를 찾을 수 없습니다. 강화 가능 예: ${suggestions}`
          : '강화할 진화가 없습니다. 먼저 `/아이템사용`으로 아이템 진화를 해금해 주세요.',
      };
    }

    const current = user.evolutions[evolution.key];
    const grade = evolution.grade || getItemGradeConfig(evolution.definition.grade);
    const previousLevel = Number.isFinite(current.enhanceLevel)
      ? Math.max(0, Math.floor(current.enhanceLevel))
      : 0;
    const cost = getItemEnhancementCost(grade.key, previousLevel);
    const rates = getItemEnhancementRates(grade.key, previousLevel);

    if (user.balance < cost) {
      return {
        ok: false,
        reason: `노코인이 부족합니다. 필요: ${formatCoins(cost)} / 현재 잔액: ${formatCoins(user.balance)}`,
      };
    }

    return {
      ok: true,
      evolution: {
        ...evolution,
        grade,
      },
      protectionTickets: user.protectionTickets,
      rates,
      cost,
      previousLevel,
      balance: user.balance,
    };
  });

  if (!result.ok) {
    await reply(interaction, {
      content: result.reason,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const requestId = createItemEnhancementRequestId();
  pendingItemEnhancements.set(requestId, {
    guildId: interaction.guildId,
    userId: interaction.user.id,
    itemKey: result.evolution.key,
    itemName: result.evolution.itemName,
    previousLevel: result.previousLevel,
    cost: result.cost,
    createdAt: Date.now(),
  });

  await reply(interaction, {
    embeds: [
      createItemEnhanceConfirmEmbed({
        user: interaction.user,
        evolution: result.evolution,
        cost: result.cost,
        previousLevel: result.previousLevel,
        rates: result.rates,
        protectionTickets: result.protectionTickets,
        balance: result.balance,
      }),
    ],
    components: createItemEnhanceConfirmComponents(requestId),
  });
}

async function handleItemEnhanceUiInteraction(interaction) {
  const parsed = parseItemEnhanceCustomId(interaction.customId);
  if (!parsed) {
    return false;
  }

  if (!interaction.isButton()) {
    return false;
  }

  if (!(await requireGuild(interaction))) {
    return true;
  }

  const request = getPendingItemEnhancement(parsed.requestId, interaction.guildId);
  if (!request) {
    await interaction.reply({
      content: '강화 확인 시간이 지났습니다. `/아이템강화`로 다시 확인해 주세요.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (request.userId !== interaction.user.id) {
    await interaction.reply({
      content: '이 강화 버튼은 명령어를 실행한 사람만 누를 수 있습니다.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (parsed.action === 'cancel') {
    pendingItemEnhancements.delete(parsed.requestId);
    await interaction.update({
      content: `${interaction.user}님의 아이템 강화를 취소했습니다.`,
      embeds: [],
      components: [],
    });
    return true;
  }

  if (parsed.action !== 'confirm') {
    await interaction.reply({
      content: '알 수 없는 강화 버튼입니다.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const result = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    const user = store.ensureUser(guild, interaction.user);
    const evolution = findUserEvolutionByKey(user, request.itemKey);

    if (!evolution) {
      return {
        ok: false,
        reason: '강화할 진화를 더 이상 찾을 수 없습니다. 다시 아이템을 확인해 주세요.',
      };
    }

    const current = user.evolutions[evolution.key];
    const grade = evolution.grade || getItemGradeConfig(evolution.definition.grade);
    const previousLevel = Number.isFinite(current.enhanceLevel)
      ? Math.max(0, Math.floor(current.enhanceLevel))
      : 0;

    if (previousLevel !== request.previousLevel) {
      return {
        ok: false,
        reason: `강화 단계가 바뀌었습니다. 현재 +${previousLevel} 상태에서 다시 \`/아이템강화\`를 실행해 주세요.`,
      };
    }

    const cost = getItemEnhancementCost(grade.key, previousLevel);
    const rates = getItemEnhancementRates(grade.key, previousLevel);

    if (user.balance < cost) {
      return {
        ok: false,
        reason: `노코인이 부족합니다. 필요: ${formatCoins(cost)} / 현재 잔액: ${formatCoins(user.balance)}`,
      };
    }

    user.balance -= cost;
    user.stats.itemEnhanceAttempts += 1;
    user.stats.itemEnhanceSpent += cost;
    current.grade = grade.key;
    current.maxDurability = Number.isFinite(current.maxDurability) ? current.maxDurability : grade.maxDurability;
    current.durability = Number.isFinite(current.durability) ? current.durability : current.maxDurability;
    current.enhancePowerBonus ||= { attack: 0, defense: 0, luck: 0 };
    current.enhanceAttempts = Math.max(0, Math.floor(current.enhanceAttempts || 0)) + 1;

    const rolled = rollItemEnhancement(grade.key, previousLevel);
    const gain = rolled.success ? getEnhancementPowerGain(evolution) : { attack: 0, defense: 0, luck: 0 };
    let protectedByTicket = false;
    let destroyed = false;

    if (rolled.success) {
      current.enhanceLevel = previousLevel + 1;
      current.enhanceSuccesses = Math.max(0, Math.floor(current.enhanceSuccesses || 0)) + 1;
      current.lastEnhancedAt = new Date().toISOString();
      user.stats.itemEnhanceSuccesses += 1;
      current.enhancePowerBonus.attack = Math.max(0, Math.floor(current.enhancePowerBonus.attack || 0)) + gain.attack;
      current.enhancePowerBonus.defense = Math.max(0, Math.floor(current.enhancePowerBonus.defense || 0)) + gain.defense;
      current.enhancePowerBonus.luck = Math.max(0, Math.floor(current.enhancePowerBonus.luck || 0)) + gain.luck;
    } else {
      user.stats.itemEnhanceFailures = (user.stats.itemEnhanceFailures || 0) + 1;

      if (rolled.destroyed) {
        if (user.protectionTickets > 0) {
          user.protectionTickets -= 1;
          user.stats.protectionTicketsUsed += 1;
          protectedByTicket = true;
          current.enhanceLevel = previousLevel;
          current.lastProtectedAt = new Date().toISOString();
        } else {
          delete user.evolutions[evolution.key];
          destroyed = true;
          user.stats.itemEnhanceDestroyed = (user.stats.itemEnhanceDestroyed || 0) + 1;
        }
      } else {
        current.enhanceLevel = previousLevel;
        current.lastEnhanceFailedAt = new Date().toISOString();
      }
    }

    const currentWeapon = destroyed ? null : findUserEvolutionByKey(user, evolution.key);

    return {
      ok: true,
      evolution: {
        ...evolution,
        enhanceLevel: destroyed ? 0 : current.enhanceLevel,
        grade,
      },
      success: rolled.success,
      protectedByTicket,
      destroyed,
      protectionTickets: user.protectionTickets,
      chance: rolled.chance,
      rates,
      cost,
      previousLevel,
      nextLevel: destroyed ? 0 : current.enhanceLevel,
      gain,
      weaponPower: currentWeapon ? getWeaponBattlePower(currentWeapon) : null,
      balance: user.balance,
    };
  });

  pendingItemEnhancements.delete(parsed.requestId);

  if (!result.ok) {
    await interaction.update({
      content: result.reason,
      embeds: [],
      components: [],
    });
    return true;
  }

  await interaction.update({
    embeds: [
      createItemEnhanceEmbed({
        user: interaction.user,
        evolution: result.evolution,
        success: result.success,
        chance: result.chance,
        rates: result.rates,
        cost: result.cost,
        previousLevel: result.previousLevel,
        nextLevel: result.nextLevel,
        protectedByTicket: result.protectedByTicket,
        destroyed: result.destroyed,
        protectionTickets: result.protectionTickets,
        weaponPower: result.weaponPower,
        gain: result.gain,
        balance: result.balance,
      }),
    ],
    components: [],
  });

  return true;
}

async function handleBattle(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const opponent = interaction.options.getUser('상대', true);
  const wager = interaction.options.getInteger('금액') || 0;

  if (opponent.id === interaction.user.id) {
    await reply(interaction, {
      content: '자기 자신에게 결투를 걸 수는 없습니다.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (opponent.bot) {
    await reply(interaction, {
      content: '봇에게는 결투를 걸 수 없습니다.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const check = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    const challengerRecord = store.ensureUser(guild, interaction.user);
    const opponentRecord = store.ensureUser(guild, opponent);
    const challengerWeapons = getUserEvolutions(challengerRecord).filter((evolution) => evolution.durability > 0);
    const opponentWeapons = getUserEvolutions(opponentRecord).filter((evolution) => evolution.durability > 0);

    if (challengerWeapons.length === 0) {
      return {
        ok: false,
        reason: '신청자가 사용할 수 있는 무기가 없습니다. `/아이템사용`으로 아이템 진화를 해금하거나 `/아이템수리`로 수리해 주세요.',
      };
    }

    if (opponentWeapons.length === 0) {
      return {
        ok: false,
        reason: '상대가 사용할 수 있는 무기가 없습니다. 상대가 `/아이템사용`으로 아이템 진화를 해금하거나 `/아이템수리`로 수리해야 합니다.',
      };
    }

    if (wager > 0 && challengerRecord.balance < wager) {
      return {
        ok: false,
        reason: `신청자의 노코인이 부족합니다. 현재 잔액: ${formatCoins(challengerRecord.balance)}`,
      };
    }

    if (wager > 0 && opponentRecord.balance < wager) {
      return {
        ok: false,
        reason: `상대의 노코인이 부족합니다. 상대 잔액: ${formatCoins(opponentRecord.balance)}`,
      };
    }

    return { ok: true };
  });

  if (!check.ok) {
    await reply(interaction, {
      content: check.reason,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const challengeId = createBattleChallengeId();
  const challenge = {
    id: challengeId,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    challengerId: interaction.user.id,
    opponentId: opponent.id,
    wager,
    weaponKeys: {},
    createdAt: Date.now(),
  };
  battleChallenges.set(challengeId, challenge);

  await reply(interaction, {
    content: `${opponent}님, 결투 신청이 왔습니다.`,
    embeds: [createBattleChallengeEmbed(challenge)],
    components: createBattleChallengeComponents(challengeId),
  });
}

function isBattleParticipant(challenge, userId) {
  return userId === challenge.challengerId || userId === challenge.opponentId;
}

async function handleBattleEquipButton(interaction, parsed, challenge) {
  if (!isBattleParticipant(challenge, interaction.user.id)) {
    await interaction.reply({
      content: '이 결투의 참가자만 무기를 선택할 수 있습니다.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const result = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    const user = store.ensureUser(guild, interaction.user);
    const components = createBattleWeaponSelectComponents(parsed.challengeId, user);

    if (components.length === 0) {
      return {
        ok: false,
        reason: '사용 가능한 무기가 없습니다. `/아이템사용`으로 진화를 해금하거나 `/아이템수리`로 내구도를 회복해 주세요.',
      };
    }

    return { ok: true, components };
  });

  await interaction.reply({
    content: result.ok ? '이번 결투에 사용할 무기를 골라 주세요.' : result.reason,
    components: result.ok ? result.components : [],
    flags: MessageFlags.Ephemeral,
  });
  return true;
}

async function handleBattleWeaponSelect(interaction, parsed, challenge) {
  if (!isBattleParticipant(challenge, interaction.user.id)) {
    await interaction.update({
      content: '이 결투의 참가자만 무기를 선택할 수 있습니다.',
      components: [],
    });
    return true;
  }

  const weaponKey = interaction.values[0];
  const result = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    const user = store.ensureUser(guild, interaction.user);
    const weapon = findUserEvolutionByKey(user, weaponKey);

    if (!weapon || weapon.durability <= 0) {
      return {
        ok: false,
        reason: '선택한 무기를 사용할 수 없습니다. 다른 무기를 고르거나 수리해 주세요.',
      };
    }

    return {
      ok: true,
      weapon,
      power: getWeaponBattlePower(weapon),
    };
  });

  if (!result.ok) {
    await interaction.update({
      content: result.reason,
      components: [],
    });
    return true;
  }

  challenge.weaponKeys ||= {};
  challenge.weaponKeys[interaction.user.id] = weaponKey;

  await interaction.update({
    content: [
      `무기 선택 완료: **${formatItemGradeLabel(result.weapon.grade)} ${result.weapon.itemName}**`,
      `전투 능력: ${formatStatLine(result.power)}`,
      '양쪽 모두 선택한 뒤 상대가 공개 메시지의 `결투 수락`을 누르면 시작됩니다.',
    ].join('\n'),
    components: [],
  });
  return true;
}

async function handleBattleUiInteraction(interaction) {
  const parsed = parseBattleCustomId(interaction.customId);
  if (!parsed) {
    return false;
  }

  if (!interaction.isButton() && !interaction.isStringSelectMenu()) {
    return false;
  }

  if (!(await requireGuild(interaction))) {
    return true;
  }

  if (parsed.action === 'move') {
    if (!interaction.isButton()) {
      return false;
    }
    return handleBattleMoveInteraction(interaction, parsed);
  }

  const challenge = getBattleChallenge(parsed.challengeId, interaction.guildId);
  if (!challenge) {
    await interaction.reply({
      content: '이 결투 신청은 만료되었거나 찾을 수 없습니다.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (interaction.isButton() && parsed.action === 'equip') {
    return handleBattleEquipButton(interaction, parsed, challenge);
  }

  if (interaction.isStringSelectMenu() && parsed.action === 'weapon') {
    return handleBattleWeaponSelect(interaction, parsed, challenge);
  }

  if (!interaction.isButton()) {
    return false;
  }

  if (interaction.user.id !== challenge.opponentId) {
    await interaction.reply({
      content: '결투 수락과 거절은 지목된 상대만 할 수 있습니다. 무기 선택은 참가자 둘 다 가능합니다.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (parsed.action === 'decline') {
    battleChallenges.delete(parsed.challengeId);
    await interaction.update({
      content: '결투 신청이 거절되었습니다.',
      embeds: [
        createUiEmbed({
          color: uiTheme.colors.muted,
          title: '결투 취소',
          description: `<@${challenge.opponentId}>님이 <@${challenge.challengerId}>님의 결투 신청을 거절했습니다.`,
        }),
      ],
      components: [],
    });
    return true;
  }

  if (parsed.action === 'accept') {
    const missingWeaponUserIds = [challenge.challengerId, challenge.opponentId]
      .filter((userId) => !challenge.weaponKeys?.[userId]);
    if (missingWeaponUserIds.length > 0) {
      await interaction.reply({
        content: `결투 전에 양쪽 모두 무기를 선택해야 합니다. 미선택: ${missingWeaponUserIds.map((userId) => `<@${userId}>`).join(', ')}`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    battleChallenges.delete(parsed.challengeId);
    await interaction.deferUpdate();

    const result = await store.run((data) => {
      const guild = store.ensureGuild(data, interaction.guildId);
      const challengerRecord = store.ensureUser(guild, challenge.challengerId);
      const opponentRecord = store.ensureUser(guild, challenge.opponentId);
      const challengerWeapon = findUserEvolutionByKey(challengerRecord, challenge.weaponKeys[challenge.challengerId]);
      const opponentWeapon = findUserEvolutionByKey(opponentRecord, challenge.weaponKeys[challenge.opponentId]);

      if (!challengerWeapon || challengerWeapon.durability <= 0) {
        return {
          ok: false,
          reason: '신청자의 선택 무기가 파손되었거나 사라져 결투가 취소되었습니다.',
        };
      }

      if (!opponentWeapon || opponentWeapon.durability <= 0) {
        return {
          ok: false,
          reason: '상대의 선택 무기가 파손되었거나 사라져 결투가 취소되었습니다.',
        };
      }

      if (challenge.wager > 0 && challengerRecord.balance < challenge.wager) {
        return {
          ok: false,
          reason: `신청자의 노코인이 부족해서 결투가 취소되었습니다. 현재 잔액: ${formatCoins(challengerRecord.balance)}`,
        };
      }

      if (challenge.wager > 0 && opponentRecord.balance < challenge.wager) {
        return {
          ok: false,
          reason: `상대의 노코인이 부족해서 결투가 취소되었습니다. 현재 잔액: ${formatCoins(opponentRecord.balance)}`,
        };
      }

      if (challenge.wager > 0) {
        challengerRecord.balance -= challenge.wager;
        opponentRecord.balance -= challenge.wager;
      }

      return {
        ok: true,
        session: createBattleSession(challenge, challengerRecord, opponentRecord),
      };
    });

    if (!result.ok) {
      await interaction.editReply({
        content: result.reason,
        embeds: [],
        components: [],
      });
      return true;
    }

    battleSessions.set(result.session.id, result.session);
    await interaction.editReply({
      content: '결투가 시작되었습니다. 각자 자기 턴에 버튼을 눌러 행동하세요.',
      embeds: [createBattleTurnEmbed(result.session)],
      components: createBattleTurnComponents(result.session),
    });
    return true;
  }

  if (parsed.action !== 'accept') {
    await interaction.reply({
      content: '알 수 없는 결투 버튼입니다.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }
}

async function settleBattleSession(session) {
  return store.run((data) => {
    const guild = store.ensureGuild(data, session.guildId);
    const winner = store.ensureUser(guild, session.winnerId);
    const loser = store.ensureUser(guild, session.loserId);
    const payout = session.wager * 2;

    winner.balance += payout;
    winner.stats.battlesWon += 1;
    winner.stats.battleProfit += session.wager;
    loser.stats.battlesLost += 1;
    loser.stats.battleProfit -= session.wager;
    const winnerDurabilityLoss = 3;
    const loserDurabilityLoss = 6;
    const winnerItemsChanged = applyBattleDurabilityLoss(winner, winnerDurabilityLoss, session.weaponKeys?.[session.winnerId]);
    const loserItemsChanged = applyBattleDurabilityLoss(loser, loserDurabilityLoss, session.weaponKeys?.[session.loserId]);

    return {
      ok: true,
      finalResult: {
        winnerId: session.winnerId,
        loserId: session.loserId,
        payout,
        winnerBalance: winner.balance,
        loserBalance: loser.balance,
        durabilityLoss: {
          winner: winnerDurabilityLoss,
          loser: loserDurabilityLoss,
          winnerItemsChanged,
          loserItemsChanged,
        },
      },
    };
  });
}

async function handleBattleMoveInteraction(interaction, parsed) {
  const session = getBattleSession(parsed.challengeId, interaction.guildId);
  if (!session) {
    await interaction.reply({
      content: '진행 중인 결투를 찾을 수 없습니다. 새로 `/결투`를 신청해 주세요.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (![session.challengerId, session.opponentId].includes(interaction.user.id)) {
    await interaction.reply({
      content: '이 결투의 참가자만 조작할 수 있습니다.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (interaction.user.id !== session.turnUserId) {
    await interaction.reply({
      content: `아직 당신 턴이 아닙니다. 현재 턴: <@${session.turnUserId}>`,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const action = parsed.parts[0] || 'attack';
  const allowedActions = new Set(['attack', 'skill', 'ultimate', 'guard']);
  if (!allowedActions.has(action)) {
    await interaction.reply({
      content: '알 수 없는 결투 행동입니다.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (action === 'ultimate' && session.ultimateUsed[interaction.user.id]) {
    await interaction.reply({
      content: '궁극기는 결투당 한 번만 사용할 수 있습니다.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  await interaction.deferUpdate();
  const advanced = advanceBattleTurn(session, interaction.user.id, action);

  if (advanced.status === 'finished') {
    const result = await settleBattleSession(advanced);
    await interaction.editReply({
      content: '결투가 종료되었습니다.',
      embeds: [createBattleTurnEmbed(advanced, result.finalResult)],
      components: [],
    });
    return true;
  }

  await interaction.editReply({
    content: '결투 진행 중입니다. 현재 턴 유저가 버튼을 눌러야 합니다.',
    embeds: [createBattleTurnEmbed(advanced)],
    components: createBattleTurnComponents(advanced),
  });

  return true;
}

async function handleCreateBet(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const topic = interaction.options.getString('주제', true).trim();
  const options = parseOptions(interaction.options.getString('선택지', true));

  if (options.length < 2) {
    await reply(interaction, {
      content: '선택지는 최소 2개가 필요합니다. 예: `빨강, 파랑`',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (options.length > 10) {
    await reply(interaction, {
      content: '선택지는 최대 10개까지 만들 수 있습니다.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const bet = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    store.ensureUser(guild, interaction.user);

    const id = nextBetId(guild);
    const created = {
      id,
      topic,
      options: options.map((name) => ({ name })),
      wagers: {},
      status: 'open',
      createdBy: interaction.user.id,
      createdAt: new Date().toISOString(),
    };

    guild.bets[id] = created;
    return created;
  });

  await reply(interaction, {
    embeds: [createBetEmbed(bet)],
    components: createBetComponents(bet),
  });
}

async function handleBetList(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const openBets = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    return Object.values(guild.bets)
      .filter((bet) => bet.status === 'open')
      .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
      .slice(0, 10);
  });

  if (openBets.length === 0) {
    await reply(interaction, '진행 중인 베팅이 없습니다.');
    return;
  }

  await reply(interaction, {
    embeds: [createBetListEmbed(openBets)],
    components: createBetListComponents(openBets),
  });
}

async function handleBetInfo(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const betId = interaction.options.getString('베팅id', true);
  const bet = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    return ensureBet(guild, betId);
  });

  if (!bet) {
    await reply(interaction, {
      content: '해당 베팅을 찾을 수 없습니다.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const embeds = [createBetEmbed(bet)];
  const files = [];
  if (bet.source?.type === 'polymarket' && bet.source.marketId) {
    try {
      const market = await fetchPolymarketMarket(bet.source.marketId);
      const charts = await fetchPolymarketPriceCharts(market);
      const marketView = createPolymarketMarketView(market, charts);
      embeds.push(marketView.embed);
      files.push(...marketView.files);
    } catch (error) {
      embeds.push(
        createUiEmbed({
          color: uiTheme.colors.warning,
          title: 'Polymarket 차트',
          description: `차트를 불러오지 못했습니다: ${error.message}`,
        }),
      );
    }
  }

  await reply(interaction, {
    embeds,
    files,
    components: createBetComponents(bet),
  });
}

async function handlePlaceBet(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const betId = interaction.options.getString('베팅id', true);
  const optionName = interaction.options.getString('선택지', true);
  const amount = interaction.options.getInteger('금액', true);

  const result = await placeBet({
    guildId: interaction.guildId,
    discordUser: interaction.user,
    betId,
    optionName,
    amount,
  });

  if (!result.ok) {
    await reply(interaction, {
      content: result.reason,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await reply(interaction, {
    content: createBetSuccessContent(interaction.user, result.bet, result.option, result.amount, result.balance),
    embeds: [createBetEmbed(result.bet)],
    components: createBetComponents(result.bet),
  });
}

async function handleBetListSelect(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const betId = interaction.values[0];
  const bet = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    return ensureBet(guild, betId);
  });

  if (!bet) {
    await interaction.reply({
      content: '해당 베팅을 찾을 수 없습니다.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    embeds: [createBetEmbed(bet)],
    components: createBetComponents(bet),
    flags: MessageFlags.Ephemeral,
  });
}

async function handleBetPickSelect(interaction, parsed) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const [betId] = parsed.parts;
  const optionIndex = interaction.values[0];
  const result = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    const user = store.ensureUser(guild, interaction.user);
    const bet = ensureBet(guild, betId);

    if (!bet) {
      return { ok: false, reason: '해당 베팅을 찾을 수 없습니다.' };
    }

    if (bet.status !== 'open') {
      return { ok: false, reason: '이미 종료된 베팅입니다.' };
    }

    const indexedOption = getBetOptionByIndex(bet, optionIndex);
    if (!indexedOption) {
      return { ok: false, reason: '선택지를 찾을 수 없습니다.' };
    }

    return {
      ok: true,
      bet,
      option: indexedOption.option,
      optionIndex: indexedOption.index,
      balance: user.balance,
    };
  });

  if (!result.ok) {
    await interaction.reply({
      content: result.reason,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    embeds: [createBetPickEmbed(result.bet, result.option, result.balance)],
    components: createAmountComponents(result.bet, result.optionIndex, result.balance),
    flags: MessageFlags.Ephemeral,
  });
}

async function handleBetRefreshButton(interaction, parsed) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const [betId] = parsed.parts;
  const bet = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    return ensureBet(guild, betId);
  });

  if (!bet) {
    await interaction.reply({
      content: '해당 베팅을 찾을 수 없습니다.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.update({
    embeds: [createBetEmbed(bet)],
    components: createBetComponents(bet),
  });
}

async function handleBetAmountButton(interaction, parsed) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const [betId, optionIndex, rawAmount] = parsed.parts;
  const result = await placeBet({
    guildId: interaction.guildId,
    discordUser: interaction.user,
    betId,
    optionIndex,
    amount: rawAmount,
  });

  if (!result.ok) {
    await interaction.reply({
      content: result.reason,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const content = createBetSuccessContent(
    interaction.user,
    result.bet,
    result.option,
    result.amount,
    result.balance,
  );

  await interaction.update({
    content: '베팅이 완료되었습니다.',
    embeds: [createBetEmbed(result.bet)],
    components: [],
  });

  await sendInteractionFollowUp(interaction, {
    content,
    embeds: [createBetEmbed(result.bet)],
    components: createBetComponents(result.bet),
  });
}

async function handleBetCustomButton(interaction, parsed) {
  const [betId, optionIndex] = parsed.parts;
  const modal = new ModalBuilder()
    .setCustomId(betCustomId('modal', betId, optionIndex))
    .setTitle(`베팅 ${betId} 금액 입력`);
  const amountInput = new TextInputBuilder()
    .setCustomId('amount')
    .setLabel('베팅 금액')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('예: 500')
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(12);

  modal.addComponents(new ActionRowBuilder().addComponents(amountInput));
  await interaction.showModal(modal);
}

async function handleBetModalSubmit(interaction, parsed) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const [betId, optionIndex] = parsed.parts;
  const rawAmount = interaction.fields.getTextInputValue('amount').replaceAll(',', '').trim();

  if (!/^\d+$/.test(rawAmount)) {
    await interaction.reply({
      content: '베팅 금액은 숫자로 입력해 주세요.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const result = await placeBet({
    guildId: interaction.guildId,
    discordUser: interaction.user,
    betId,
    optionIndex,
    amount: rawAmount,
  });

  if (!result.ok) {
    await interaction.reply({
      content: result.reason,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content: createBetSuccessContent(interaction.user, result.bet, result.option, result.amount, result.balance),
    embeds: [createBetEmbed(result.bet)],
    components: createBetComponents(result.bet),
  });
}

async function handleBetUiInteraction(interaction) {
  const parsed = parseBetCustomId(interaction.customId);
  if (!parsed) {
    return false;
  }

  if (interaction.isStringSelectMenu()) {
    if (parsed.action === 'list') {
      await handleBetListSelect(interaction);
      return true;
    }

    if (parsed.action === 'pick') {
      await handleBetPickSelect(interaction, parsed);
      return true;
    }
  }

  if (interaction.isButton()) {
    if (parsed.action === 'refresh') {
      await handleBetRefreshButton(interaction, parsed);
      return true;
    }

    if (parsed.action === 'amount') {
      await handleBetAmountButton(interaction, parsed);
      return true;
    }

    if (parsed.action === 'custom') {
      await handleBetCustomButton(interaction, parsed);
      return true;
    }
  }

  if (interaction.isModalSubmit() && parsed.action === 'modal') {
    await handleBetModalSubmit(interaction, parsed);
    return true;
  }

  await interaction.reply({
    content: '처리할 수 없는 베팅 UI입니다. `/업데이트` 후 다시 시도해 주세요.',
    flags: MessageFlags.Ephemeral,
  });
  return true;
}

async function handlePolymarketSearch(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const query = interaction.options.getString('검색어', true).trim();
  await interaction.deferReply();

  const markets = await searchPolymarketMarkets(query, 5);
  if (markets.length === 0) {
    await reply(interaction, {
      content: '검색 결과가 없습니다. 다른 키워드로 다시 검색해 주세요.',
    });
    return;
  }

  await reply(interaction, {
    embeds: [createPolymarketSearchEmbed(query, markets)],
    components: createPolymarketSearchComponents(markets),
  });
}

async function handlePolymarketCreate(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const marketId = interaction.options.getString('시장id', true).trim();
  await interaction.deferReply();

  const market = await fetchPolymarketMarket(marketId);
  const charts = await fetchPolymarketPriceCharts(market);
  const marketView = createPolymarketMarketView(market, charts);
  const result = await createPolymarketBet({
    guildId: interaction.guildId,
    discordUser: interaction.user,
    market,
  });

  if (!result.ok) {
    await reply(interaction, {
      content: result.reason,
    });
    return;
  }

  await reply(interaction, {
    content: result.created
      ? `Polymarket 시장으로 노코인 베팅 ${result.bet.id}을 만들었습니다.`
      : `이미 열린 노코인 베팅 ${result.bet.id}이 있습니다.`,
    embeds: [createBetEmbed(result.bet), marketView.embed],
    files: marketView.files,
    components: createBetComponents(result.bet),
  });
}

async function handlePolymarketMarketSelect(interaction) {
  if (!(await requireGuild(interaction))) {
    return true;
  }

  const marketId = interaction.values[0];
  await interaction.deferUpdate();
  const market = await fetchPolymarketMarket(marketId);
  const charts = await fetchPolymarketPriceCharts(market);
  const marketView = createPolymarketMarketView(market, charts);
  await interaction.editReply({
    embeds: [marketView.embed],
    files: marketView.files,
    attachments: [],
    components: createPolymarketMarketComponents(market),
  });
  return true;
}

async function handlePolymarketCreateButton(interaction, parsed) {
  if (!(await requireGuild(interaction))) {
    return true;
  }

  const [marketId] = parsed.parts;
  await interaction.deferReply();
  const market = await fetchPolymarketMarket(marketId);
  const charts = await fetchPolymarketPriceCharts(market);
  const marketView = createPolymarketMarketView(market, charts);
  const result = await createPolymarketBet({
    guildId: interaction.guildId,
    discordUser: interaction.user,
    market,
  });

  if (!result.ok) {
    await reply(interaction, {
      content: result.reason,
    });
    return true;
  }

  await reply(interaction, {
    content: result.created
      ? `Polymarket 시장으로 노코인 베팅 ${result.bet.id}을 만들었습니다.`
      : `이미 열린 노코인 베팅 ${result.bet.id}이 있습니다.`,
    embeds: [createBetEmbed(result.bet), marketView.embed],
    files: marketView.files,
    components: createBetComponents(result.bet),
  });
  return true;
}

async function handlePolymarketUiInteraction(interaction) {
  const parsed = parsePolymarketCustomId(interaction.customId);
  if (!parsed) {
    return false;
  }

  if (interaction.isStringSelectMenu() && parsed.action === 'select') {
    return handlePolymarketMarketSelect(interaction);
  }

  if (interaction.isButton() && parsed.action === 'create') {
    return handlePolymarketCreateButton(interaction, parsed);
  }

  await interaction.reply({
    content: '처리할 수 없는 Polymarket UI입니다.',
    flags: MessageFlags.Ephemeral,
  });
  return true;
}

async function handleCloseBet(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const betId = interaction.options.getString('베팅id', true);
  const winnerName = interaction.options.getString('정답', true);

  const result = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    const bet = ensureBet(guild, betId);

    if (!bet) {
      return { ok: false, reason: '해당 베팅을 찾을 수 없습니다.' };
    }

    if (!canCloseBet(interaction, bet)) {
      return { ok: false, reason: '이 베팅을 종료할 권한이 없습니다.' };
    }

    if (bet.status !== 'open') {
      return { ok: false, reason: '이미 종료된 베팅입니다.' };
    }

    const winningOption = findOption(bet, winnerName);
    if (!winningOption) {
      return {
        ok: false,
        reason: `정답 선택지를 찾을 수 없습니다. 가능한 선택지: ${bet.options.map((item) => item.name).join(', ')}`,
      };
    }

    const wagers = Object.entries(bet.wagers || {});
    const totalPool = wagers.reduce((sum, [, wager]) => sum + wager.amount, 0);
    const winners = wagers.filter(([, wager]) => wager.option === winningOption.name);
    const winningPool = winners.reduce((sum, [, wager]) => sum + wager.amount, 0);
    const payouts = [];

    bet.status = 'closed';
    bet.winner = winningOption.name;
    bet.closedBy = interaction.user.id;
    bet.closedAt = new Date().toISOString();

    if (wagers.length === 0) {
      return {
        ok: true,
        bet,
        totalPool,
        winnerCount: 0,
        refunded: false,
        payouts,
      };
    }

    if (winners.length === 0 || winningPool <= 0) {
      for (const [userId, wager] of wagers) {
        const user = store.ensureUser(guild, userId);
        user.balance += wager.amount;
      }

      return {
        ok: true,
        bet,
        totalPool,
        winnerCount: 0,
        refunded: true,
        payouts,
      };
    }

    let paid = 0;
    const calculated = winners.map(([userId, wager]) => {
      const payout = Math.floor((totalPool * wager.amount) / winningPool);
      paid += payout;
      return { userId, payout, wager };
    });

    let remainder = totalPool - paid;
    calculated.sort((a, b) => b.wager.amount - a.wager.amount);

    for (const item of calculated) {
      if (remainder > 0) {
        item.payout += 1;
        remainder -= 1;
      }

      const user = store.ensureUser(guild, item.userId);
      user.balance += item.payout;
      user.stats.betsWon += 1;
      payouts.push({
        userId: item.userId,
        amount: item.payout,
      });
    }

    const winnerIds = new Set(winners.map(([userId]) => userId));
    for (const [userId] of wagers) {
      if (!winnerIds.has(userId)) {
        const user = store.ensureUser(guild, userId);
        user.stats.betsLost += 1;
      }
    }

    return {
      ok: true,
      bet,
      totalPool,
      winnerCount: winners.length,
      refunded: false,
      payouts,
    };
  });

  if (!result.ok) {
    await reply(interaction, {
      content: result.reason,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let summary = `베팅 ${result.bet.id} 종료. 정답은 **${result.bet.winner}**입니다. 총 판돈: ${formatCoins(result.totalPool)}`;

  if (result.refunded) {
    summary += '\n정답 베팅자가 없어 모든 참가자에게 환불했습니다.';
  } else if (result.winnerCount === 0) {
    summary += '\n참가자가 없어 지급 없이 종료했습니다.';
  } else {
    const payoutLines = result.payouts
      .slice(0, 8)
      .map((payout) => `<@${payout.userId}> ${formatCoins(payout.amount)}`);
    summary += `\n당첨자 ${result.winnerCount}명에게 지급했습니다.\n${payoutLines.join('\n')}`;
  }

  await reply(interaction, {
    content: summary,
    embeds: [createBetEmbed(result.bet)],
  });
}

async function handleFishing(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const now = Date.now();
  const result = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    const user = store.ensureUser(guild, interaction.user);
    const lastUsed = guild.cooldowns.fishing[interaction.user.id] || 0;
    const remaining = lastUsed + config.fishingCooldownMs - now;

    if (remaining > 0) {
      return { ok: false, remaining };
    }

    const reward = fishReward(config.economyMultiplier);
    user.stats.fishing += 1;
    guild.cooldowns.fishing[interaction.user.id] = now;

    if (reward.failed) {
      user.stats.fishingFailed = (user.stats.fishingFailed || 0) + 1;
      return {
        ok: true,
        reward,
        balance: user.balance,
      };
    }

    if (reward.protectionTicket) {
      user.protectionTickets += 1;
      user.stats.protectionTicketsFound += 1;
      return {
        ok: true,
        reward,
        protectionTickets: user.protectionTickets,
        balance: user.balance,
      };
    }

    user.balance += reward.amount;
    const inventoryItem = addInventoryItem(user, reward);

    return {
      ok: true,
      reward,
      inventoryItem,
      balance: user.balance,
    };
  });

  if (!result.ok) {
    await reply(interaction, {
      content: `아직 낚시할 수 없습니다. 남은 시간: ${formatRemaining(result.remaining)}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();
  await interaction.editReply({
    content: `${interaction.user}님의 낚시`,
    embeds: [createFishingEmbed('cast')],
  });
  await wait(850);
  await interaction.editReply({
    content: `${interaction.user}님의 낚시`,
    embeds: [createFishingEmbed('bite')],
  });
  await wait(850);
  await interaction.editReply({
    content: `${interaction.user}님의 낚시`,
    embeds: [createFishingEmbed('pull')],
  });
  await wait(850);
  await interaction.editReply({
    content: `${interaction.user}님의 낚시 결과`,
    embeds: [
      createFishingEmbed(result.reward.failed ? 'failed' : 'caught', {
        user: interaction.user,
        reward: result.reward,
        inventoryItem: result.inventoryItem,
        protectionTickets: result.protectionTickets,
        balance: result.balance,
      }),
    ],
  });
}

async function handleBegging(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const now = Date.now();
  const result = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    const user = store.ensureUser(guild, interaction.user);
    const lastUsed = guild.cooldowns.begging[interaction.user.id] || 0;
    const remaining = lastUsed + config.beggingCooldownMs - now;

    if (remaining > 0) {
      return { ok: false, remaining };
    }

    const reward = begReward(config.economyMultiplier);
    user.balance += reward.amount;
    user.stats.begging += 1;
    guild.cooldowns.begging[interaction.user.id] = now;

    return {
      ok: true,
      reward,
      balance: user.balance,
    };
  });

  if (!result.ok) {
    await reply(interaction, {
      content: `아직 구걸할 수 없습니다. 남은 시간: ${formatRemaining(result.remaining)}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const embed = createUiEmbed({
    color: uiTheme.colors.economy,
    title: '구걸 성공',
    description: `${interaction.user}님이 ${result.reward.label}`,
  }).addFields(
    { name: '획득', value: formatCoins(result.reward.amount), inline: true },
    { name: '현재 잔액', value: formatCoins(result.balance), inline: true },
  );

  await reply(interaction, {
    embeds: [embed],
  });
}

async function handleCoinFlip(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const choice = interaction.options.getString('선택', true);
  const wager = interaction.options.getInteger('금액', true);
  const didWin = rollCasinoWin(casinoWinChances.coinFlip);
  const resultFace = didWin ? choice : pickDifferentValue(['heads', 'tails'], choice);
  const result = await settleInstantGamble({
    guildId: interaction.guildId,
    discordUser: interaction.user,
    wager,
    multiplier: 2,
    didWin,
  });

  if (!result.ok) {
    await reply(interaction, {
      content: result.reason,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const labels = {
    heads: '앞면',
    tails: '뒷면',
  };
  const embed = createUiEmbed({
    color: didWin ? uiTheme.colors.success : uiTheme.colors.danger,
    title: '동전 던지기',
    description: didWin ? '적중했습니다.' : '빗나갔습니다.',
  })
    .addFields(
      { name: '내 선택', value: labels[choice], inline: true },
      { name: '결과', value: labels[resultFace], inline: true },
      { name: '지급', value: formatCoins(result.payout), inline: true },
      { name: '카지노 적중률', value: formatChance(casinoWinChances.coinFlip), inline: true },
      { name: '현재 잔액', value: formatCoins(result.balance), inline: true },
    );

  await reply(interaction, {
    content: `${interaction.user}님의 동전 던지기 결과`,
    embeds: [embed],
  });
}

async function handleDice(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const choice = interaction.options.getInteger('숫자', true);
  const wager = interaction.options.getInteger('금액', true);
  const didWin = rollCasinoWin(casinoWinChances.dice);
  const roll = didWin ? choice : pickDifferentValue([1, 2, 3, 4, 5, 6], choice);
  const result = await settleInstantGamble({
    guildId: interaction.guildId,
    discordUser: interaction.user,
    wager,
    multiplier: 6,
    didWin,
  });

  if (!result.ok) {
    await reply(interaction, {
      content: result.reason,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const embed = createUiEmbed({
    color: didWin ? uiTheme.colors.success : uiTheme.colors.danger,
    title: '주사위',
    description: didWin ? '정확히 맞혔습니다.' : '이번 숫자는 아니었습니다.',
  })
    .addFields(
      { name: '내 선택', value: String(choice), inline: true },
      { name: '결과', value: String(roll), inline: true },
      { name: '지급', value: formatCoins(result.payout), inline: true },
      { name: '카지노 적중률', value: formatChance(casinoWinChances.dice), inline: true },
      { name: '현재 잔액', value: formatCoins(result.balance), inline: true },
    );

  await reply(interaction, {
    content: `${interaction.user}님의 주사위 결과`,
    embeds: [embed],
  });
}

async function handlePlacementExam(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const wager = interaction.options.getInteger('금액', true);
  const result = await settlePlacementExam({
    guildId: interaction.guildId,
    discordUser: interaction.user,
    wager,
  });

  if (!result.ok) {
    await reply(interaction, {
      content: result.reason,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const didProfit = result.profit > 0;
  const tierIcon = result.tier.iconUrl ? null : createPlacementExamTierIconFile(result.tier);
  const embed = createUiEmbed({
    color: result.tier.color || (didProfit ? uiTheme.colors.success : uiTheme.colors.danger),
    title: '롤 배치고사',
    description: `${interaction.user}님의 배치 결과는 **${result.tier.name}**입니다.`,
  })
    .setThumbnail(result.tier.iconUrl || `attachment://${tierIcon.fileName}`)
    .addFields(
    { name: '베팅 기준 금액', value: formatCoins(wager), inline: true },
    { name: '보상', value: formatPlacementExamMultiplier(result.tier), inline: true },
    { name: '확률', value: formatPlacementExamChance(result.tier), inline: true },
    { name: '손익', value: formatPlacementExamProfit(result.profit), inline: true },
    { name: '최대 손실', value: `${formatCoins(result.maxLoss)} (베팅액 x ${placementExamMaxLossMultiplier}배)`, inline: true },
    { name: '현재 잔액', value: formatCoins(result.balance), inline: true },
    { name: '주의', value: placementExamWarning, inline: false },
    { name: '전체 확률표', value: '`/배치확률`로 PNG 표를 확인할 수 있습니다.', inline: false },
  );

  const payload = {
    content: `${interaction.user}님의 롤 배치고사 결과`,
    embeds: [embed],
  };

  if (tierIcon) {
    payload.files = [tierIcon.attachment];
  }

  await reply(interaction, payload);
}

async function handlePlacementExamOdds(interaction) {
  const imageFile = createPlacementExamOddsPngFile();
  const embed = createUiEmbed({
    color: uiTheme.colors.primary,
    title: '롤 배치고사 확률표',
    description: '전체 배치고사 보상과 확률을 PNG 이미지로 정리했습니다.',
  }).setImage(`attachment://${imageFile.fileName}`)
    .addFields(
      { name: '주의', value: placementExamWarning, inline: false },
    );

  await reply(interaction, {
    embeds: [embed],
    files: [imageFile.attachment],
  });
}

async function handleWaterGun(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const choice = interaction.options.getString('선택', true);
  const wager = interaction.options.getInteger('금액', true);
  const picked = getWaterGunContestant(choice);

  if (!picked) {
    await reply(interaction, {
      content: '선택지를 찾을 수 없습니다. 초야, 세냥, 남랭 중에서 골라 주세요.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const contest = simulateWaterGunContest(picked.key);
  const didWin = contest.winner.key === picked.key;
  const result = await settleInstantGamble({
    guildId: interaction.guildId,
    discordUser: interaction.user,
    wager,
    multiplier: 3,
    didWin,
  });

  if (!result.ok) {
    await reply(interaction, {
      content: result.reason,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();
  await interaction.editReply({
    content: `${interaction.user}님의 사정 베팅`,
    embeds: [
      createWaterGunEmbed('ready', {
        user: interaction.user,
        picked,
        wager,
      }),
    ],
  });
  await wait(850);

  let best = null;
  for (let index = 0; index < contest.shots.length; index += 1) {
    const shot = contest.shots[index];
    if (!best || shot.distance > best.distance) {
      best = shot;
    }

    await interaction.editReply({
      content: `${interaction.user}님 발사 중 (${index + 1}/${contest.shots.length})`,
      embeds: [
        createWaterGunEmbed('shot', {
          shot,
          best,
          picked,
        }),
      ],
    });
    await wait(950);
  }

  await interaction.editReply({
    content: `${interaction.user}님의 사정 베팅 결과`,
    embeds: [
      createWaterGunEmbed('final', {
        user: interaction.user,
        picked,
        contest,
        didWin,
        result,
      }),
    ],
  });
}

async function handleBlackjack(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const wager = interaction.options.getInteger('금액', true);
  const result = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    const user = store.ensureUser(guild, interaction.user);
    const existingGame = guild.blackjackGames[interaction.user.id];

    if (existingGame) {
      return {
        ok: false,
        activeGame: existingGame,
      };
    }

    if (user.balance < wager) {
      return {
        ok: false,
        reason: `노코인이 부족합니다. 현재 잔액: ${formatCoins(user.balance)}`,
      };
    }

    user.balance -= wager;
    const game = createBlackjackGame(interaction.user.id, wager);
    const playerBlackjack = isBlackjackHand(game.player);
    const dealerBlackjack = isBlackjackHand(game.dealer);

    if (playerBlackjack && dealerBlackjack) {
      return {
        ok: true,
        game: settleBlackjackGame(guild, game, 'push', '둘 다 블랙잭입니다. 무승부로 베팅금을 돌려받았습니다.', wager),
      };
    }

    if (playerBlackjack) {
      return {
        ok: true,
        game: settleBlackjackGame(guild, game, 'win', '블랙잭입니다. 2.5배를 지급했습니다.', Math.floor(wager * 2.5)),
      };
    }

    if (dealerBlackjack) {
      return {
        ok: true,
        game: settleBlackjackGame(guild, game, 'loss', '딜러 블랙잭입니다. 패배했습니다.', 0),
      };
    }

    guild.blackjackGames[interaction.user.id] = game;
    return {
      ok: true,
      game,
    };
  });

  if (!result.ok && result.activeGame) {
    await reply(interaction, {
      content: '이미 진행 중인 블랙잭이 있습니다.',
      embeds: [createBlackjackEmbed(result.activeGame)],
      components: createBlackjackComponents(result.activeGame),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!result.ok) {
    await reply(interaction, {
      content: result.reason,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const ended = result.game.status !== 'active';
  await reply(interaction, {
    content: `${interaction.user}님의 블랙잭`,
    embeds: [
      createBlackjackEmbed(result.game, {
        revealDealer: ended,
        statusText: ended ? result.game.statusText : '카드를 받았습니다. 히트 또는 스탠드를 선택하세요.',
        color: result.game.outcome === 'win' ? 0x2ecc71 : result.game.outcome === 'loss' ? 0xe74c3c : 0x5865f2,
      }),
    ],
    components: createBlackjackComponents(result.game),
  });
}

async function handleBlackjackUiInteraction(interaction) {
  const parsed = parseBlackjackCustomId(interaction.customId);
  if (!parsed) {
    return false;
  }

  if (!interaction.isButton()) {
    return false;
  }

  if (!(await requireGuild(interaction))) {
    return true;
  }

  if (parsed.userId !== interaction.user.id) {
    await interaction.reply({
      content: '이 블랙잭은 시작한 사람만 조작할 수 있습니다.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const result = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    const game = guild.blackjackGames[interaction.user.id];

    if (!game) {
      return {
        ok: false,
        reason: '진행 중인 블랙잭을 찾을 수 없습니다. `/블랙잭`으로 새 게임을 시작해 주세요.',
      };
    }

    if (parsed.action === 'hit') {
      game.player.push(drawBlackjackCard(game));
      game.updatedAt = new Date().toISOString();

      if (getBlackjackHandValue(game.player) > 21) {
        return {
          ok: true,
          game: settleBlackjackGame(guild, game, 'loss', '21을 넘었습니다. 패배했습니다.', 0),
        };
      }

      return {
        ok: true,
        game,
        statusText: '카드를 한 장 더 받았습니다.',
      };
    }

    if (parsed.action === 'stand') {
      return {
        ok: true,
        game: finishBlackjackStand(guild, game),
      };
    }

    if (parsed.action === 'surrender') {
      return {
        ok: true,
        game: settleBlackjackGame(guild, game, 'loss', '기권했습니다. 베팅금의 절반을 돌려받았습니다.', Math.floor(game.wager / 2)),
      };
    }

    return {
      ok: false,
      reason: '알 수 없는 블랙잭 버튼입니다.',
    };
  });

  if (!result.ok) {
    await interaction.reply({
      content: result.reason,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const ended = result.game.status !== 'active';
  await interaction.update({
    embeds: [
      createBlackjackEmbed(result.game, {
        revealDealer: ended,
        statusText: ended ? result.game.statusText : result.statusText,
        color: result.game.outcome === 'win' ? 0x2ecc71 : result.game.outcome === 'loss' ? 0xe74c3c : 0x5865f2,
      }),
    ],
    components: createBlackjackComponents(result.game),
  });

  return true;
}

async function handleUpdate(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  if (!isBotManager(interaction)) {
    await reply(interaction, {
      content: '명령어 동기화는 서버 관리자만 사용할 수 있습니다.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const scope = interaction.options.getString('범위') || resolveCommandScope({
    configuredScope: config.syncScope,
    guildId: interaction.guildId,
  });
  const wantsGlobal = scope === 'global';
  const isOwner = ownerIds.has(interaction.user.id);

  if (wantsGlobal && !isOwner) {
    await reply(interaction, {
      content: '전역 동기화는 BOT_OWNER_IDS에 등록된 유저만 사용할 수 있습니다.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const applicationId = config.clientId || client.user.id;
  const result = await syncCommands({
    token: config.token,
    clientId: applicationId,
    guildId: interaction.guildId,
    scope: wantsGlobal ? 'global' : 'guild',
    clearGuildIds: wantsGlobal ? [interaction.guildId] : [],
  });

  const target = result.scope === 'global' ? '전역' : '현재 서버';
  const clearedText = result.clearedGuildIds?.length
    ? '\n중복 방지를 위해 현재 서버의 예전 서버 전용 명령어를 비웠습니다.'
    : '';
  await reply(interaction, `${target} 명령어 ${result.count}개를 동기화했습니다.${clearedText}`);
}

async function handleAutocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== '아이템') {
    await interaction.respond([]);
    return;
  }

  if (interaction.commandName === '아이템구매') {
    await interaction.respond(getShopAutocompleteChoices(focused.value));
    return;
  }

  if (!interaction.guildId) {
    await interaction.respond([]);
    return;
  }

  const choices = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    const user = store.ensureUser(guild, interaction.user);

    if (interaction.commandName === '아이템사용') {
      return getInventoryAutocompleteChoices(user, focused.value);
    }

    if (interaction.commandName === '아이템강화') {
      return getEvolutionAutocompleteChoices(user, focused.value);
    }

    if (interaction.commandName === '아이템수리') {
      return getEvolutionAutocompleteChoices(user, focused.value, true);
    }

    return [];
  });

  await interaction.respond(choices);
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  if (config.autoSyncCommands) {
    try {
      const scope = resolveCommandScope({
        configuredScope: config.syncScope,
        guildId: config.guildId,
      });
      const guildId = scope === 'guild' ? config.guildId : undefined;
      const clearGuildIds = scope === 'global'
        ? readyClient.guilds.cache.map((guild) => guild.id)
        : [];
      if (scope === 'global' && !config.guildId) {
        console.warn('DISCORD_GUILD_ID is not set. Auto-syncing global commands; Discord may take a while to show them.');
      }
      await syncCommands({
        token: config.token,
        clientId: config.clientId || readyClient.user.id,
        guildId,
        scope,
        clearGuildIds,
      });
      const cleaned = clearGuildIds.length > 0 ? ` Cleared guild commands in ${clearGuildIds.length} guild(s) to prevent duplicates.` : '';
      console.log(`Auto-synced commands to ${scope}.${cleaned}`);
    } catch (error) {
      console.warn(`Auto command sync failed: ${error.message}`);
    }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction);
      return;
    }

    if (interaction.isStringSelectMenu() || interaction.isButton() || interaction.isModalSubmit()) {
      const handledBet = await handleBetUiInteraction(interaction);
      if (handledBet) {
        return;
      }

      const handledItemEnhance = await handleItemEnhanceUiInteraction(interaction);
      if (handledItemEnhance) {
        return;
      }

      const handledBlackjack = await handleBlackjackUiInteraction(interaction);
      if (handledBlackjack) {
        return;
      }

      const handledPolymarket = await handlePolymarketUiInteraction(interaction);
      if (handledPolymarket) {
        return;
      }

      const handledBattle = await handleBattleUiInteraction(interaction);
      if (handledBattle) {
        return;
      }
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    switch (interaction.commandName) {
      case '도움말':
        await handleHelp(interaction);
        break;
      case '지갑':
        await handleWallet(interaction);
        break;
      case '랭킹':
        await handleRanking(interaction);
        break;
      case '출석':
        await handleAttendance(interaction);
        break;
      case '복권':
        await handleLottery(interaction);
        break;
      case '지급':
        await handleGrant(interaction);
        break;
      case '베팅생성':
        await handleCreateBet(interaction);
        break;
      case '베팅목록':
        await handleBetList(interaction);
        break;
      case '베팅정보':
        await handleBetInfo(interaction);
        break;
      case '베팅':
        await handlePlaceBet(interaction);
        break;
      case '베팅종료':
        await handleCloseBet(interaction);
        break;
      case '낚시':
        await handleFishing(interaction);
        break;
      case '보관함':
        await handleInventory(interaction);
        break;
      case '상태':
        await handleStatus(interaction);
        break;
      case '아이템확률':
        await handleItemRates(interaction);
        break;
      case '상점':
        await handleShop(interaction);
        break;
      case '아이템구매':
        await handleBuyItem(interaction);
        break;
      case '아이템수리':
        await handleRepairItem(interaction);
        break;
      case '아이템사용':
        await handleUseItem(interaction);
        break;
      case '아이템합성':
        await handleSynthesizeItem(interaction);
        break;
      case '아이템강화':
        await handleEnhanceItem(interaction);
        break;
      case '결투':
        await handleBattle(interaction);
        break;
      case '구걸':
        await handleBegging(interaction);
        break;
      case '동전던지기':
        await handleCoinFlip(interaction);
        break;
      case '주사위':
        await handleDice(interaction);
        break;
      case '배치':
        await handlePlacementExam(interaction);
        break;
      case '배치확률':
        await handlePlacementExamOdds(interaction);
        break;
      case '사정':
        await handleWaterGun(interaction);
        break;
      case '블랙잭':
        await handleBlackjack(interaction);
        break;
      case '폴리마켓검색':
        await handlePolymarketSearch(interaction);
        break;
      case '폴리마켓생성':
        await handlePolymarketCreate(interaction);
        break;
      case '업데이트':
        await handleUpdate(interaction);
        break;
      default:
        await reply(interaction, {
          content: '알 수 없는 명령어입니다. `/업데이트`로 명령어를 동기화해 주세요.',
          flags: MessageFlags.Ephemeral,
        });
    }
  } catch (error) {
    console.error(error);
    if (interaction.isAutocomplete()) {
      try {
        await interaction.respond([]);
      } catch (autocompleteError) {
        if (!isExpiredInteractionError(autocompleteError)) {
          console.warn(`Failed to send autocomplete fallback: ${autocompleteError.message}`);
        }
      }
      return;
    }

    const message = '명령어 처리 중 오류가 발생했습니다. 콘솔 로그를 확인해 주세요.';
    await safeErrorReply(interaction, message);
  }
});

if (!config.token) {
  console.error('DISCORD_TOKEN is required.');
  process.exit(1);
}

startHealthServer();
client.login(config.token);
