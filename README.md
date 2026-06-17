# wpspot — 워드프레스형 블로그스팟 호스팅

워드프레스를 운영할 수 있게 해주는 100% 무료 호스팅 서비스입니다.
사용자가 등록한 GitHub Token / Cloudflare Global API Key를 이용해
- GitHub에 워드프레스 원본 + nginx/PHP-FPM 환경을 자동 구성하고
- Cloudflare에 블로그스팟용 프록시 워커를 배포하고

블로그스팟은 "프론트엔드"로만 동작하며, 실제 백엔드(99.9%)는 워드프레스 원본이 담당합니다.

## 구성 요소

```
wpspot/
├── wrangler.toml              # Cloudflare Worker 설정 (D1 / KV / Assets)
├── schema.sql                 # D1 데이터베이스 스키마
├── src/
│   ├── worker.js              # 메인 API 라우터
│   ├── auth.js                # JWT 발급/검증, 비밀번호 해시 (PBKDF2)
│   ├── crypto.js              # 자격증명 AES-256-GCM 암복호화
│   ├── github.js               # GitHub API 헬퍼
│   ├── blogger.js             # Blogger API 헬퍼
│   └── cf.js                  # Cloudflare Global API 헬퍼 (프록시 워커 배포)
├── public/
│   ├── index.html / login.html / signup.html / account.html / dashboard.html
│   ├── css/tokens.css         # 디자인 토큰
│   ├── css/style.css          # 컴포넌트 스타일
│   ├── js/app.js               # 공통 클라이언트 로직
│   └── _internal/workflows/    # 사용자 레포에 배포되는 GitHub Actions 워크플로우
└── template-repo/             # 새 사이트 레포에 들어가는 기본 파일 (workflows, scripts)
```

## 배포 방법

1. **D1 / KV 생성**
   ```
   wrangler d1 create wpspot-db
   wrangler kv namespace create wpspot-kv
   ```
   생성된 ID를 `wrangler.toml`의 `database_id`, `id` 값에 넣어주세요.

2. **스키마 적용**
   ```
   wrangler d1 execute wpspot-db --file=./schema.sql
   ```

3. **시크릿 등록**
   ```
   wrangler secret put JWT_SECRET        # 임의의 긴 랜덤 문자열
   wrangler secret put CRED_ENC_KEY      # 32바이트(base64) AES-256 키
   ```
   `CRED_ENC_KEY`는 아래처럼 생성할 수 있습니다.
   ```
   openssl rand -base64 32
   ```

4. **배포**
   ```
   wrangler deploy
   ```

## 사용자 입력 정보 (내 계정 페이지)

- **GitHub Token**: `repo`, `workflow` 권한 포함. 사이트별 레포 생성, 워드프레스 원본/Actions 워크플로우 업로드, provision/sync 워크플로우 실행에 사용됩니다.
- **GCP (Blogger API) Token**: `https://www.googleapis.com/auth/blogger` 스코프 포함. 블로그스팟 템플릿을 프록시 워커로 위임하는 데 사용됩니다.
- **Cloudflare Global API Key + 계정 이메일**: 사용자 자신의 Cloudflare 계정에 블로그스팟 프록시 워커를 생성/배포하는 데 사용됩니다. Account ID는 비워두면 자동 조회됩니다.

## 사이트 생성 흐름

1. 대시보드에서 사이트 이름(`siteName`)과 Blogspot Blog ID를 입력해 사이트를 추가합니다.
2. "프로비저닝"을 누르면:
   - GitHub에 `wpspot-<siteName>` 레포가 생성되고 `.github/workflows/provision.yml`, `sync.yml`이 업로드됩니다.
   - `provision.yml`이 실행되어 워드프레스 원본 + SQLite + nginx/PHP-FPM 설정이 구성됩니다.
   - Cloudflare에 `wpspot-<siteName>` 프록시 워커가 배포됩니다.
   - 블로그스팟 템플릿이 해당 워커를 가리키도록 갱신됩니다.
3. "동기화"를 누르면 `sync.yml`이 실행되어 블로그스팟 ↔ 워드프레스 상태를 다시 맞춥니다. (5분 간격 keep-alive 포함)

## 성능/안정성 참고

- 모든 API는 Cloudflare Workers의 표준 Web Crypto / fetch만 사용하여 외부 의존성으로 인한 빌드/런타임 오류를 최소화했습니다.
- 자격증명은 AES-256-GCM으로 암호화되어 D1에 저장됩니다.
- 프록시 워커는 워드프레스 오리진의 HTML/CSS/JS 응답 내 절대경로만 재작성하며, 그 외 리소스는 그대로 스트리밍하여 오버헤드를 최소화합니다.
- GitHub Actions의 5분 간격 `sync.yml` 스케줄은 서버리스 워드프레스 인스턴스를 warm 상태로 유지해 cold-start 지연을 줄입니다.
