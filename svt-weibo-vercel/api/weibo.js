const DEFAULT_UID = "6409560260";
const ALLOWED_UIDS = new Set([DEFAULT_UID]);
const RSS_BASES = [
  "https://rsshub.gneko.io",
  "https://rsshub.moonagic.com",
];

const memoryCache = new Map();

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function send(res, status, data, cacheSeconds = 0) {
  cors(res);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", cacheSeconds ? `s-maxage=${cacheSeconds}, stale-while-revalidate=300` : "no-store");
  res.status(status).json(data);
}

function asInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function cacheGet(key) {
  const hit = memoryCache.get(key);
  if (!hit || hit.expires < Date.now()) {
    memoryCache.delete(key);
    return null;
  }
  return hit.data;
}

function cacheSet(key, data, seconds) {
  memoryCache.set(key, { data, expires: Date.now() + seconds * 1000 });
}

async function fetchText(url, init = {}, ms = 14000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(timer);
  }
}

function decodeXml(text) {
  return String(text || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tagValue(block, tag) {
  const match = String(block || "").match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeXml(match[1].trim()) : "";
}

function rssToWeiboJson(xml, uid) {
  const cards = [...String(xml || "").matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((match) => {
    const item = match[1];
    const link = tagValue(item, "link") || tagValue(item, "guid");
    const id = (link.match(/\/([^/]+)$/) || [])[1] || link;
    const text = tagValue(item, "description") || tagValue(item, "title");
    return {
      card_type: 9,
      mblog: {
        id,
        mid: id,
        text,
        created_at: tagValue(item, "pubDate"),
      },
    };
  }).filter((card) => card.mblog.text);

  return {
    ok: cards.length ? 1 : 0,
    data: {
      cardlistInfo: {
        containerid: `107603${uid}`,
        total: cards.length,
      },
      cards,
    },
  };
}

async function readRss(uid) {
  let last = null;
  for (const base of RSS_BASES) {
    try {
      const { res, text } = await fetchText(`${base}/weibo/user/${uid}`, {}, 12000);
      const data = rssToWeiboJson(text, uid);
      if (data.ok) return data;
      last = { ok: 0, error: "RSS_PARSE_FAILED", source: base, status: res.status, preview: text.slice(0, 180) };
    } catch (error) {
      last = { ok: 0, error: "RSS_FETCH_FAILED", source: base, message: error?.message || String(error) };
    }
  }
  return last || { ok: 0, error: "RSS_FAILED" };
}

async function readDirect(uid, page) {
  const target = new URL("https://m.weibo.cn/api/container/getIndex");
  target.searchParams.set("containerid", `107603${uid}`);
  target.searchParams.set("page", String(page));
  const { text } = await fetchText(target.toString(), {
    headers: {
      Accept: "application/json, text/plain, */*",
      Referer: `https://m.weibo.cn/u/${uid}`,
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    },
  }, 10000);
  const data = JSON.parse(text);
  if (!data || !data.ok) throw new Error("DIRECT_NOT_OK");
  return data;
}

async function readJina(uid, page) {
  const target = new URL("http://m.weibo.cn/api/container/getIndex");
  target.searchParams.set("containerid", `107603${uid}`);
  target.searchParams.set("page", String(page));
  const { text } = await fetchText(`https://r.jina.ai/${target.toString()}`, {}, 15000);
  const raw = text.split("Markdown Content:").pop().trim();
  const data = JSON.parse(raw);
  if (!data || !data.ok) throw new Error(data?.message || data?.readableMessage || "JINA_NOT_OK");
  return data;
}

async function readPage(uid, page) {
  const key = `page:${uid}:${page}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  let data;
  if (page === 1) {
    data = await readRss(uid);
    if (!data.ok) {
      try { data = await readDirect(uid, page); }
      catch (_) { data = await readJina(uid, page); }
    }
  } else {
    try { data = await readDirect(uid, page); }
    catch (_) { data = await readJina(uid, page); }
  }

  if (data?.ok) cacheSet(key, data, page === 1 ? 180 : 90);
  return data;
}

function shanghaiKey(dateText) {
  const date = new Date(dateText);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function cardKey(card) {
  const m = card?.mblog || {};
  return m.id || m.mid || String(m.text || "").slice(0, 160);
}

async function readMany({ uid, count, date, maxPages }) {
  const cards = [];
  const seen = new Set();
  let lastError = null;
  let sawDate = false;
  let sawOlder = false;

  for (let page = 1; page <= maxPages; page += 1) {
    let data;
    try {
      data = await readPage(uid, page);
    } catch (error) {
      lastError = error?.message || String(error);
      break;
    }
    const pageCards = data?.data?.cards || [];
    for (const card of pageCards) {
      if (card?.card_type !== 9 || !card.mblog) continue;
      const key = cardKey(card);
      if (seen.has(key)) continue;
      seen.add(key);
      const publishedKey = shanghaiKey(card.mblog.created_at);
      card.mblog.publishedKey = publishedKey;
      if (!date || publishedKey === date) cards.push(card);
      if (date && publishedKey === date) sawDate = true;
      if (date && publishedKey && publishedKey < date) sawOlder = true;
    }
    if (date) {
      if ((sawDate && sawOlder) || (!sawDate && pageCards.some((card) => shanghaiKey(card?.mblog?.created_at) < date))) break;
    } else if (cards.length >= count) {
      break;
    }
  }

  return {
    ok: cards.length ? 1 : 0,
    error: cards.length ? undefined : lastError || "NO_POSTS",
    data: {
      cardlistInfo: { containerid: `107603${uid}`, total: cards.length },
      cards: cards.slice(0, count),
    },
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return send(res, 405, { ok: 0, error: "METHOD_NOT_ALLOWED" });

  const uid = req.query.uid || DEFAULT_UID;
  if (!ALLOWED_UIDS.has(uid)) return send(res, 403, { ok: 0, error: "UID_NOT_ALLOWED" });

  const count = asInt(req.query.count, 10, 1, 120);
  const page = asInt(req.query.page, 1, 1, 30);
  const maxPages = asInt(req.query.maxPages, Math.ceil(count / 10) + 3, 1, 30);
  const date = String(req.query.date || "").trim();

  try {
    const data = (req.query.count || date)
      ? await readMany({ uid, count, date, maxPages })
      : await readPage(uid, page);
    return send(res, 200, data, data?.ok ? 60 : 0);
  } catch (error) {
    return send(res, 200, { ok: 0, error: "FETCH_FAILED", message: error?.message || String(error) });
  }
};
