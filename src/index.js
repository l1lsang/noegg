const http = require('node:http');
const { randomUUID } = require('node:crypto');
const {
  ActionRowBuilder,
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
  getItemEvolution,
  nextBetId,
  normalizeKey,
  optionPools,
  parseOptions,
  randomInt,
  totalBetPool,
} = require('./game');

const store = createStore(config);
const ownerIds = new Set(config.ownerIds);
const economyMultiplier = Math.max(1, Math.floor(config.economyMultiplier || 1));
const quickBetAmounts = [100, 500, 1000].map((amount) => amount * economyMultiplier);
const koreaTimeZone = 'Asia/Seoul';
const blackjackSuits = ['♠', '♥', '♦', '♣'];
const blackjackRanks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const battleChallenges = new Map();
const battleChallengeTtlMs = 5 * 60 * 1000;

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

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(normalized);
    return;
  }

  await interaction.reply(normalized);
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

  const filled = Math.max(1, Math.round((value / total) * size));
  return `${'█'.repeat(filled)}${'░'.repeat(size - filled)}`;
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

function battleCustomId(action, challengeId) {
  return ['battle', action, challengeId].join(':');
}

function parseBattleCustomId(customId) {
  const parts = String(customId || '').split(':');
  if (parts[0] !== 'battle') {
    return null;
  }

  return {
    action: parts[1],
    challengeId: parts[2],
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

function getUserEvolutions(user) {
  const evolutions = user.evolutions && typeof user.evolutions === 'object' ? user.evolutions : {};
  return Object.entries(evolutions)
    .map(([key, rawEvolution]) => {
      const record = rawEvolution && typeof rawEvolution === 'object' ? rawEvolution : {};
      const itemName = record.itemName || key;
      const definition = getItemEvolution(itemName);
      return {
        key,
        itemName,
        name: record.name || definition.evolution,
        level: Number.isFinite(record.level) ? Math.max(1, Math.floor(record.level)) : 1,
        used: Number.isFinite(record.used) ? Math.max(1, Math.floor(record.used)) : 1,
        lastUsedAt: record.lastUsedAt || null,
        definition,
      };
    })
    .sort((a, b) => b.level - a.level || b.used - a.used || a.name.localeCompare(b.name, 'ko-KR'));
}

function getBattleStyle(user) {
  const evolutions = getUserEvolutions(user);
  const totals = evolutions.reduce(
    (sum, evolution) => {
      const bias = getEvolutionStatBias(evolution.definition);
      const levelWeight = Math.max(1, evolution.level);
      sum.attack += bias.attack * levelWeight;
      sum.defense += bias.defense * levelWeight;
      sum.luck += bias.luck * levelWeight;
      return sum;
    },
    { attack: 0, defense: 0, luck: 0 },
  );

  return {
    evolutions,
    attackBonus: Math.min(40, totals.attack),
    defenseBonus: Math.min(40, totals.defense),
    luckBonus: Math.min(40, totals.luck),
  };
}

function formatEvolutionSummary(user, maxItems = 4) {
  const evolutions = getUserEvolutions(user);
  if (evolutions.length === 0) {
    return '아직 진화가 없습니다. `/아이템사용`으로 낚시 아이템을 사용해 진화할 수 있습니다.';
  }

  return evolutions
    .slice(0, maxItems)
    .map((evolution) => `${evolution.name} Lv.${evolution.level} (${evolution.itemName})`)
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
  const evolutionLevel = Math.max(1, evolution.level || 1);
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
      `${getBattleDisplayName(attackerId, records)} [${evolution.name} Lv.${evolutionLevel}]`,
      `${shouldUltimate ? '궁극기' : '기술'}: ${attackName}`,
      `${motion}`,
      `<@${defenderId}>에게 ${damage} 피해`,
    ].join('\n'),
  };
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

function applyItemEvolution(user, item, evolution) {
  user.evolutions ||= {};
  const current = user.evolutions[item.key] && typeof user.evolutions[item.key] === 'object'
    ? user.evolutions[item.key]
    : {};
  const level = Math.max(0, Math.floor(current.level || 0)) + 1;

  user.evolutions[item.key] = {
    itemName: item.name,
    name: evolution.evolution,
    level,
    used: Math.max(0, Math.floor(current.used || 0)) + 1,
    attack: evolution.attack,
    ultimate: evolution.ultimate,
    lastUsedAt: new Date().toISOString(),
  };

  return user.evolutions[item.key];
}

function createInventoryEmbed(target, user) {
  const items = getInventoryItems(user);
  const power = getUserPower(user);
  const displayName = target.globalName || target.username || user.displayName || user.username || target.id;
  const itemLines = items.length > 0
    ? items.slice(0, 12).map((item, index) => {
      const valueText = item.bestValue > 0 ? `최고 ${formatCoins(item.bestValue)}` : '가치 미기록';
      return `${index + 1}. ${item.name} x${item.count} (${valueText})`;
    }).join('\n')
    : '아직 보관함이 비어 있습니다. `/낚시`로 첫 아이템을 잡아보세요.';

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`${displayName}님의 보관함`)
    .setDescription(itemLines)
    .addFields(
      {
        name: '강화 수치',
        value: `공격 ${power.attack} / 방어 ${power.defense} / 행운 ${power.luck}`,
        inline: false,
      },
      {
        name: '진화',
        value: formatEvolutionSummary(user),
        inline: false,
      },
      {
        name: '결투 기록',
        value: `${user.stats?.battlesWon || 0}승 ${user.stats?.battlesLost || 0}패 / 수익 ${formatCoins(user.stats?.battleProfit || 0)}`,
        inline: false,
      },
    );

  if (items.length > 12) {
    embed.setFooter({ text: `총 ${items.length}종 중 가치 높은 12종만 표시됩니다.` });
  }

  return embed;
}

function createItemUseEmbed(user, item, gain, power, remaining, evolutionRecord) {
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('아이템 진화 성공')
    .setDescription(`${user}님이 **${item.name}**을 사용해 **${evolutionRecord.name} Lv.${evolutionRecord.level}**로 진화했습니다.`)
    .addFields(
      { name: '강화 증가', value: `공격 +${gain.attack} / 방어 +${gain.defense} / 행운 +${gain.luck}`, inline: false },
      { name: '현재 수치', value: `공격 ${power.attack} / 방어 ${power.defense} / 행운 ${power.luck}`, inline: false },
      { name: '전투 기술', value: `${gain.evolution.attack}\n궁극기: ${gain.evolution.ultimate}`, inline: false },
      { name: '남은 아이템', value: `${remaining}개`, inline: true },
    );
}

function createFishingEmbed(stage, payload = {}) {
  const scenes = {
    cast: {
      color: 0x5865f2,
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
      color: 0xf1c40f,
      title: '입질 감지',
      text: '수면 아래에서 무언가 낚싯줄을 강하게 잡아당깁니다.',
      art: [
        '      |',
        '      |   운지',
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
      color: 0x2ecc71,
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
  };
  const scene = scenes[stage] || scenes.cast;
  const embed = new EmbedBuilder()
    .setColor(scene.color)
    .setTitle(scene.title)
    .setDescription(`${scene.text}\n\n\`\`\`\n${scene.art}\n\`\`\``);

  if (stage === 'caught' && payload.reward) {
    embed.addFields(
      { name: '획득 가치', value: formatCoins(payload.reward.amount), inline: true },
      { name: '보관함 추가', value: `${payload.inventoryItem?.name || payload.reward.label} x${payload.inventoryItem?.count || 1}`, inline: true },
      { name: '현재 잔액', value: formatCoins(payload.balance), inline: true },
    );
  }

  return embed;
}

function createBattleChallengeEmbed(challenge) {
  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('결투 신청')
    .setDescription(`<@${challenge.challengerId}>님이 <@${challenge.opponentId}>님에게 결투를 신청했습니다.`)
    .addFields(
      { name: '베팅 코인', value: challenge.wager > 0 ? formatCoins(challenge.wager) : '없음', inline: true },
      { name: '수락 제한', value: '5분', inline: true },
    );

  return embed;
}

function createBattleChallengeComponents(challengeId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(battleCustomId('accept', challengeId))
        .setLabel('수락')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(battleCustomId('decline', challengeId))
        .setLabel('거절')
        .setStyle(ButtonStyle.Secondary),
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
  const embed = new EmbedBuilder()
    .setColor(finalResult ? 0x57f287 : 0xed4245)
    .setTitle(finalResult ? '결투 종료' : '결투 중계')
    .setDescription(`<@${challenge.challengerId}> vs <@${challenge.opponentId}>`);

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

  const embed = new EmbedBuilder()
    .setColor(isOpen ? 0xd83a4b : 0x5865f2)
    .setTitle(`베팅 ${bet.id}`)
    .setDescription(`**${bet.topic}**`)
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
    .setFooter({ text: `생성자 ${bet.createdBy}` })
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

function createPolymarketMarketEmbed(market, charts = []) {
  const endDate = market.endDate ? getUnixTimestamp(market.endDate) : null;
  const outcomeLines = market.outcomes.map((outcome, index) => {
    const price = market.outcomePrices[index];
    return `**${truncateText(outcome, 80)}** · ${formatPolymarketPrice(price)}`;
  });
  const status = market.closed ? '종료됨' : market.active ? '진행 중' : '비활성';

  return new EmbedBuilder()
    .setColor(market.active ? 0x2ecc71 : 0x95a5a6)
    .setTitle(truncateText(market.question, 256))
    .setDescription([
      `[Polymarket에서 보기](${market.url})`,
      '이 봇은 시장 정보만 가져오며 실제 Polymarket 주문은 넣지 않습니다.',
    ].join('\n'))
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
    .setFooter({ text: '노코인 모의 베팅용 정보입니다.' });
}

function createPolymarketSearchEmbed(query, markets) {
  const embed = new EmbedBuilder()
    .setColor(0x27ae60)
    .setTitle('Polymarket 검색')
    .setDescription(`검색어: **${truncateText(query, 180)}**`);

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
  const embed = new EmbedBuilder()
    .setColor(0xd83a4b)
    .setTitle('진행 중인 베팅')
    .setDescription(`열린 베팅 ${openBets.length}개`);

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

  amountButtons.push(
    new ButtonBuilder()
      .setCustomId(betCustomId('amount', bet.id, optionIndex, 'all'))
      .setLabel('올인')
      .setStyle(ButtonStyle.Success)
      .setDisabled(balance <= 0),
  );

  amountButtons.push(
    new ButtonBuilder()
      .setCustomId(betCustomId('custom', bet.id, optionIndex))
      .setLabel('직접 입력')
      .setStyle(ButtonStyle.Secondary),
  );

  return [new ActionRowBuilder().addComponents(amountButtons)];
}

function createBetPickEmbed(bet, option, balance) {
  const pools = optionPools(bet);
  const total = totalBetPool(bet);
  const optionPool = pools[option.name] || 0;

  return new EmbedBuilder()
    .setColor(0xd83a4b)
    .setTitle(`${bet.id} · ${truncateText(option.name, 120)}`)
    .setDescription(`**${truncateText(bet.topic, 240)}**`)
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

function getBlackjackHandValue(cards) {
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

  return value;
}

function isBlackjackHand(cards) {
  return cards.length === 2 && getBlackjackHandValue(cards) === 21;
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
  const color = game.status === 'active' ? 0xf1c40f : options.color || 0x5865f2;

  return new EmbedBuilder()
    .setColor(color)
    .setTitle('블랙잭')
    .setDescription(statusText)
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
    .setFooter({ text: '블랙잭은 21에 가까운 쪽이 이깁니다.' })
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
  while (getBlackjackHandValue(game.dealer) < 17) {
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

    const wagerAmount = amount === 'all' ? user.balance : Number.parseInt(amount, 10);
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
  await reply(interaction, {
    content:
      [
        '`/지갑` 노코인 잔액 확인',
        '`/베팅생성` 주제와 선택지 만들기 및 UI 베팅 열기',
        '`/베팅목록` 진행 중인 베팅 보기',
        '`/베팅정보` 베팅 상세 UI 보기',
        '`/베팅` 노코인 걸기',
        '`/베팅종료` 정답 선택지로 정산',
        '`/낚시` 낚시로 노코인 획득',
        '`/보관함` 낚시 아이템과 강화 수치 확인',
        '`/아이템사용` 보관함 아이템으로 유저 강화',
        '`/결투` 상대와 결투 신청 및 노코인 베팅',
        '`/구걸` 시간 쿨타임마다 노코인 획득',
        '`/동전던지기` 앞면/뒷면 도박',
        '`/주사위` 1-6 숫자 맞히기',
        '`/블랙잭` 딜러와 블랙잭',
        '`/폴리마켓검색` Polymarket 정보로 노코인 베팅 생성',
        '`/폴리마켓생성` market ID로 노코인 베팅 생성',
        '`/업데이트` 명령어 동기화',
      ].join('\n'),
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
      power: getUserPower(user),
      itemCount: getInventoryItems(user).reduce((sum, item) => sum + item.count, 0),
    };
  });

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`${target.globalName || target.username}님의 지갑`)
    .addFields(
      { name: '잔액', value: formatCoins(result.balance), inline: true },
      { name: '보관 아이템', value: `${result.itemCount}개`, inline: true },
      { name: '강화 수치', value: `공격 ${result.power.attack} / 방어 ${result.power.defense} / 행운 ${result.power.luck}`, inline: false },
    );

  await reply(interaction, {
    content: `${target}님의 지갑입니다.`,
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

  await reply(interaction, {
    embeds: [createInventoryEmbed(target, result.user)],
  });
}

async function handleUseItem(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const itemName = interaction.options.getString('아이템', true).trim();
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

    const gain = getItemPowerGain(item);
    user.power.attack += gain.attack;
    user.power.defense += gain.defense;
    user.power.luck += gain.luck;
    user.stats.itemsUsed += 1;
    const evolutionRecord = applyItemEvolution(user, item, gain.evolution);

    const current = user.inventory[item.key];
    if (current && typeof current === 'object') {
      current.count = Math.max(0, Math.floor(current.count || 0) - 1);
      if (current.count <= 0) {
        delete user.inventory[item.key];
      }
    } else {
      delete user.inventory[item.key];
    }

    return {
      ok: true,
      item,
      gain,
      evolutionRecord,
      power: getUserPower(user),
      remaining: user.inventory[item.key]?.count || 0,
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
      createItemUseEmbed(
        interaction.user,
        result.item,
        result.gain,
        result.power,
        result.remaining,
        result.evolutionRecord,
      ),
    ],
  });
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
    createdAt: Date.now(),
  };
  battleChallenges.set(challengeId, challenge);

  await reply(interaction, {
    content: `${opponent}님, 결투 신청이 왔습니다.`,
    embeds: [createBattleChallengeEmbed(challenge)],
    components: createBattleChallengeComponents(challengeId),
  });
}

async function handleBattleUiInteraction(interaction) {
  const parsed = parseBattleCustomId(interaction.customId);
  if (!parsed) {
    return false;
  }

  if (!interaction.isButton()) {
    return false;
  }

  if (!(await requireGuild(interaction))) {
    return true;
  }

  const challenge = getBattleChallenge(parsed.challengeId, interaction.guildId);
  if (!challenge) {
    await interaction.reply({
      content: '이 결투 신청은 만료되었거나 찾을 수 없습니다.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (interaction.user.id !== challenge.opponentId) {
    await interaction.reply({
      content: '이 결투는 지목된 상대만 수락하거나 거절할 수 있습니다.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  battleChallenges.delete(parsed.challengeId);

  if (parsed.action === 'decline') {
    await interaction.update({
      content: '결투 신청이 거절되었습니다.',
      embeds: [
        new EmbedBuilder()
          .setColor(0x95a5a6)
          .setTitle('결투 취소')
          .setDescription(`<@${challenge.opponentId}>님이 <@${challenge.challengerId}>님의 결투 신청을 거절했습니다.`),
      ],
      components: [],
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

  await interaction.update({
    content: '결투가 시작되었습니다.',
    embeds: [createBattleBroadcastEmbed(challenge, null)],
    components: [],
  });

  const result = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    const challengerRecord = store.ensureUser(guild, challenge.challengerId);
    const opponentRecord = store.ensureUser(guild, challenge.opponentId);

    if (challenge.wager > 0 && challengerRecord.balance < challenge.wager) {
      return {
        ok: false,
        reason: `신청자의 노코인이 부족해서 결투가 취소됬다노. 현재 잔액: ${formatCoins(challengerRecord.balance)}`,
      };
    }

    if (challenge.wager > 0 && opponentRecord.balance < challenge.wager) {
      return {
        ok: false,
        reason: `상대의 노코인이 부족해서 결투가 취소됬다노. 현재 잔액: ${formatCoins(opponentRecord.balance)}`,
      };
    }

    if (challenge.wager > 0) {
      challengerRecord.balance -= challenge.wager;
      opponentRecord.balance -= challenge.wager;
    }

    const battle = simulateBattle(challenge, challengerRecord, opponentRecord);
    const winner = battle.winnerId === challenge.challengerId ? challengerRecord : opponentRecord;
    const loser = battle.loserId === challenge.challengerId ? challengerRecord : opponentRecord;
    const payout = challenge.wager * 2;

    winner.balance += payout;
    winner.stats.battlesWon += 1;
    winner.stats.battleProfit += challenge.wager;
    loser.stats.battlesLost += 1;
    loser.stats.battleProfit -= challenge.wager;

    return {
      ok: true,
      battle,
      finalResult: {
        winnerId: battle.winnerId,
        loserId: battle.loserId,
        payout,
        winnerBalance: winner.balance,
        loserBalance: loser.balance,
      },
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

  for (let visibleRounds = 1; visibleRounds <= result.battle.rounds.length; visibleRounds += 1) {
    await wait(900);
    await interaction.editReply({
      embeds: [createBattleBroadcastEmbed(challenge, result.battle, visibleRounds)],
    });
  }

  await wait(900);
  await interaction.editReply({
    content: '결투가 종료되었습니다.',
    embeds: [createBattleBroadcastEmbed(challenge, result.battle, result.battle.rounds.length, result.finalResult)],
    components: [],
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
  if (bet.source?.type === 'polymarket' && bet.source.marketId) {
    try {
      const market = await fetchPolymarketMarket(bet.source.marketId);
      const charts = await fetchPolymarketPriceCharts(market);
      embeds.push(createPolymarketMarketEmbed(market, charts));
    } catch (error) {
      embeds.push(
        new EmbedBuilder()
          .setColor(0xe67e22)
          .setTitle('Polymarket 차트')
          .setDescription(`차트를 불러오지 못했습니다: ${error.message}`),
      );
    }
  }

  await reply(interaction, {
    embeds,
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
    amount: rawAmount === 'all' ? 'all' : rawAmount,
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

  await interaction.followUp({
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
    embeds: [createBetEmbed(result.bet), createPolymarketMarketEmbed(market, charts)],
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
  await interaction.editReply({
    embeds: [createPolymarketMarketEmbed(market, charts)],
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
    embeds: [createBetEmbed(result.bet), createPolymarketMarketEmbed(market, charts)],
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
    user.balance += reward.amount;
    user.stats.fishing += 1;
    const inventoryItem = addInventoryItem(user, reward);
    guild.cooldowns.fishing[interaction.user.id] = now;

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
      createFishingEmbed('caught', {
        user: interaction.user,
        reward: result.reward,
        inventoryItem: result.inventoryItem,
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

  await reply(interaction, `${interaction.user}님: ${result.reward.label} ${formatCoins(result.reward.amount)}을 얻었습니다. 현재 잔액: ${formatCoins(result.balance)}`);
}

async function handleCoinFlip(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const choice = interaction.options.getString('선택', true);
  const wager = interaction.options.getInteger('금액', true);
  const resultFace = Math.random() < 0.5 ? 'heads' : 'tails';
  const didWin = choice === resultFace;
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
  const embed = new EmbedBuilder()
    .setColor(didWin ? 0x2ecc71 : 0xe74c3c)
    .setTitle('동전 던지기')
    .setDescription(didWin ? '적중했습니다.' : '빗나갔습니다.')
    .addFields(
      { name: '내 선택', value: labels[choice], inline: true },
      { name: '결과', value: labels[resultFace], inline: true },
      { name: '지급', value: formatCoins(result.payout), inline: true },
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
  const roll = Math.floor(Math.random() * 6) + 1;
  const didWin = choice === roll;
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

  const embed = new EmbedBuilder()
    .setColor(didWin ? 0x2ecc71 : 0xe74c3c)
    .setTitle('주사위')
    .setDescription(didWin ? '정확히 맞혔습니다.' : '이번 숫자는 아니었습니다.')
    .addFields(
      { name: '내 선택', value: String(choice), inline: true },
      { name: '결과', value: String(roll), inline: true },
      { name: '지급', value: formatCoins(result.payout), inline: true },
      { name: '현재 잔액', value: formatCoins(result.balance), inline: true },
    );

  await reply(interaction, {
    content: `${interaction.user}님의 주사위 결과`,
    embeds: [embed],
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
    if (interaction.isStringSelectMenu() || interaction.isButton() || interaction.isModalSubmit()) {
      const handledBet = await handleBetUiInteraction(interaction);
      if (handledBet) {
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
      case '아이템사용':
        await handleUseItem(interaction);
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
    const message = '명령어 처리 중 오류가 발생했습니다. 콘솔 로그를 확인해 주세요.';

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: message });
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    }
  }
});

if (!config.token) {
  console.error('DISCORD_TOKEN is required.');
  process.exit(1);
}

startHealthServer();
client.login(config.token);
