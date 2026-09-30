# 착한한끼 AI

부산광역시 착한가격업소 오픈API + Claude API를 활용한 가성비 식당 추천 웹앱

## 폴더 구조

```
chakan-hanki-ai/
├── index.html        # 메인 화면
├── style.css          # 스타일
├── script.js          # 프론트엔드 로직 (검색 요청, 결과 렌더링)
├── api/
│   └── search.js       # 서버리스 함수 (공공API + Claude API 연동)
├── package.json
└── .env.example        # 환경변수 예시 (실제 키는 .env.local 또는 Vercel 대시보드에 등록)
```

## 로컬에서 테스트하기

1. Node.js 18 이상 설치되어 있는지 확인
2. Vercel CLI 설치: `npm install -g vercel`
3. 이 폴더에서 `.env.example`을 복사해 `.env.local` 파일 생성 후 실제 키 값 입력
4. `vercel dev` 실행 → 안내되는 로컬 주소(보통 http://localhost:3000)로 접속

## Vercel에 배포하기

1. GitHub에 이 폴더를 새 저장소로 push
   ```
   git init
   git add .
   git commit -m "init"
   git branch -M main
   git remote add origin <본인_깃허브_저장소_주소>
   git push -u origin main
   ```
   ⚠️ `.env.local` 파일은 절대 커밋하지 마세요 (.gitignore에 이미 포함됨)

2. https://vercel.com 접속 → GitHub 계정 연동 → 방금 만든 저장소 Import

3. 배포 설정 화면에서 **Environment Variables**에 아래 2개 등록
   - `DATA_GO_KR_KEY` = 공공데이터포털에서 발급받은 인증키
   - `GEMINI_API_KEY` = Gemini API 키 (aistudio.google.com, 무료 발급)

4. Deploy 클릭 → 몇 분 내로 배포 URL 생성됨

## 참고

- 착한가격업소 API는 위경도·구조화된 가격 필드를 제공하지 않아서, 가격 조건은 `intro`(소개글) 텍스트를 Claude가 읽고 판단하는 방식으로 구현했습니다.
- `api/search.js`의 `isFoodCategory` 함수는 업종명에 "음식"이 포함된 것만 필터링하는 단순한 로직입니다. 실제 응답 데이터를 몇 번 확인해보면서 조건을 더 정교하게 다듬어도 좋습니다.
- AI는 Gemini API(`gemini-2.5-flash`, Google AI Studio 무료 티어)를 사용합니다. 카드 등록 없이 바로 키 발급이 가능해서 학생 프로젝트에 부담이 없습니다. 무료 티어는 분당/일일 호출 횟수 제한이 있으니 짧은 시간에 너무 많이 테스트하면 잠깐 막힐 수 있습니다(몇 분 기다리면 풀림).
