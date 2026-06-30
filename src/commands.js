const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');

function buildCommandData() {
  const commands = [
    new SlashCommandBuilder()
      .setName('업데이트')
      .setDescription('봇 slash command를 Discord에 동기화합니다.')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((option) =>
        option
          .setName('범위')
          .setDescription('현재 서버만 동기화할지 전역으로 동기화할지 선택합니다.')
          .setRequired(false)
          .addChoices(
            { name: '현재 서버', value: 'guild' },
            { name: '전역', value: 'global' },
          ),
      ),

    new SlashCommandBuilder()
      .setName('도움말')
      .setDescription('코인 게임봇 명령어를 확인합니다.'),

    new SlashCommandBuilder()
      .setName('지갑')
      .setDescription('코인 잔액을 확인합니다.')
      .addUserOption((option) =>
        option
          .setName('유저')
          .setDescription('잔액을 확인할 유저입니다.')
          .setRequired(false),
      ),

    new SlashCommandBuilder()
      .setName('파산신청')
      .setDescription('빚을 0으로 정리합니다. 성공 후 30분 쿨타임이 있습니다.'),

    new SlashCommandBuilder()
      .setName('랭킹')
      .setDescription('서버 코인 게임 랭킹을 확인합니다.')
      .addStringOption((option) =>
        option
          .setName('기준')
          .setDescription('랭킹 기준입니다.')
          .setRequired(false)
          .addChoices(
            { name: '잔액', value: 'balance' },
            { name: '전투력', value: 'power' },
            { name: '강화', value: 'enhance' },
            { name: '낚시', value: 'fishing' },
          ),
      ),

    new SlashCommandBuilder()
      .setName('출석')
      .setDescription('하루 한 번 출석 보상을 받습니다.'),

    new SlashCommandBuilder()
      .setName('복권')
      .setDescription('코인을 걸고 복권을 긁습니다.')
      .addIntegerOption((option) =>
        option
          .setName('금액')
          .setDescription('복권 구매 금액입니다.')
          .setRequired(true)
          .setMinValue(100),
      ),

    new SlashCommandBuilder()
      .setName('지급')
      .setDescription('봇 오너가 유저에게 코인을 지급합니다.')
      .addUserOption((option) =>
        option
          .setName('유저')
          .setDescription('코인을 받을 유저입니다.')
          .setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName('금액')
          .setDescription('지급할 코인 금액입니다.')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(1000000000),
      )
      .addStringOption((option) =>
        option
          .setName('사유')
          .setDescription('지급 사유입니다.')
          .setRequired(false)
          .setMaxLength(120),
      ),

    new SlashCommandBuilder()
      .setName('베팅생성')
      .setDescription('새 베팅 주제와 선택지를 만듭니다.')
      .addStringOption((option) =>
        option
          .setName('주제')
          .setDescription('베팅 주제입니다.')
          .setRequired(true)
          .setMaxLength(160),
      )
      .addStringOption((option) =>
        option
          .setName('선택지')
          .setDescription('쉼표로 구분합니다. 예: 빨강, 파랑')
          .setRequired(true)
          .setMaxLength(300),
      ),

    new SlashCommandBuilder()
      .setName('베팅목록')
      .setDescription('진행 중인 베팅 목록을 확인합니다.'),

    new SlashCommandBuilder()
      .setName('베팅정보')
      .setDescription('베팅 상세 정보를 확인합니다.')
      .addStringOption((option) =>
        option
          .setName('베팅id')
          .setDescription('확인할 베팅 ID입니다.')
          .setRequired(true)
          .setMaxLength(20),
      ),

    new SlashCommandBuilder()
      .setName('베팅')
      .setDescription('코인을 걸고 베팅에 참여합니다.')
      .addStringOption((option) =>
        option
          .setName('베팅id')
          .setDescription('참여할 베팅 ID입니다.')
          .setRequired(true)
          .setMaxLength(20),
      )
      .addStringOption((option) =>
        option
          .setName('선택지')
          .setDescription('베팅할 선택지 이름입니다.')
          .setRequired(true)
          .setMaxLength(60),
      )
      .addIntegerOption((option) =>
        option
          .setName('금액')
          .setDescription('베팅할 코인 금액입니다.')
          .setRequired(true)
          .setMinValue(1),
      ),

    new SlashCommandBuilder()
      .setName('베팅종료')
      .setDescription('베팅을 종료하고 정답 선택지에 판돈을 분배합니다.')
      .addStringOption((option) =>
        option
          .setName('베팅id')
          .setDescription('종료할 베팅 ID입니다.')
          .setRequired(true)
          .setMaxLength(20),
      )
      .addStringOption((option) =>
        option
          .setName('정답')
          .setDescription('당첨 선택지 이름입니다.')
          .setRequired(true)
          .setMaxLength(60),
      ),

    new SlashCommandBuilder()
      .setName('낚시')
      .setDescription('낚시를 해서 코인을 얻습니다.'),

    new SlashCommandBuilder()
      .setName('보관함')
      .setDescription('낚시로 얻은 아이템과 강화 수치를 확인합니다.')
      .addUserOption((option) =>
        option
          .setName('유저')
          .setDescription('보관함을 확인할 유저입니다.')
          .setRequired(false),
      ),

    new SlashCommandBuilder()
      .setName('상태')
      .setDescription('유저의 전투 상태, 내구도, 다음 강화 확률을 확인합니다.')
      .addUserOption((option) =>
        option
          .setName('유저')
          .setDescription('상태를 확인할 유저입니다.')
          .setRequired(false),
      ),

    new SlashCommandBuilder()
      .setName('아이템사용')
      .setDescription('보관함 아이템을 사용해서 유저를 강화합니다.')
      .addStringOption((option) =>
        option
          .setName('아이템')
          .setDescription('사용할 아이템 이름입니다. `/보관함`에서 확인할 수 있습니다.')
          .setRequired(true)
          .setAutocomplete(true)
          .setMaxLength(80),
      )
      .addBooleanOption((option) =>
        option
          .setName('전부')
          .setDescription('해당 아이템을 가진 만큼 전부 사용합니다.')
          .setRequired(false),
      ),

    new SlashCommandBuilder()
      .setName('아이템합성')
      .setDescription('등급별 레시피와 코인을 소모해 다음 등급 랜덤 아이템 1개를 얻습니다.')
      .addStringOption((option) =>
        option
          .setName('등급')
          .setDescription('재료로 사용할 아이템 등급입니다.')
          .setRequired(true)
          .addChoices(
            { name: '일반 -> 고급', value: 'common' },
            { name: '고급 -> 희귀', value: 'uncommon' },
            { name: '희귀 -> 영웅', value: 'rare' },
            { name: '영웅 -> 전설', value: 'epic' },
            { name: '전설 -> 신화', value: 'legendary' },
          ),
      ),

    new SlashCommandBuilder()
      .setName('아이템강화')
      .setDescription('코인을 사용해서 해금된 아이템 진화를 확률 강화합니다.')
      .addStringOption((option) =>
        option
          .setName('아이템')
          .setDescription('강화할 아이템 이름입니다. `/보관함`에서 확인할 수 있습니다.')
          .setRequired(true)
          .setAutocomplete(true)
          .setMaxLength(80),
      ),

    new SlashCommandBuilder()
      .setName('아이템확률')
      .setDescription('낚시 확률, 사용 성공률, 아이템 합성 규칙을 확인합니다.'),

    new SlashCommandBuilder()
      .setName('상점')
      .setDescription('코인으로 살 수 있는 아이템 목록을 확인합니다.'),

    new SlashCommandBuilder()
      .setName('방어구')
      .setDescription('보유 방어구와 자동 장착 효과를 확인합니다.'),

    new SlashCommandBuilder()
      .setName('방어구뽑기')
      .setDescription('코인으로 방어구를 뽑습니다.')
      .addIntegerOption((option) =>
        option
          .setName('수량')
          .setDescription('뽑을 수량입니다.')
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(20),
      ),

    new SlashCommandBuilder()
      .setName('방어구합성')
      .setDescription('방어구 조각과 코인을 소모해 상위 등급 방어구를 만듭니다.')
      .addStringOption((option) =>
        option
          .setName('목표등급')
          .setDescription('합성할 목표 방어구 등급입니다.')
          .setRequired(true)
          .addChoices(
            { name: '고급', value: 'uncommon' },
            { name: '희귀', value: 'rare' },
            { name: '영웅', value: 'epic' },
            { name: '전설', value: 'legendary' },
            { name: '신화', value: 'mythic' },
          ),
      ),

    new SlashCommandBuilder()
      .setName('아이템구매')
      .setDescription('상점에서 아이템을 구매합니다.')
      .addStringOption((option) =>
        option
          .setName('아이템')
          .setDescription('구매할 아이템 이름입니다.')
          .setRequired(true)
          .setAutocomplete(true)
          .setMaxLength(80),
      )
      .addIntegerOption((option) =>
        option
          .setName('수량')
          .setDescription('구매할 수량입니다.')
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(100),
      ),

    new SlashCommandBuilder()
      .setName('아이템수리')
      .setDescription('전투로 손상된 진화 아이템 내구도를 수리합니다.')
      .addStringOption((option) =>
        option
          .setName('아이템')
          .setDescription('수리할 진화 아이템 이름입니다.')
          .setRequired(true)
          .setAutocomplete(true)
          .setMaxLength(80),
      ),

    new SlashCommandBuilder()
      .setName('결투')
      .setDescription('상대에게 결투를 신청하고 코인을 걸 수 있습니다.')
      .addUserOption((option) =>
        option
          .setName('상대')
          .setDescription('결투를 신청할 상대입니다.')
          .setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName('금액')
          .setDescription('각자 걸 코인 금액입니다. 생략하면 코인 없이 싸웁니다.')
          .setRequired(false)
          .setMinValue(0),
      ),

    new SlashCommandBuilder()
      .setName('구걸')
      .setDescription('구걸을 해서 코인을 얻습니다.'),

    new SlashCommandBuilder()
      .setName('동전던지기')
      .setDescription('앞면 또는 뒷면에 코인을 겁니다.')
      .addStringOption((option) =>
        option
          .setName('선택')
          .setDescription('예측할 동전 면입니다.')
          .setRequired(true)
          .addChoices(
            { name: '앞면', value: 'heads' },
            { name: '뒷면', value: 'tails' },
          ),
      )
      .addIntegerOption((option) =>
        option
          .setName('금액')
          .setDescription('걸 코인 금액입니다. 맞히면 2배를 돌려받습니다.')
          .setRequired(true)
          .setMinValue(1),
      ),

    new SlashCommandBuilder()
      .setName('주사위')
      .setDescription('1부터 6까지 숫자를 맞히는 도박입니다.')
      .addIntegerOption((option) =>
        option
          .setName('숫자')
          .setDescription('예측할 주사위 숫자입니다.')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(6),
      )
      .addIntegerOption((option) =>
        option
          .setName('금액')
          .setDescription('걸 코인 금액입니다. 맞히면 6배를 돌려받습니다.')
          .setRequired(true)
          .setMinValue(1),
      ),

    new SlashCommandBuilder()
      .setName('배치')
      .setDescription('롤 배치고사 확률표대로 코인을 겁니다. 큰 손실이 날 수 있습니다.')
      .addIntegerOption((option) =>
        option
          .setName('금액')
          .setDescription('베팅 기준 금액입니다. 최대 손실은 베팅액의 5배입니다.')
          .setRequired(true)
          .setMinValue(1),
      ),

    new SlashCommandBuilder()
      .setName('배치확률')
      .setDescription('롤 배치고사 전체 확률표를 PNG 이미지로 확인합니다.'),

    new SlashCommandBuilder()
      .setName('사정')
      .setDescription('초야, 세냥, 남랭 중 누가 가장 멀리 쌀지 베팅합니다.')
      .addStringOption((option) =>
        option
          .setName('선택')
          .setDescription('가장 멀리 쌀 것 같은 사람입니다.')
          .setRequired(true)
          .addChoices(
            { name: '초야', value: 'choya' },
            { name: '세냥', value: 'senyang' },
            { name: '남랭', value: 'namraeng' },
          ),
      )
      .addIntegerOption((option) =>
        option
          .setName('금액')
          .setDescription('걸 코인 금액입니다. 맞히면 3배를 돌려받습니다.')
          .setRequired(true)
          .setMinValue(1),
      ),

    new SlashCommandBuilder()
      .setName('블랙잭')
      .setDescription('딜러와 블랙잭을 합니다.')
      .addIntegerOption((option) =>
        option
          .setName('금액')
          .setDescription('걸 코인 금액입니다.')
          .setRequired(true)
          .setMinValue(1),
      ),

    new SlashCommandBuilder()
      .setName('폴리마켓검색')
      .setDescription('Polymarket 공개 시장을 검색합니다.')
      .addStringOption((option) =>
        option
          .setName('검색어')
          .setDescription('검색할 Polymarket 시장 키워드입니다.')
          .setRequired(true)
          .setMaxLength(100),
      ),

    new SlashCommandBuilder()
      .setName('폴리마켓생성')
      .setDescription('Polymarket 시장 정보로 코인 베팅을 생성합니다.')
      .addStringOption((option) =>
        option
          .setName('시장id')
          .setDescription('Polymarket market ID입니다.')
          .setRequired(true)
          .setMaxLength(80),
      ),
  ];

  return commands.map((command) => command.toJSON());
}

module.exports = {
  buildCommandData,
};
