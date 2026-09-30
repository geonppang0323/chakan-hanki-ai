// /api/search.js
// Vercel Serverless Function
// 1) 부산광역시_착한가격업소 오픈API 호출
// 2) 외식업(음식점)만 필터링 + 지역 필터 적용
// 3) 후보 목록을 Gemini API(Google AI Studio, 무료 티어)에 넘겨 조건에 맞는 곳을 추천받음
// 4) AI 응답이 JSON이 아니거나 실패하면 원본 후보 목록으로 폴백

import fs from "node:fs";
import path from "node:path";

// 로컬 개발용: vercel dev가 .env.local을 못 읽는 경우를 대비해 직접 읽어서 채워 넣는다.
// (Vercel에 배포했을 때는 대시보드에 등록한 환경변수가 이미 들어 있어서 이 함수는 아무 일도 안 함)
function loadEnvLocal() {
  if (process.env.DATA_GO_KR_KEY && process.env.GEMINI_API_KEY) return;

  const cwd = process.cwd();
  const candidates = [path.join(cwd, ".env.local"), path.join(cwd, "..", ".env.local")];

  for (const file of candidates) {
    try {
      const buf = fs.readFileSync(file);
      // 메모장이 UTF-16으로 저장한 경우까지 대응
      const text =
        buf[0] === 0xff && buf[1] === 0xfe ? buf.toString("utf16le") : buf.toString("utf8");

      for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const idx = line.indexOf("=");
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
        if (key && value && !process.env[key]) process.env[key] = value;
      }
      console.log("[env] .env.local 직접 읽음:", file);
      return;
    } catch (e) {
      // 이 경로에 파일이 없으면 다음 후보로
    }
  }
  console.warn("[env] .env.local을 찾지 못했습니다. 찾아본 경로:", candidates.join(" , "));
}

loadEnvLocal();

const DATA_GO_KR_KEY = process.env.DATA_GO_KR_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
console.log(
  "[env] DATA_GO_KR_KEY:", DATA_GO_KR_KEY ? `있음(길이 ${DATA_GO_KR_KEY.length})` : "없음",
  "/ GEMINI_API_KEY:", GEMINI_API_KEY ? `있음(길이 ${GEMINI_API_KEY.length})` : "없음"
);
// Google이 모델을 자주 교체해서(예: gemini-2.5-flash는 새 프로젝트에 제공 중단),
// 앞에서부터 차례로 시도해서 404가 아닌 첫 번째 모델을 사용한다.
const GEMINI_MODEL_CANDIDATES = [
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
];
let workingModel = null; // 한 번 성공한 모델은 기억해서 다음부터 바로 사용

// 부산 데이터의 업종명이 정확히 통일돼있지 않을 수 있어 "음식"이 포함된 것만 남김.
// 실제 응답 데이터를 보면서 이 조건은 조정이 필요할 수 있음.
function isFoodCategory(cn) {
  if (!cn) return false;
  return cn.includes("음식");
}

function stripHtml(text) {
  if (!text) return "";
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---- 공공API: 전체 페이지를 가져와서 메모리에 캐시 ----
const PAGE_SIZE = 200;
const MAX_PAGES = 10; // 안전장치 (최대 2,000건)
const CACHE_MS = 60 * 60 * 1000; // 1시간
let storeCache = { items: null, fetchedAt: 0 };

async function fetchPage(pageNo) {
  // 인증키는 이미 URL 인코딩된 형태(%2F, %2B, %3D)라서 URLSearchParams를 쓰지 않고 그대로 붙인다.
  const url =
    "https://apis.data.go.kr/6260000/GoodPriceStoreService/getGoodPriceStore" +
    `?serviceKey=${DATA_GO_KR_KEY}&pageNo=${pageNo}&numOfRows=${PAGE_SIZE}&resultType=json`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("공공API 응답 본문:", body.slice(0, 500));
    throw new Error("공공API 호출 실패: " + res.status);
  }

  const data = await res.json();
  const body = data?.response?.body;
  const raw = body?.items?.item;
  // 결과가 1건이면 배열이 아니라 객체로 올 수 있어 배열로 통일
  const items = !raw ? [] : Array.isArray(raw) ? raw : [raw];
  return { items, totalCount: Number(body?.totalCount) || items.length };
}

async function fetchGoodPriceStores() {
  if (!DATA_GO_KR_KEY) {
    throw new Error("DATA_GO_KR_KEY 환경변수가 비어 있습니다 (.env.local 확인)");
  }

  if (storeCache.items && Date.now() - storeCache.fetchedAt < CACHE_MS) {
    return storeCache.items;
  }

  const first = await fetchPage(1);
  const totalPages = Math.min(Math.ceil(first.totalCount / PAGE_SIZE), MAX_PAGES);

  const restPages = [];
  for (let n = 2; n <= totalPages; n++) restPages.push(fetchPage(n));
  const settled = await Promise.allSettled(restPages);

  let all = first.items;
  for (const r of settled) {
    if (r.status === "fulfilled") all = all.concat(r.value.items);
    else console.error("일부 페이지 로드 실패:", r.reason.message);
  }

  console.log(`[data] 착한가격업소 ${all.length}건 로드 (전체 ${first.totalCount}건)`);
  storeCache = { items: all, fetchedAt: Date.now() };
  return all;
}

// ---- 지역: "해운대" -> "해운대구". 주소를 띄어쓰기로 나눠 정확히 일치하는 구/군만 인정
// (그냥 includes("서구")를 쓰면 "강서구"도 걸리기 때문)
function normalizeRegion(region) {
  if (!region) return "";
  const r = region.trim();
  if (/[구군]$/.test(r)) return r;
  return r === "기장" ? "기장군" : r + "구";
}

function matchesRegion(address, gu) {
  return (address || "").split(/\s+/).some((token) => token === gu);
}

// ---- 예산 파싱: "만원 이하", "8천원", "8000원", "1만5천원" -> 숫자(원)
function parseBudget(query) {
  const q = query.replace(/,/g, "");
  let m;
  if ((m = q.match(/(\d+)\s*만\s*(\d+)\s*천/))) return Number(m[1]) * 10000 + Number(m[2]) * 1000;
  if ((m = q.match(/(\d+(?:\.\d+)?)\s*만\s*원?/))) return Math.round(Number(m[1]) * 10000);
  if ((m = q.match(/(\d+)\s*천\s*원?/))) return Number(m[1]) * 1000;
  if ((m = q.match(/(\d{3,6})\s*원/))) return Number(m[1]);
  if (/(^|[^\d가-힣])만\s*원/.test(q) || /^만\s*원/.test(q)) return 10000;
  return null;
}

// ---- 소개글에서 "6,000원" 같은 가격 숫자 추출
function extractPrices(text) {
  const prices = [];
  const re = /(\d{1,3}(?:,\d{3})+|\d{3,6})\s*원/g;
  let m;
  while ((m = re.exec(text || "")) !== null) {
    const n = Number(m[1].replace(/,/g, ""));
    if (n >= 500) prices.push(n);
  }
  return prices;
}

const SKIP_WORD_PARTS = ["추천", "해줘", "알려", "이하", "이내", "미만", "점심", "저녁", "아침", "음식", "먹", "뭐", "어디", "맛집", "근처"];

// AI에 넘기기 전에 후보를 점수로 추린다 (예산 이하 가격이 보이면 가산점, 검색어가 이름/소개에 있으면 가산점)
function rankCandidates(query, candidates, limit = 40) {
  const budget = parseBudget(query);
  const cleaned = query
    .replace(/\d+\s*만\s*\d*\s*천?\s*원?/g, " ")
    .replace(/\d+\s*천\s*원?/g, " ")
    .replace(/\d+\s*원/g, " ")
    .replace(/만\s*원/g, " ");
  const tokens = (cleaned.match(/[가-힣A-Za-z]{2,}/g) || []).filter(
    (t) => !SKIP_WORD_PARTS.some((w) => t.includes(w))
  );

  const scored = candidates.map((c, i) => {
    const prices = extractPrices(c.intro);
    const minPrice = prices.length ? Math.min(...prices) : null;
    let score = 0;
    if (budget && minPrice !== null) score += minPrice <= budget ? 3 : -3;
    const haystack = `${c.name} ${c.category} ${c.intro}`;
    for (const t of tokens) if (haystack.includes(t)) score += 2;
    return {
      ...c,
      priceHints: prices.slice(0, 4),
      priceConfirmed: prices.length > 0, // 소개글에서 실제 가격 숫자를 찾았는지 여부
      minPrice,
      _score: score,
      _i: i,
    };
  });

  scored.sort((a, b) => b._score - a._score || a._i - b._i);
  return scored.slice(0, limit).map(({ _score, _i, ...rest }) => rest);
}

async function getAiRecommendations(query, candidates) {
  const compactCandidates = candidates.slice(0, 40).map((c) => ({
    name: c.name,
    region: c.region,
    priceHints: c.priceHints, // 소개글에서 자동 추출한 가격(원). 참고용
    intro: c.intro.slice(0, 200), // 토큰 절약을 위해 소개글 길이 제한
  }));

  const systemPrompt =
    "당신은 부산 착한가격업소 추천 도우미입니다. 아래 후보 목록 중 사용자 조건(예산, 메뉴, 지역 등)에 가장 잘 맞는 곳을 최대 4개 골라주세요. " +
    "가격 정보는 intro 텍스트 안에 자연어로 섞여 있으니 이를 해석해서 조건에 맞는지 판단하세요. priceHints는 소개글에서 자동 추출한 가격 숫자이니 참고만 하세요. " +
    "소개글에 가격이 없으면 가격이 확인되지 않았다고 이유에 솔직히 적으세요. " +
    "추천 이유에는 소개글에 실제로 적힌 메뉴와 가격만 인용하고, 소개글에 없는 가격을 추측해서 쓰지 마세요. " +
    "반드시 아래 JSON 배열 형식으로만 답하세요. 다른 설명은 절대 포함하지 마세요.\n" +
    '형식: [{"name": "업소명", "reason": "한 문장 추천 이유"}]';

  const userPrompt =
    `사용자 요청: ${query}\n\n후보 목록:\n` + JSON.stringify(compactCandidates);

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: {
      responseMimeType: "application/json", // Gemini가 JSON 형식으로만 답하도록 강제
    },
  });

  const modelsToTry = workingModel ? [workingModel] : GEMINI_MODEL_CANDIDATES;
  let res = null;
  let lastStatus = 0;

  for (const model of modelsToTry) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const attempt = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body,
    });

    if (attempt.ok) {
      res = attempt;
      workingModel = model;
      console.log("[gemini] 사용 모델:", model);
      break;
    }

    lastStatus = attempt.status;
    const errText = await attempt.text();
    console.error(`[gemini] ${model} 실패 (${attempt.status}):`, errText.slice(0, 200));
    // 404(모델 없음)일 때만 다음 후보로 넘어감. 그 외(키 오류, 한도 초과 등)는 바로 중단.
    if (attempt.status !== 404) break;
  }

  if (!res) {
    workingModel = null;
    throw new Error("Gemini API 호출 실패: " + lastStatus);
  }

  const data = await res.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const cleaned = rawText.replace(/```json|```/g, "").trim();

  const parsed = JSON.parse(cleaned); // 실패하면 상위 catch에서 폴백 처리
  if (!Array.isArray(parsed)) throw new Error("AI 응답이 배열 형식이 아님");
  return parsed;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST 요청만 지원합니다." });
  }

  const { query, region } = req.body || {};

  if (!query || typeof query !== "string") {
    return res.status(400).json({ error: "query 값이 필요합니다." });
  }

  try {
    const rawItems = await fetchGoodPriceStores();

    let candidates = rawItems
      .filter((item) => isFoodCategory(item.cn))
      .map((item) => ({
        name: item.sj,
        category: item.cn,
        region: item.locale,
        address: item.adres,
        tel: item.tel,
        hours: item.bsnTime,
        intro: stripHtml(item.intrcn),
      }));

    if (region) {
      const gu = normalizeRegion(region);
      candidates = candidates.filter((c) => matchesRegion(c.address, gu));
    }

    if (candidates.length === 0) {
      return res.status(200).json({ recommendations: [], source: "empty" });
    }

    // AI에 넘기기 전에 예산/키워드로 후보를 먼저 추린다
    const ranked = rankCandidates(query, candidates);

    try {
      const aiPicks = await getAiRecommendations(query, ranked);

      // AI가 고른 name과 원본 후보 데이터를 매칭해서 상세정보(주소/전화 등)를 합침 (띄어쓰기 차이는 무시)
      const norm = (t) => (t || "").replace(/\s+/g, "");
      const merged = aiPicks
        .map((pick) => {
          const match = ranked.find((c) => norm(c.name) === norm(pick.name));
          if (!match) return null;
          return { ...match, reason: pick.reason };
        })
        .filter(Boolean);

      if (merged.length === 0) throw new Error("AI 추천 결과와 매칭되는 후보 없음");

      return res.status(200).json({ recommendations: merged, source: "ai" });
    } catch (aiError) {
      console.error("AI 추천 실패, 폴백으로 전환:", aiError.message);
      // 폴백: AI 없이 후보 목록 상위 4개를 그대로 보여줌
      return res.status(200).json({
        recommendations: ranked.slice(0, 4),
        source: "fallback",
      });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "데이터를 불러오지 못했습니다." });
  }
}
