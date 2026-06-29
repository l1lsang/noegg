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

const FISHING_TABLE = [
  { name: '낡은 세냥 양말', min: 5, max: 20, weight: 20 },
  { name: '남랭이 딜도', min: 20, max: 60, weight: 35 },
  { name: '쿼카의 상자', min: 60, max: 140, weight: 25 },
  { name: '도라이의 토스 계좌', min: 80, max: 160, weight: 18 },
  { name: '한도 끝난 골탱의 GPT 계정', min: 120, max: 220, weight: 14 },
  { name: '물에 젖은 라마의 휴대폰', min: 160, max: 280, weight: 10 },
  { name: '라마의 휴대폰', min: 220, max: 360, weight: 7 },
  { name: '히나의 비타민칼', min: 180, max: 360, weight: 8 },
  { name: '전설의 피아제 시계', min: 600, max: 1200, weight: 1 },
  { name: '히나의 전라도 땅크', min: 1500, max: 3000, weight: 0.45 },
  { name: '노공팔의 GRH 증명 연구', min: 2500, max: 5000, weight: 0.3 },
  { name: '라마의 잃어버린 부랄', min: 5000, max: 10000, weight: 0.15 },
];

const BEGGING_TABLE = [
  { text: '지나가던 사람이 잔돈을 건넸습니다(정말 구걸하는 사람처럼 생겼군요).', min: 15, max: 80, weight: 45 },
  { text: '편의점 앞에서 뜻밖의 후원을 받았습니다(세냥보다 잘생겨서 받은듯).', min: 60, max: 160, weight: 28 },
  { text: '아무도 관심을 주지 않았습니다(초야와 섹스하면 관심받을 수도?).', min: 0, max: 0, weight: 22 },
  { text: '노코인 부자가 크게 베풀었습니다(우흥~).', min: 250, max: 500, weight: 5 },
];

function fishReward() {
  const picked = weightedPick(FISHING_TABLE);
  return {
    label: picked.name,
    amount: randomInt(picked.min, picked.max),
  };
}

function begReward() {
  const picked = weightedPick(BEGGING_TABLE);
  return {
    label: picked.text,
    amount: randomInt(picked.min, picked.max),
  };
}

module.exports = {
  begReward,
  findOption,
  fishReward,
  formatCoins,
  formatRemaining,
  nextBetId,
  normalizeKey,
  optionPools,
  parseOptions,
  totalBetPool,
};
