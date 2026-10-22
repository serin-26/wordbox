# word box 배포 설정 (Cloudflare Pages + GitHub)

저장소 구조는 이렇게 되어야 해요.

```
index.html
schema.sql
functions/api/[[path]].js
```

GitHub에서 `functions/api/[[path]].js` 파일은 **Add file → Create new file**을 누르고 이름 칸에 `functions/api/[[path]].js`를 그대로 입력하면 폴더가 같이 만들어져요. 내용은 받은 파일을 열어 붙여 넣어요.

## 1. Cloudflare Pages 프로젝트 만들기
Workers & Pages → Create → Pages → Connect to Git → `wordbox` 저장소 선택. Framework preset은 None, Build command는 비워 두고, Build output directory는 `/` 로 두고 Save and Deploy.

## 2. 데이터베이스(D1) 만들기
1. 왼쪽 메뉴 Storage & databases → D1 SQL database → Create → 이름 `wordbox`.
2. 만든 DB의 **Console** 탭에 `schema.sql` 내용을 모두 붙여 넣고 실행해요.
3. Pages 프로젝트 → Settings → Bindings → Add → **D1 database** → Variable name은 **`DB`**, Database는 `wordbox`.

## 3. 구글 로그인 키 만들기
1. console.cloud.google.com → 프로젝트 만들기 → APIs & Services → OAuth consent screen: User type은 External, 앱 이름·이메일 입력 후 저장. 그다음 **Publish app(프로덕션으로)** 을 눌러야 친구들도 로그인할 수 있어요. 테스트 상태로 두면 등록한 사용자만 로그인돼요.
2. Credentials → Create credentials → OAuth client ID → Application type **Web application**.
3. **Authorized JavaScript origins**에 배포 주소를 넣어요. 예: `https://wordbox.pages.dev` (Redirect URI는 필요 없어요.)
4. 만들어진 **Client ID**를 복사해요.

## 4. 제미나이 키 만들기
aistudio.google.com/apikey 에서 API 키를 만들어요.

## 5. Cloudflare에 비밀 값 넣기
Pages 프로젝트 → Settings → Variables and secrets → Add

| 이름 | 값 | 종류 |
|---|---|---|
| `GOOGLE_CLIENT_ID` | 3번의 Client ID | Plaintext |
| `SESSION_SECRET` | 아무 긴 임의 문자열 (40자 이상) | Secret |
| `GEMINI_API_KEY` | 4번의 키 | Secret |
| `GEMINI_MODEL` (선택) | 기본값은 `gemini-2.5-flash`. 모델이 바뀌면 여기에 새 이름 | Plaintext |

## 6. 다시 배포
Deployments 탭에서 가장 위 배포의 ⋯ → Retry deployment. (값을 넣기 전에 배포한 것은 새 값을 읽지 못해요.)

## 확인
배포 주소를 열어 **순위 탭**에서 구글 로그인 버튼이 보이면 성공이에요. 로그인이 안 되면 3번의 Authorized JavaScript origins 주소가 접속 주소와 정확히 같은지 확인하세요.

## 저장되는 정보
구글 계정 이름과 프로필 사진 주소, 단어장, 학습 기록, 타자·퀴즈 점수만 저장돼요. 이메일은 저장하지 않아요. 사진 인식은 하루 40번까지로 제한해 두었어요.
