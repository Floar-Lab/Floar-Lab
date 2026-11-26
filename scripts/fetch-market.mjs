import { writeFileSync } from "node:fs";

const KEY = process.env.AT_SERVICE_KEY;
if (!KEY) { console.error("AT_SERVICE_KEY가 없습니다."); process.exit(1); }

const DAYS = 5; // 최근 며칠을 볼지
const BASE = "https://flower.at.or.kr/api/returnData.api";
const kst = (d) => new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);

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
  } catch (e) {
    fail++;
    console.error(date, "실패:", e.message);
  }
}

if (ok === 0) { console.error("모든 날짜가 실패했습니다. market.json을 바꾸지 않습니다."); process.exit(1); }

writeFileSync("market.json", JSON.stringify({
  updatedAt: new Date().toISOString(),
  days: DAYS,
  items,
}, null, 2));
console.log("저장 완료. 품목 수:", Object.keys(items).length, "성공:", ok, "실패:", fail);
