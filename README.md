# 노코인 디스코드 게임봇

노코인으로 베팅하고, 낚시와 구걸로 코인을 얻는 Discord slash command 봇입니다.

## 기능

- `/베팅생성` 베팅 주제와 선택지를 생성합니다.
- `/베팅` 노코인을 선택지에 베팅합니다.
- `/베팅종료` 정답 선택지를 정하고 당첨자에게 판돈을 분배합니다.
- `/베팅목록`, `/베팅정보` 진행 중인 베팅을 확인합니다.
- `/지갑` 노코인 잔액을 확인합니다.
- `/낚시`, `/구걸` 쿨타임 기반으로 노코인을 얻습니다.
- `/업데이트` 현재 서버 또는 전역 slash command를 동기화합니다.

## 로컬 실행

1. Discord Developer Portal에서 Bot을 만들고 토큰을 발급합니다.
2. `.env.example`을 참고해 `.env`를 만듭니다.
3. 패키지를 설치하고 명령어를 등록합니다.

```bash
npm install
npm run deploy
npm start
```

PowerShell에서 `npm.ps1 cannot be loaded` 오류가 나오면 아래처럼 실행하면 됩니다.

```bash
npm.cmd install
npm.cmd run deploy
npm.cmd start
```

처음에는 `DISCORD_GUILD_ID`를 넣고 서버 명령어로 등록하는 것을 추천합니다. 서버 명령어는 보통 바로 반영되고, 전역 명령어는 반영까지 시간이 걸릴 수 있습니다.

## Render 배포

이 프로젝트는 `render.yaml`을 포함합니다. Render에서 저장소를 연결한 뒤 환경변수를 설정하세요.

- `DISCORD_TOKEN`: 봇 토큰
- `DISCORD_CLIENT_ID`: Application ID
- `DISCORD_GUILD_ID`: 명령어를 빠르게 동기화할 서버 ID
- `BOT_OWNER_IDS`: `/업데이트` 전역 동기화를 허용할 유저 ID 목록

코인 데이터는 `DATA_FILE`에 JSON으로 저장됩니다. Render에서 디스크를 붙이지 않으면 재시작 또는 재배포 때 데이터가 사라질 수 있으니, `render.yaml`의 disk 설정을 유지하는 것을 추천합니다.

## Discord 권한

봇 초대 URL에는 아래 권한이 필요합니다.

- Scopes: `bot`, `applications.commands`
- Bot permissions: `Send Messages`, `Use Slash Commands`

베팅은 가상 코인 전용입니다. 실제 화폐, 현금화, 상품권 교환 같은 기능은 넣지 않는 것을 권장합니다.
