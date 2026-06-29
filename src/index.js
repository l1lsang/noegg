const http = require('node:http');
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
  begReward,
  findOption,
  fishReward,
  formatCoins,
  formatRemaining,
  nextBetId,
  optionPools,
  parseOptions,
  totalBetPool,
} = require('./game');

const store = createStore(config);
const ownerIds = new Set(config.ownerIds);
const quickBetAmounts = [100, 500, 1000];
const koreaTimeZone = 'Asia/Seoul';
const blackjackSuits = ['♠', '♥', '♦', '♣'];
const blackjackRanks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

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

  return new EmbedBuilder()
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
        '`/구걸` 하루 1번 노코인 획득',
        '`/동전던지기` 앞면/뒷면 도박',
        '`/주사위` 1-6 숫자 맞히기',
        '`/블랙잭` 딜러와 블랙잭',
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
    };
  });

  await reply(interaction, {
    content: `${target}님의 잔액은 ${formatCoins(result.balance)}입니다.`,
  });
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

  await reply(interaction, {
    embeds: [createBetEmbed(bet)],
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

    const reward = fishReward();
    user.balance += reward.amount;
    user.stats.fishing += 1;
    guild.cooldowns.fishing[interaction.user.id] = now;

    return {
      ok: true,
      reward,
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

  await reply(interaction, `${interaction.user}님이 ${result.reward.label}을 낚아 ${formatCoins(result.reward.amount)}을 얻었습니다. 현재 잔액: ${formatCoins(result.balance)}`);
}

async function handleBegging(interaction) {
  if (!(await requireGuild(interaction))) {
    return;
  }

  const now = Date.now();
  const todayKey = getKoreaDayKey(now);
  const result = await store.run((data) => {
    const guild = store.ensureGuild(data, interaction.guildId);
    const user = store.ensureUser(guild, interaction.user);
    const migratedDayKey = guild.cooldowns.begging[interaction.user.id]
      ? getKoreaDayKey(guild.cooldowns.begging[interaction.user.id])
      : null;
    const lastUsedDay = guild.dailyActions.begging[interaction.user.id] || migratedDayKey;

    if (lastUsedDay === todayKey) {
      return { ok: false, remaining: getNextKoreaMidnightMs(now) - now };
    }

    const reward = begReward();
    user.balance += reward.amount;
    user.stats.begging += 1;
    guild.cooldowns.begging[interaction.user.id] = now;
    guild.dailyActions.begging[interaction.user.id] = todayKey;

    return {
      ok: true,
      reward,
      balance: user.balance,
    };
  });

  if (!result.ok) {
    await reply(interaction, {
      content: `오늘 구걸은 이미 했습니다. 한국시간 00:00에 초기화됩니다. 남은 시간: ${formatRemaining(result.remaining)}`,
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
  });

  const target = result.scope === 'global' ? '전역' : '현재 서버';
  await reply(interaction, `${target} 명령어 ${result.count}개를 동기화했습니다.`);
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
      if (scope === 'global' && !config.guildId) {
        console.warn('DISCORD_GUILD_ID is not set. Auto-syncing global commands; Discord may take a while to show them.');
      }
      await syncCommands({
        token: config.token,
        clientId: config.clientId || readyClient.user.id,
        guildId,
        scope,
      });
      console.log(`Auto-synced commands to ${scope}.`);
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
