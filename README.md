# Hashguard

Hashguard는 [Bitcoin](https://bitcoin.org/) [채굴 아이디어](https://bitcoin.org/bitcoin.pdf)(해시 기반 작업증명)를 응용해 자동화된 봇 요청을 완화하는 범용 PoW CAPTCHA REST API입니다.

- 서버: NestJS (TypeScript)
- 저장소: Redis (challenge TTL, replay 방지, rate window)
- 해시 알고리즘: SHA-256
- 정책: 요청 빈도/실패율 기반 난이도 동적 조정

## 핵심 개념

1. 클라이언트가 챌린지를 발급받습니다.
2. `SHA-256(challengeId:seed:nonce) <= target`을 만족하는 nonce를 찾습니다.
3. 서버에 nonce를 제출해 검증을 통과하면 짧은 TTL의 `proofToken`을 받습니다.
4. 보호 리소스 서버는 `proofToken`을 introspect(검증/소모)해 요청을 허용합니다.

기본 정책은 `1회 solve = 1회 보호 요청`(single-use)입니다.

## 아키텍처 요약

- `POST /v1/pow/challenges`: 챌린지 발급
- `POST /v1/pow/verifications`: nonce 검증 + proof token 발급
- `POST /v1/pow/assertions/introspect`: proof token 검증(기본 consume=true)
- `GET /v1/metrics/pow`: 운영 메트릭 스냅샷
- `GET /v1/health`, `GET /v1/health/liveness`: 헬스체크

### 난이도 계산

- 입력 신호: IP별 분당 챌린지 요청량(RPM), 분당 실패량
- 기본 난이도: `POW_BASE_DIFFICULTY_BITS`
- 상한 난이도: `POW_MAX_DIFFICULTY_BITS`
- 요청량/실패량이 높을수록 추가 비트를 부여해 난이도를 높입니다.

## 빠른 시작

### 1) 의존성 설치

```bash
npm install
```

### 2) 환경 변수 준비

```bash
cp .env.example .env
```

### 3) Redis 실행

```bash
docker compose up -d redis
```

로컬 Redis가 이미 있다면 해당 정보를 `.env`에 맞춰주세요.

### 앱 + Redis를 도커로 함께 실행

```bash
docker compose up --build -d
```

- API Base URL: `http://localhost:3000/v1`
- Swagger: `http://localhost:3000/docs`

중지:

```bash
docker compose down
```

### 4) 개발 서버 실행

```bash
npm run start:dev
```

- API Base URL: `http://localhost:3000/v1`
- Swagger: `http://localhost:3000/docs`

## API 사용 예시

### 1) 챌린지 발급

```bash
curl -s -X POST http://localhost:3000/v1/pow/challenges \
	-H 'content-type: application/json' \
	-d '{"context":"login"}'
```

응답 예시:

```json
{
  "challengeId": "f2d8a3b5-...",
  "algorithm": "sha256",
  "seed": "9c0f...",
  "difficultyBits": 20,
  "target": "00000fffff...",
  "issuedAt": "2026-03-16T13:00:00.000Z",
  "expiresAt": "2026-03-16T13:10:00.000Z"
}
```

### 2) nonce 계산

클라이언트는 아래 조건을 만족하는 nonce를 brute-force로 찾습니다.

```text
sha256(challengeId:seed:nonce) <= target
```

### 3) 검증 요청

```bash
curl -s -X POST http://localhost:3000/v1/pow/verifications \
	-H 'content-type: application/json' \
	-d '{
		"challengeId":"f2d8a3b5-...",
		"nonce":"4829371",
		"clientMetrics":{"solveTimeMs":850}
	}'
```

성공 시 `proofToken`이 반환됩니다.

### 4) proof token introspection

```bash
curl -s -X POST http://localhost:3000/v1/pow/assertions/introspect \
	-H 'content-type: application/json' \
	-d '{"proofToken":"<TOKEN>","consume":true}'
```

- `consume=true`(기본): 검증 성공 시 토큰 소모
- `consume=false`: 읽기 전용 검증

## 환경 변수

주요 설정은 `.env.example`에 정리되어 있습니다.

- `PORT`: 서버 포트
- `TRUSTED_PROXY`: `cloudflare | x-forwarded-for | none`
- `CORS_ORIGINS`: 허용 Origin (`*` 또는 comma-separated)
- `REDIS_*`: Redis 연결 정보
- `POW_CHALLENGE_TTL_SECONDS`: 챌린지 유효시간
- `POW_PROOF_TOKEN_TTL_SECONDS`: proof token 유효시간
- `POW_TOKEN_SECRET`: proof token 서명 키
- `POW_BASE_DIFFICULTY_BITS`: 기본 난이도
- `POW_MAX_DIFFICULTY_BITS`: 최대 난이도
- `POW_MIN_SOLVE_TIME_MS`: 비정상적으로 빠른 solve 차단 기준
- `POW_MAX_FAILURES_PER_CHALLENGE`: 챌린지별 실패 허용 횟수

### 안전한 HMAC 서명키 생성

운영 환경에서는 `POW_TOKEN_SECRET`에 사람이 읽기 쉬운 문자열 대신 충분히 긴 랜덤 바이트 기반 키를 사용하는 것이 좋습니다.

OpenSSL 기준 예시:

```bash
openssl rand -base64 32
```

더 긴 키가 필요하면 48바이트 또는 64바이트로 생성할 수 있습니다.

```bash
openssl rand -base64 48
openssl rand -base64 64
```

생성한 값을 `.env`에 그대로 넣으면 됩니다.

```env
POW_TOKEN_SECRET=GENERATED_RANDOM_STRING
```

권장 사항:

- 최소 32바이트 이상의 랜덤 값을 사용하세요.
- 개발/스테이징/운영 환경에서 서로 다른 키를 사용하세요.
- 키를 Git에 커밋하지 마세요.
- 키를 교체하면 기존 proof token은 더 이상 유효하지 않으므로 배포 시점을 고려하세요.

## 테스트

### 단위 테스트

```bash
npm test
```

### E2E 테스트

Redis가 실행 중이어야 합니다.

```bash
npm run test:e2e -- --runInBand
```

## 보안/운영 주의사항

- 운영 환경에서는 반드시 `POW_TOKEN_SECRET`를 강한 랜덤 값으로 교체하세요.
- 기본 정책은 single-use 토큰이므로 보호 서버에서 재사용을 허용하지 않도록 유지하세요.
- Cloudflare 환경이라면 `CF-Connecting-IP` 헤더 신뢰 체인을 정확히 구성하세요.
- 난이도 값(`BASE/MAX`)은 사용자 기기 성능을 고려해 트래픽 패턴에 맞게 튜닝하세요.

## 현재 범위와 향후 확장

현재 범위:

- 독립형 NestJS PoW API 서버
- Redis 기반 challenge/replay/rate 관리
- OpenAPI(Swagger), health, metrics

향후 확장 아이디어:

- 브라우저/모바일 SDK
- 보호 서비스용 공식 middleware/guard 패키지
- 서명 공개키 기반 offline token verification
