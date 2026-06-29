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
      .setDescription('노코인 게임봇 명령어를 확인합니다.'),

    new SlashCommandBuilder()
      .setName('지갑')
      .setDescription('노코인 잔액을 확인합니다.')
      .addUserOption((option) =>
        option
          .setName('유저')
          .setDescription('잔액을 확인할 유저입니다.')
          .setRequired(false),
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
      .setDescription('노코인을 걸고 베팅에 참여합니다.')
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
          .setDescription('베팅할 노코인 금액입니다.')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(100000000),
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
      .setDescription('낚시를 해서 노코인을 얻습니다.'),

    new SlashCommandBuilder()
      .setName('구걸')
      .setDescription('구걸을 해서 노코인을 얻습니다.'),
  ];

  return commands.map((command) => command.toJSON());
}

module.exports = {
  buildCommandData,
};
