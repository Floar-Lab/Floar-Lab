import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";

const KEY = process.env.AT_SERVICE_KEY;
const GKEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite"; // 모델 이름은 AI Studio에서 확인
if (!KEY) { console.error("AT_SERVICE_KEY가 없습니다."); process.exit(1); }

const DAYS = 5;    // 최근 며칠을 볼지
const TOP_N = 30;  // 상위 몇 개를 남길지
const BASE = "https://flower.at.or.kr/api/returnData.api";
const TAGS = ["로맨틱","청순","화려함","차분함","감사","축하","사랑","위로","우아함","밝음"];
const SHELF = ["쉬움","보통","어려움"];

const kst = (d) => new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const readJson = (p) => existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};

function pickRows(j) {
  if (Array.isArray(j)) return j;
  for (const v of Object.values(j || {})) {
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") { const r = pickRows(v); if (r.length) return r; }
  }
  return [];
}

async function fetchDay(date) {
  const url = `${BASE}?kind=f001&serviceKey=${encodeURIComponent(KEY)}&baseDate=${date}&flowerGubn=1&dataType=json&countPerPage=999&currentPage=1`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error("JSON이 아님: " + text.slice(0, 200)); }
  console.log(date, "응답 키:", Object.keys(json), "resultCd:", json.resultCd, json.resultMsg);
  return pickRows(json);
}

/* ---------- 1) aT 거래 품목 수집 ---------- */
const items = {};
let ok = 0, fail = 0;
for (let i = 0; i < DAYS; i++) {
  const date = kst(new Date(Date.now() - i * 86400000));
  try {
    const rows = await fetchDay(date);
    ok++;
    console.log(date, "행 수:", rows.length);
    for (const r of rows) {
      const name = String(r.pumName || "").trim();
      const qty = Number(r.totQty) || 0;
      if (!name || qty <= 0) continue;
      const cur = items[name] || { lastDate: "", qty: 0, avgAmt: null };
      cur.qty += qty;
      if (r.saleDate > cur.lastDate) { cur.lastDate = r.saleDate; cur.avgAmt = Number(r.avgAmt) || null; }
      items[name] = cur;
    }
  } catch (e) { fail++; console.error(date, "실패:", e.message); }
}
if (ok === 0) { console.error("모든 날짜가 실패했습니다. market.json을 바꾸지 않습니다."); process.exit(1); }

const ranked = Object.entries(items).sort((a, b) => b[1].qty - a[1].qty).slice(0, TOP_N);

/* ---------- 2) 태그: 사람이 만든 사전 → AI 저장소 → AI 새로 질문 ---------- */
const dict = readJson("flower-tags.json");   // 사람이 검수한 사전 (최우선)
const cache = readJson("ai-tags.json");      // AI가 만든 결과 저장소

const findManual = (name) => {
  if (dict[name]) return dict[name];
  const k = Object.keys(dict).find(k => name.includes(k) || k.includes(name));
  return k ? dict[k] : null;
};

function clean(o) {
  const tags = Array.isArray(o?.tags) ? o.tags.filter(t => TAGS.includes(t)).slice(0, 4) : [];
  const meaning = typeof o?.meaning === "string" ? o.meaning.slice(0, 20) : "";
  const shelf = SHELF.includes(o?.shelf) ? o.shelf : "보통";
  return { tags, meaning, shelf };
}

async function askAI(names) {
  const prompt = `다음은 한국 화훼 경매에서 거래된 품목 이름입니다. 각 품목에 대해 JSON으로만 답하세요.
형식: {"품목명": {"tags": [...], "meaning": "...", "shelf": "..."}}
- tags: 아래 목록에서만 1~3개 고름: ${TAGS.join(", ")}
- meaning: 대표 꽃말 한 단어나 짧은 구. 확실하지 않으면 빈 문자열
- shelf: 절화 보관·유통 난이도. ${SHELF.join(", ")} 중 하나
품목: ${names.join(", ")}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GKEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
  const text = j.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini 응답이 비어 있음");
  return JSON.parse(text);
}

const need = ranked.map(([n]) => n).filter(n => !findManual(n) && !cache[n]);
if (need.length && GKEY) {
  try {
    const out = await askAI(need);
    for (const n of need) if (out[n]) cache[n] = { ...clean(out[n]), askedAt: new Date().toISOString() };
    console.log("AI 태그 생성:", need.filter(n => cache[n]).length, "/", need.length);
  } catch (e) { console.error("AI 태그 실패(기존 결과는 유지):", e.message); }
} else if (need.length) {
  console.log("GEMINI_API_KEY가 없어 AI 태그를 건너뜁니다:", need);
}
writeFileSync("ai-tags.json", JSON.stringify(cache, null, 2));

/* ---------- 3) 사진: 위키백과 → Pixabay 순서 ---------- */
const PKEY = process.env.PIXABAY_API_KEY;
const photoCache = readJson("photos.json");   // 한 번 찾은 사진은 저장하고 다시 찾지 않음
const UA = { "User-Agent": "flower-shop-mvp/1.0 (student project)", "Api-User-Agent": "flower-shop-mvp/1.0 (student project)" };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
mkdirSync("images", { recursive: true });

async function wikiPhoto(name) {
  for (const title of [name, `${name} (식물)`]) {
    try {
      const res = await fetch(`https://ko.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, { headers: UA });
      if (!res.ok) continue;
      const j = await res.json();
      if (j.type === "disambiguation") continue;
      if (j.thumbnail?.source) {
        return { photo: j.thumbnail.source, photoTitle: j.title, photoPage: j.content_urls?.desktop?.page || "", source: "wikipedia" };
      }
    } catch (e) { /* 다음 후보로 */ }
  }
  return null;
}

async function pixabayPhoto(name, idx) {
  if (!PKEY) return null;
  // 꽃 사진이 나오도록 "꽃"을 붙여 검색, 가로 사진만
  for (const q of [`${name} 꽃`, name]) {
    try {
      const url = `https://pixabay.com/api/?key=${encodeURIComponent(PKEY)}&q=${encodeURIComponent(q)}&lang=ko&image_type=photo&orientation=horizontal&safesearch=true&per_page=5`;
      const res = await fetch(url);
      if (!res.ok) { console.error("Pixabay HTTP", res.status, q); continue; }
      const j = await res.json();
      const hit = (j.hits || [])[0];
      if (!hit) continue;
      // 임시 주소(webformatURL)를 받아 저장소 파일로 저장 (영구 핫링크 금지 조건)
      const img = await fetch(hit.webformatURL);
      if (!img.ok) continue;
      const buf = Buffer.from(await img.arrayBuffer());
      const file = `images/pixabay-${hit.id}.jpg`;
      writeFileSync(file, buf);
      return { photo: file, photoTitle: `Pixabay (${hit.user})`, photoPage: hit.pageURL, source: "pixabay" };
    } catch (e) { console.error("Pixabay 오류:", name, e.message); }
  }
  return null;
}

const photoMissing = [];
let pi = 0;
for (const [name] of ranked) {
  if (photoCache[name]?.photo) continue;
  let p = await wikiPhoto(name);
  if (!p) { p = await pixabayPhoto(name, pi++); await sleep(700); }
  if (p) photoCache[name] = { ...p, foundAt: new Date().toISOString() };
  else photoMissing.push(name);
}
writeFileSync("photos.json", JSON.stringify(photoCache, null, 2));
console.log("사진 못 찾음:", photoMissing.length, photoMissing);


/* ---------- 4) market.json 저장 ---------- */
const top = {};
ranked.forEach(([name, v], i) => {
  const m = findManual(name), a = cache[name];
  const info = m || a || null;
  const ph = photoCache[name] || {};
  top[name] = {
    rank: i + 1, ...v,
    tags: info?.tags || [], meaning: info?.meaning || "", shelf: info?.shelf || "보통",
    tagSource: m ? "manual" : a ? "ai" : "none",
    photo: ph.photo || "", photoTitle: ph.photoTitle || "", photoPage: ph.photoPage || "",
  };
});
writeFileSync("market.json", JSON.stringify({
  updatedAt: new Date().toISOString(), days: DAYS,
  totalItems: Object.keys(items).length, photoMissing, items: top,
}, null, 2));
console.log("저장 완료. 상위:", ranked.length, "성공:", ok, "실패:", fail);
