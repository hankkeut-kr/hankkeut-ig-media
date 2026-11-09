// 한끗 노트 인스타 클라우드 게시기 — GitHub Actions 가 15분마다 실행한다(PC 가 꺼져 있어도 됨).
// queue/<id>.json 에 들어 있는 승인된 게시물 중 시각이 된 것을 인스타 공식 API 로 올리고,
// 결과를 results/<id>.json 에 남긴 뒤 사진(queue-media/<id>/)을 지운다.
// 열쇠는 저장소 Settings → Secrets 의 IG_ACCESS_TOKEN (공개 저장소여도 비밀 칸은 남이 못 본다).
import fs from "node:fs";
import path from "node:path";

const TOKEN = (process.env.IG_ACCESS_TOKEN || "").trim();
const REPO = process.env.GITHUB_REPOSITORY;
const G = "https://graph.facebook.com";
const LATE_MS = 12 * 3600_000; // 12시간 넘게 늦으면 올리지 않는다(엉뚱한 때 올라가지 않게)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const raw = (p) => `https://raw.githubusercontent.com/${REPO}/main/${p.split("/").map(encodeURIComponent).join("/")}`;
const kstDay = (t) => new Date(t + 9 * 3600_000).toISOString().slice(0, 10);

async function call(method, endpoint, params = {}) {
  const qs = new URLSearchParams({ ...params, access_token: TOKEN });
  const res = await fetch(method === "GET" ? `${G}/${endpoint}?${qs}` : `${G}/${endpoint}`, {
    method,
    headers: method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : undefined,
    body: method === "POST" ? qs.toString() : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(`IG ${res.status}: ${j.error?.message || "unknown"}`);
  return j;
}

async function waitFinished(id) {
  for (let i = 0; i < 40; i++) {
    const r = await call("GET", id, { fields: "status_code,status" });
    if (r.status_code === "FINISHED") return;
    if (r.status_code === "ERROR" || r.status_code === "EXPIRED") throw new Error(`container ${r.status_code} ${r.status || ""}`);
    await sleep(3000);
  }
  throw new Error("container timeout");
}

async function publish(item) {
  const children = [];
  for (const [i, img] of item.images.entries()) {
    const params = { image_url: raw(img), is_carousel_item: "true" };
    if (i === 0 && item.altText) params.alt_text = item.altText;
    let r;
    try {
      r = await call("POST", `${item.igUserId}/media`, params);
    } catch (e) {
      if (params.alt_text && /alt_text/i.test(e.message)) {
        delete params.alt_text;
        r = await call("POST", `${item.igUserId}/media`, params);
      } else throw e;
    }
    children.push(r.id);
  }
  for (const id of children) await waitFinished(id);
  const parent = await call("POST", `${item.igUserId}/media`, { media_type: "CAROUSEL", children: children.join(","), caption: item.caption });
  await waitFinished(parent.id);
  if (item.practice) return { status: "practice-ok" };
  const pub = await call("POST", `${item.igUserId}/media_publish`, { creation_id: parent.id });
  let permalink;
  try {
    permalink = (await call("GET", pub.id, { fields: "permalink" })).permalink;
  } catch {}
  return { status: "published", mediaId: pub.id, permalink };
}

function friendly(m) {
  if (/expired|session|OAuth|token/i.test(m)) return "인스타 열쇠가 만료됐거나 GitHub 비밀 칸에 없습니다";
  if (/limit|rate|throttl/i.test(m)) return "인스타 게시 한도에 걸렸습니다";
  if (/image|media|aspect|format|container/i.test(m)) return "인스타가 사진을 받지 않았습니다";
  return "올리다가 문제가 생겼습니다";
}

const now = Date.now();
fs.mkdirSync("results", { recursive: true });
const results = fs.readdirSync("results").filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join("results", f), "utf8")));
let postedToday = results.filter((r) => r.status === "published" && kstDay(Date.parse(r.at)) === kstDay(now)).length;
const queue = fs.existsSync("queue")
  ? fs.readdirSync("queue").filter((f) => f.endsWith(".json")).map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join("queue", f), "utf8")) }))
  : [];
queue.sort((a, b) => Date.parse(a.due) - Date.parse(b.due));

if (!TOKEN && queue.some((q) => Date.parse(q.due) <= now)) console.log("IG_ACCESS_TOKEN 비밀 칸이 비어 있습니다");

for (const item of queue) {
  const due = Date.parse(item.due);
  if (due > now) continue;
  let result;
  if (now - due > LATE_MS) result = { status: "missed", error: "정한 시각보다 12시간 넘게 늦어 올리지 않았습니다" };
  else if (!item.practice && postedToday >= (item.dailyMax || 2)) continue; // 오늘 한도 — 다음 날 다시 본다
  else if (!TOKEN) result = { status: "failed", error: "GitHub 비밀 칸(IG_ACCESS_TOKEN)에 인스타 열쇠가 없습니다" };
  else {
    try {
      result = await publish(item);
      if (result.status === "published") postedToday++;
    } catch (e) {
      console.log("실패", item.id, e.message);
      result = { status: "failed", error: friendly(e.message) };
    }
  }
  fs.writeFileSync(path.join("results", `${item.id}.json`), JSON.stringify({ id: item.id, at: new Date().toISOString(), ...result }, null, 2));
  fs.rmSync(path.join("queue", item.file), { force: true });
  fs.rmSync(path.join("queue-media", item.id), { recursive: true, force: true });
  console.log(item.id, result.status, result.permalink || result.error || "");
  break; // 한 번 실행에 하나만(15분 뒤 다음 것)
}
