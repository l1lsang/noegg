# 노코인 디스코드 게임봇

노코인으로 베팅하고, 낚시와 구걸로 코인을 얻는 Discord slash command 봇입니다. 데이터는 Firestore에 저장됩니다.

## 기능

- `/베팅생성` 베팅 주제와 선택지를 생성합니다.
- `/베팅` 노코인을 선택지에 베팅합니다.
- `/베팅종료` 정답 선택지를 정하고 당첨자에게 판돈을 분배합니다.
- `/베팅목록`, `/베팅정보` 진행 중인 베팅을 확인합니다.
- `/지갑` 노코인 잔액을 확인합니다.
- `/낚시` 쿨타임 기반으로 노코인을 얻습니다.
- `/구걸` 한국시간 기준 하루 1번 노코인을 얻습니다.
- `/동전던지기`, `/주사위`, `/블랙잭` 노코인 도박 게임을 플레이합니다.
- `/업데이트` 현재 서버 또는 전역 slash command를 동기화합니다.

## 로컬 실행

1. Discord Developer Portal에서 Bot을 만들고 토큰을 발급합니다.
2. Firebase 프로젝트에서 Firestore 데이터베이스를 만들고 서비스 계정 키를 발급합니다.
3. `.env.example`을 참고해 `.env`를 만듭니다.
4. 패키지를 설치하고 명령어를 등록합니다.

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

## Slash command 등록 문제

명령어가 보이지 않으면 먼저 `.env` 파일이 실제로 있는지 확인하세요. `.env.example`은 예시라서 자동으로 읽히지 않습니다.

필수 값:

- `DISCORD_TOKEN`: 봇 토큰
- `DISCORD_CLIENT_ID`: Discord Developer Portal의 Application ID
- `DISCORD_GUILD_ID`: 명령어를 바로 반영할 서버 ID
- `SYNC_SCOPE`: 빠른 테스트는 `guild`

값을 넣은 뒤 아래 명령어로 등록합니다.

```bash
npm.cmd run deploy
```

## Render 배포

이 프로젝트는 `render.yaml`을 포함합니다. Render에서 저장소를 연결한 뒤 환경변수를 설정하세요.

- `DISCORD_TOKEN`: 봇 토큰
- `DISCORD_CLIENT_ID`: Application ID
- `DISCORD_GUILD_ID`: 명령어를 빠르게 동기화할 서버 ID
- `BOT_OWNER_IDS`: `/업데이트` 전역 동기화를 허용할 유저 ID 목록
- `STORAGE_BACKEND`: `firestore`
- `FIRESTORE_PROJECT_ID`: Firebase 프로젝트 ID
- `FIREBASE_SERVICE_ACCOUNT_JSON`: Firebase 서비스 계정 JSON 전체 문자열

Firestore 문서는 기본적으로 `nocoinBot/state`에 저장됩니다. 필요하면 `FIRESTORE_COLLECTION`, `FIRESTORE_DOCUMENT`로 위치를 바꿀 수 있습니다. 로컬 테스트에서만 JSON 파일 저장을 쓰고 싶다면 `STORAGE_BACKEND=json`과 `DATA_FILE=data/db.json`을 설정하세요.

## Discord 권한

봇 초대 URL에는 아래 권한이 필요합니다.

- Scopes: `bot`, `applications.commands`
- Bot permissions: `Send Messages`, `Use Slash Commands`

베팅은 가상 코인 전용입니다. 실제 화폐, 현금화, 상품권 교환 같은 기능은 넣지 않는 것을 권장합니다.
