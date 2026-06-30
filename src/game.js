function formatCoins(amount) {
  return `${Math.floor(amount).toLocaleString('ko-KR')} 노코인`;
}

function formatRemaining(ms) {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;

  if (minutes <= 0) {
    return `${rest}초`;
  }

  return rest === 0 ? `${minutes}분` : `${minutes}분 ${rest}초`;
}

function normalizeKey(value) {
  return String(value || '').trim().toLocaleLowerCase('ko-KR');
}

function parseOptions(rawOptions) {
  const options = String(rawOptions || '')
    .split(',')
    .map((option) => option.trim())
    .filter(Boolean);

  const seen = new Set();
  const unique = [];

  for (const option of options) {
    const key = normalizeKey(option);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(option.slice(0, 60));
    }
  }

  return unique;
}

function findOption(bet, optionName) {
  const key = normalizeKey(optionName);
  return bet.options.find((option) => normalizeKey(option.name) === key);
}

function nextBetId(guild) {
  const id = `B${guild.nextBetNumber}`;
  guild.nextBetNumber += 1;
  return id;
}

function totalBetPool(bet) {
  return Object.values(bet.wagers || {}).reduce((total, wager) => total + wager.amount, 0);
}

function optionPools(bet) {
  const pools = {};

  for (const option of bet.options) {
    pools[option.name] = 0;
  }

  for (const wager of Object.values(bet.wagers || {})) {
    pools[wager.option] = (pools[wager.option] || 0) + wager.amount;
  }

  return pools;
}

function weightedPick(table) {
  const totalWeight = table.reduce((sum, item) => sum + item.weight, 0);
  let roll = Math.random() * totalWeight;

  for (const item of table) {
    roll -= item.weight;
    if (roll <= 0) {
      return item;
    }
  }

  return table[table.length - 1];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function scaleAmount(amount, multiplier = 1) {
  return Math.max(0, Math.floor(amount * multiplier));
}

const ITEM_GRADE_CONFIGS = {
  common: {
    key: 'common',
    label: '일반',
    color: 0x95a5a6,
    swatch: '⬜',
    baseCost: 8000,
    costGrowth: 0.22,
    statGain: 1,
    chanceMultiplier: 1,
    destroyMultiplier: 0.85,
    maxDurability: 70,
  },
  uncommon: {
    key: 'uncommon',
    label: '고급',
    color: 0x2ecc71,
    swatch: '🟩',
    baseCost: 15000,
    costGrowth: 0.28,
    statGain: 2,
    chanceMultiplier: 0.96,
    destroyMultiplier: 0.95,
    maxDurability: 85,
  },
  rare: {
    key: 'rare',
    label: '희귀',
    color: 0x3498db,
    swatch: '🟦',
    baseCost: 30000,
    costGrowth: 0.35,
    statGain: 3,
    chanceMultiplier: 0.92,
    destroyMultiplier: 1,
    maxDurability: 100,
  },
  epic: {
    key: 'epic',
    label: '영웅',
    color: 0x9b59b6,
    swatch: '🟪',
    baseCost: 60000,
    costGrowth: 0.45,
    statGain: 5,
    chanceMultiplier: 0.88,
    destroyMultiplier: 1.08,
    maxDurability: 120,
  },
  legendary: {
    key: 'legendary',
    label: '전설',
    color: 0xf1c40f,
    swatch: '🟨',
    baseCost: 120000,
    costGrowth: 0.58,
    statGain: 8,
    chanceMultiplier: 0.84,
    destroyMultiplier: 1.18,
    maxDurability: 145,
  },
  mythic: {
    key: 'mythic',
    label: '신화',
    color: 0xe74c3c,
    swatch: '🟥',
    baseCost: 250000,
    costGrowth: 0.75,
    statGain: 12,
    chanceMultiplier: 0.8,
    destroyMultiplier: 1.3,
    maxDurability: 180,
  },
};
const ENHANCEMENT_LEVEL_CHANCES = [
  0.92,
  0.84,
  0.76,
  0.66,
  0.55,
  0.44,
  0.34,
  0.25,
  0.18,
  0.12,
  0.08,
  0.05,
];
const ENHANCEMENT_DESTROY_CHANCES = [
  0,
  0,
  0,
  0,
  0,
  0.08,
  0.12,
  0.17,
  0.23,
  0.3,
  0.38,
  0.46,
];
const PROTECTION_TICKET_CHANCE = 0.001;
const FISHING_FAILURE_CHANCE = 0.25;
const FISHING_ITEM_ROLL_CHANCE = Math.max(0, 1 - FISHING_FAILURE_CHANCE - PROTECTION_TICKET_CHANCE);
const ITEM_USE_CHANCES = {
  common: 0.92,
  uncommon: 0.84,
  rare: 0.74,
  epic: 0.62,
  legendary: 0.5,
  mythic: 0.38,
};

function getItemGradeConfig(gradeKey = 'common') {
  return ITEM_GRADE_CONFIGS[gradeKey] || ITEM_GRADE_CONFIGS.common;
}

function getItemEnhancementCost(gradeKey, enhanceLevel = 0) {
  const grade = getItemGradeConfig(gradeKey);
  const level = Math.max(0, Math.floor(enhanceLevel));
  return Math.floor(grade.baseCost * (1 + grade.costGrowth * level + 0.06 * level * level));
}

function getItemEnhancementRates(gradeKey, enhanceLevel = 0) {
  const grade = getItemGradeConfig(gradeKey);
  const level = Math.max(0, Math.floor(enhanceLevel));
  const baseSuccessChance = ENHANCEMENT_LEVEL_CHANCES[Math.min(level, ENHANCEMENT_LEVEL_CHANCES.length - 1)];
  const baseDestroyChance = ENHANCEMENT_DESTROY_CHANCES[Math.min(level, ENHANCEMENT_DESTROY_CHANCES.length - 1)];
  const successChance = Math.max(0.01, Math.min(0.98, baseSuccessChance * (grade.chanceMultiplier || 1)));
  const destructionChance = level < 5
    ? 0
    : Math.max(0, Math.min(0.9 - successChance, baseDestroyChance * (grade.destroyMultiplier || 1)));
  const failureChance = Math.max(0, 1 - successChance - destructionChance);

  return {
    successChance,
    failureChance,
    destructionChance,
  };
}

function getItemEnhancementChance(gradeKey, enhanceLevel = 0) {
  return getItemEnhancementRates(gradeKey, enhanceLevel).successChance;
}

function rollItemEnhancement(gradeKey, enhanceLevel = 0) {
  const rates = getItemEnhancementRates(gradeKey, enhanceLevel);
  const roll = Math.random();
  const success = roll < rates.successChance;
  const destroyed = !success && roll < rates.successChance + rates.destructionChance;

  return {
    ...rates,
    chance: rates.successChance,
    success,
    destroyed,
    failed: !success,
  };
}

function getItemUseChance(gradeKey = 'common') {
  const grade = getItemGradeConfig(gradeKey);
  return ITEM_USE_CHANCES[grade.key] || ITEM_USE_CHANCES.common;
}

function rollItemUse(gradeKey = 'common') {
  const chance = getItemUseChance(gradeKey);
  return {
    chance,
    success: Math.random() < chance,
  };
}

const FISHING_TABLE = [
  { name: '낡은 세냥 양말', min: 5, max: 20, weight: 20 },
  { name: '남랭이 딜도', min: 20, max: 60, weight: 35 },
  { name: '쿼카의 상자', min: 60, max: 140, weight: 25 },
  { name: '도라이의 토스 계좌', min: 80, max: 160, weight: 18 },
  { name: '한도 끝난 골탱의 GPT 계정', min: 120, max: 220, weight: 14 },
  { name: '물에 젖은 라마의 휴대폰', min: 160, max: 280, weight: 10 },
  { name: '초야가 찢은 남랭의 스타킹', min: 220, max: 360, weight: 7 },
  { name: '히나의 비타민칼', min: 180, max: 360, weight: 8 },
  { name: '전설의 피아제 시계', min: 600, max: 1200, weight: 1 },
  { name: '히나의 전라도 땅크', min: 1500, max: 3000, weight: 0.45 },
  { name: '노공팔의 GRH 증명 연구', min: 2500, max: 5000, weight: 0.3 },
  { name: '라마의 잃어버린 부랄', min: 5000, max: 10000, weight: 0.15 },
];

const ITEM_EVOLUTION_DEFINITIONS = [
  {
    itemName: '낡은 세냥 양말',
    grade: 'common',
    evolution: '방사능 양말술사',
    stance: '오래 묵은 섬유를 흔들어 공기를 장악합니다.',
    attack: '세냥 암내 살포',
    motion: '낡은 양말을 휘둘러 녹슨 암내 구름을 밀어냅니다.',
    ultimate: '양말 투척',
    ultimateMotion: '세냥 암내가 진동하는 양말을 던져서 상대의 코를 괴사시킴.',
    statBias: { attack: 2, defense: 1, luck: 0 },
  },
  {
    itemName: '남랭이 딜도',
    grade: 'common',
    evolution: '항문 확장자',
    stance: '딜도를 활용하여 똥꼬를 넓힌다.',
    attack: '강타',
    motion: '딜도를 둔기로 활용한다.',
    ultimate: '변비 예방',
    ultimateMotion: '똥꼬를 딜도로 1초에 523번 휘젓는다.',
    statBias: { attack: 3, defense: 0, luck: 1 },
  },
  {
    itemName: '쿼카의 상자',
    grade: 'common',
    evolution: '???',
    stance: '상자 뚜껑 사이로 여러 함정 장치가 번갈아 빛납니다.',
    attack: '세냥 야짤 공개',
    motion: '상자를 열자 튀어나온 세냥 야짤들이 상대의 눈을 실명시킨다',
    ultimate: '멘헤라 모드 온',
    ultimateMotion: '상자 안에서 발견된 노무현의 유서를 보고 자살충동이 들어 자살한다',
    statBias: { attack: 1, defense: 1, luck: 3 },
  },
  {
    itemName: '도라이의 토스 계좌',
    grade: 'uncommon',
    evolution: '송금 교란자',
    stance: '끊임없는 송금 알림으로 상대 집중력을 흐트러뜨립니다.',
    attack: '1원 알림 폭격',
    motion: '연속 송금 알림으로 상대의 리듬을 끊어냅니다.',
    ultimate: '빚 탕감',
    ultimateMotion: '사채업자를 소환해서 공격하게 한다.',
    statBias: { attack: 1, defense: 0, luck: 4 },
  },
  {
    itemName: '한도 끝난 골탱의 GPT 계정',
    grade: 'uncommon',
    evolution: '토큰 고갈 백수',
    stance: '느려진 응답창이 상대를 발정시킨다',
    attack: '로딩 지연장',
    motion: '끝나지 않는 로딩 표시가 상대의 판단을 급격히 흔듭니다.',
    ultimate: 'OAI 정책 위반',
    ultimateMotion: '경찰이 투입되어 체포하려고 한다',
    statBias: { attack: 1, defense: 3, luck: 1 },
  },
  {
    itemName: '물에 젖은 라마의 휴대폰',
    grade: 'rare',
    evolution: '병신',
    stance: '깨진 화면 아래로 물방울과 전류가 동시에 흐릅니다.',
    attack: '젖은 회로 스파크',
    motion: '휴대폰에서 튄 작은 전류가 상대의 균형을 흔듭니다.',
    ultimate: '수제 EMP 탄',
    ultimateMotion: '검은 화면이 번쩍이며 주변 장비를 한순간 마비시킵니다.',
    statBias: { attack: 2, defense: 2, luck: 1 },
  },
  {
    itemName: '초야가 찢은 남랭의 스타킹',
    grade: 'rare',
    evolution: '남랭이의 맛좀 봐랏',
    stance: '스타킹을 초야에게 팔아서 돈을 모은다',
    attack: '매혹',
    motion: '상대가 당신과 번식하고 싶게 만든다',
    ultimate: '초야 소환',
    ultimateMotion: '남랭이의 노예인 초야 소환해서 따먹는다',
    statBias: { attack: 1, defense: 2, luck: 2 },
  },
  {
    itemName: '히나의 비타민칼',
    grade: 'rare',
    evolution: '폭주 멘헤라',
    stance: '칼날 끝에서 선명한 피가 맺힌다',
    attack: '검술',
    motion: '짧은 보폭으로 파고들어 빛나는 칼날을 사선으로 긋습니다.',
    ultimate: '마약 OD',
    ultimateMotion: '비타500에 물뽕을 타서 먹인다',
    statBias: { attack: 3, defense: 1, luck: 0 },
  },
  {
    itemName: '전설의 피아제 시계',
    grade: 'epic',
    evolution: '중력 마스터',
    stance: '확 올라갔다 확 내려간다',
    attack: '밀치기',
    motion: '상대를 논두령으로 밀어버린다',
    ultimate: '중력 낙하',
    ultimateMotion: '중력을 없애 고속 상승한 뒤 압도적인 낙하 충격을 일으킵니다.',
    statBias: { attack: 3, defense: 2, luck: 3 },
  },
  {
    itemName: '히나의 전라도 땅크',
    grade: 'legendary',
    evolution: '두환이의 뒤를 잇는다',
    stance: '무거운 궤도음이 깔리며 히나의 집 앞으로 향한다',
    attack: '돌진',
    motion: '묵직한 전진으로 상대 자세를 밀어붙입니다.',
    ultimate: '철갑탄 발사',
    ultimateMotion: '주포를 발사한다. 그런데 쏘고 보니 히나의 집이 사라졌노',
    statBias: { attack: 3, defense: 4, luck: 0 },
  },
  {
    itemName: '노공팔의 GRH 증명 연구',
    grade: 'legendary',
    evolution: '여긴 어디 나는 누구',
    stance: '복잡한 수식이 발밑에 펼쳐져 상대의 지능을 퇴화시킨다',
    attack: '정리 전개',
    motion: '논리식이 연결되며 노공팔의 물리공격이 시작된다',
    ultimate: 'RNN',
    ultimateMotion: 'RNN이 소환되며 당신을 세냥과 초야 사이에 박는다',
    statBias: { attack: 2, defense: 2, luck: 3 },
  },
  {
    itemName: '라마의 잃어버린 부랄',
    grade: 'mythic',
    evolution: '유전자 조작자',
    stance: '존재하지 않는 것을 가진 자.',
    attack: '콩알탄',
    motion: '복제된 부랄을 흩뿌리며 상대에게 공포를 안깁니다.',
    ultimate: '중성화',
    ultimateMotion: '상대의 부랄을 손으로 으깬 뒤 강한 발차기로 중성화를 마무리합니다.',
    statBias: { attack: 4, defense: 2, luck: 1 },
  },
];

const ITEM_EVOLUTIONS = Object.fromEntries(
  ITEM_EVOLUTION_DEFINITIONS.map((definition) => [normalizeKey(definition.itemName), definition]),
);

const BEGGING_TABLE = [
  { text: '지나가던 사람이 잔돈을 건넸습니다(정말 구걸하는 사람처럼 생겼군요).', min: 15, max: 80, weight: 45 },
  { text: '편의점 앞에서 뜻밖의 후원을 받았습니다(세냥보다 잘생겨서 받은듯).', min: 60, max: 160, weight: 28 },
  { text: '아무도 관심을 주지 않았습니다(초야와 섹스하면 관심받을 수도?).', min: 0, max: 0, weight: 22 },
  { text: '노코인 부자가 크게 베풀었습니다(우흥~).', min: 250, max: 500, weight: 5 },
];

function fishReward(multiplier = 1) {
  const eventRoll = Math.random();

  if (eventRoll < FISHING_FAILURE_CHANCE) {
    return {
      label: '빈 낚싯바늘',
      amount: 0,
      baseAmount: 0,
      weight: 0,
      type: 'failure',
      failed: true,
      chance: FISHING_FAILURE_CHANCE,
    };
  }

  if (eventRoll < FISHING_FAILURE_CHANCE + PROTECTION_TICKET_CHANCE) {
    return {
      label: '강화 방지권',
      amount: 0,
      baseAmount: 0,
      weight: 0,
      type: 'protection_ticket',
      protectionTicket: true,
      chance: PROTECTION_TICKET_CHANCE,
    };
  }

  const picked = weightedPick(FISHING_TABLE);
  const baseAmount = randomInt(picked.min, picked.max);
  return {
    label: picked.name,
    amount: scaleAmount(baseAmount, multiplier),
    baseAmount,
    weight: picked.weight,
  };
}

function begReward(multiplier = 1) {
  const picked = weightedPick(BEGGING_TABLE);
  const baseAmount = randomInt(picked.min, picked.max);
  return {
    label: picked.text,
    amount: scaleAmount(baseAmount, multiplier),
    baseAmount,
    weight: picked.weight,
  };
}

function getItemEvolution(itemName) {
  const key = normalizeKey(itemName);
  return ITEM_EVOLUTIONS[key] || {
    itemName,
    evolution: `${itemName} 사용자`,
    stance: '낚시 아이템의 기운을 몸에 두릅니다.',
    attack: '즉흥 타격',
    motion: '아이템의 무게를 이용해 정면으로 밀어붙입니다.',
    ultimate: '노코인 폭발',
    ultimateMotion: '모은 기운을 한 번에 터뜨립니다.',
    grade: 'common',
    statBias: { attack: 1, defense: 1, luck: 1 },
  };
}

function listFishingItems(multiplier = 1) {
  const totalWeight = FISHING_TABLE.reduce((sum, item) => sum + item.weight, 0);

  return FISHING_TABLE.map((item) => {
    const evolution = getItemEvolution(item.name);
    const grade = getItemGradeConfig(evolution.grade);
    const averageBaseAmount = Math.floor((item.min + item.max) / 2);
    return {
      name: item.name,
      min: scaleAmount(item.min, multiplier),
      max: scaleAmount(item.max, multiplier),
      averageAmount: scaleAmount(averageBaseAmount, multiplier),
      averageBaseAmount,
      weight: item.weight,
      chance: FISHING_ITEM_ROLL_CHANCE * (item.weight / totalWeight),
      itemPoolChance: item.weight / totalWeight,
      grade,
      evolution,
    };
  });
}

function listItemGradeDropRates() {
  const totalWeight = FISHING_TABLE.reduce((sum, item) => sum + item.weight, 0);
  const grouped = new Map();

  for (const item of FISHING_TABLE) {
    const evolution = getItemEvolution(item.name);
    const grade = getItemGradeConfig(evolution.grade);
    const current = grouped.get(grade.key) || {
      grade,
      weight: 0,
      itemCount: 0,
    };
    current.weight += item.weight;
    current.itemCount += 1;
    grouped.set(grade.key, current);
  }

  return Array.from(grouped.values()).map((entry) => ({
    ...entry,
    chance: FISHING_ITEM_ROLL_CHANCE * (entry.weight / totalWeight),
    itemPoolChance: entry.weight / totalWeight,
  }));
}

function getFishingProtectionTicketChance() {
  return PROTECTION_TICKET_CHANCE;
}

function getFishingFailureChance() {
  return FISHING_FAILURE_CHANCE;
}

function listItemEvolutions() {
  return ITEM_EVOLUTION_DEFINITIONS.slice();
}

module.exports = {
  begReward,
  findOption,
  fishReward,
  formatCoins,
  formatRemaining,
  getItemEnhancementChance,
  getItemEnhancementCost,
  getItemEnhancementRates,
  getItemEvolution,
  getItemGradeConfig,
  getItemUseChance,
  getFishingProtectionTicketChance,
  getFishingFailureChance,
  listFishingItems,
  listItemGradeDropRates,
  listItemEvolutions,
  nextBetId,
  normalizeKey,
  optionPools,
  parseOptions,
  randomInt,
  rollItemEnhancement,
  rollItemUse,
  totalBetPool,
};
