const queryInput = document.getElementById("queryInput");
const searchBtn = document.getElementById("searchBtn");
const regionFilter = document.getElementById("regionFilter");
const statusArea = document.getElementById("statusArea");
const resultsArea = document.getElementById("resultsArea");

async function runSearch() {
  const query = queryInput.value.trim();
  const region = regionFilter.value;

  if (!query) {
    setStatus("검색어를 입력해주세요 (예: 만원 이하로 점심 뭐 먹지?)", true);
    return;
  }

  searchBtn.disabled = true;
  resultsArea.innerHTML = "";
  setStatus("AI가 부산 착한가격업소를 찾고 있어요...");

  try {
    const res = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, region }),
    });

    if (!res.ok) {
      throw new Error("서버 응답 오류: " + res.status);
    }

    const data = await res.json();
    renderResults(data);
  } catch (err) {
    console.error(err);
    setStatus("데이터를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", true);
    const retryBtn = document.createElement("button");
    retryBtn.textContent = "다시 시도";
    retryBtn.onclick = runSearch;
    statusArea.appendChild(retryBtn);
  } finally {
    searchBtn.disabled = false;
  }
}

function setStatus(message, isError = false) {
  statusArea.textContent = message;
  statusArea.className = "status-area" + (isError ? " error" : "");
}

function renderResults(data) {
  const items = data.recommendations || [];

  if (items.length === 0) {
    setStatus("조건에 맞는 착한가격업소를 찾지 못했어요. 다른 조건으로 검색해보세요.", true);
    return;
  }

  setStatus(
    data.source === "ai"
      ? "AI가 추천한 결과예요"
      : "AI 추천이 일시적으로 어려워 전체 목록을 보여드려요"
  );

  resultsArea.innerHTML = items
    .map(
      (item) => `
    <div class="card">
      <div class="card-top">
        <span class="card-name">${escapeHtml(item.name)}</span>
      </div>
      <div class="card-badges">
        ${escapeHtml(item.category || "")} · ${escapeHtml(item.region || "")}
        ${priceBadge(item)}
      </div>
      ${item.reason ? `<div class="card-reason">💡 ${escapeHtml(item.reason)}</div>` : ""}
      <div class="card-meta">
        📍 ${escapeHtml(item.address || "주소 정보 없음")}<br/>
        📞 ${escapeHtml(item.tel || "전화번호 정보 없음")}<br/>
        🕒 ${escapeHtml(item.hours || "영업시간 정보 없음")}
      </div>
      ${item.intro ? `<div class="card-intro">${escapeHtml(item.intro)}</div>` : ""}
    </div>
  `
    )
    .join("");
}

function priceBadge(item) {
  if (item.priceConfirmed && item.minPrice) {
    return `<span class="badge badge-price-ok">✅ 가격 확인 (최저 ${item.minPrice.toLocaleString()}원)</span>`;
  }
  return `<span class="badge badge-price-unknown">⚠️ 가격 미확인</span>`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

searchBtn.addEventListener("click", runSearch);
queryInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runSearch();
});
