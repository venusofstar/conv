"use strict";

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const http = require("http");
const https = require("https");
const { PassThrough, pipeline } = require("stream");
const LRU = require("lru-cache");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.raw({ type: "*/*", limit: "20mb" }));

/* =========================
   KEEP-ALIVE AGENTS
========================= */
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 500 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 500 });

/* =========================
   ORIGINS
========================= */
const ORIGINS = [
  "http://143.44.136.67:6060",
  "http://136.239.158.18:6610"
];

/* =========================
   SESSION STORE
========================= */
const sessions = new Map();

/* =========================
   SEGMENT CACHE (LRU + TTL)
========================= */
const segmentCache = new LRU({
  max: 1000,               // max segments
  ttl: 30 * 1000,          // 30 seconds
  allowStale: false,
  updateAgeOnGet: true
});

/* =========================
   SESSION FACTORY
========================= */
function createSession(channelId) {
  return {
    originIndex: Math.floor(Math.random() * ORIGINS.length),
    startNumber: 46548662,
    IAS: `RR${Date.now()}${Math.random().toString(36).slice(2, 8)}`,
    userSession: Math.floor(Math.random() * 1e15).toString(),
    ztecid: `ch0000009099000000${channelId}${Math.floor(Math.random() * 9000 + 1000)}`,
    started: false,
    lastAccess: Date.now()
  };
}

function getSession(channelId) {
  let s = sessions.get(channelId);
  if (!s) {
    s = createSession(channelId);
    sessions.set(channelId, s);
  }
  s.lastAccess = Date.now();
  return s;
}

/* =========================
   CLEANUP
========================= */
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - v.lastAccess > 10 * 60 * 1000) {
      sessions.delete(k);
    }
  }
}, 5 * 60 * 1000);

/* =========================
   FETCH WITH FAILOVER
========================= */
async function fetchSticky(buildUrl, req, session) {
  let lastErr;

  for (let i = 0; i < ORIGINS.length; i++) {
    const origin = ORIGINS[session.originIndex];
    const url = buildUrl(origin);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);

      const res = await fetch(url, {
        agent: url.startsWith("https") ? httpsAgent : httpAgent,
        headers: {
          "User-Agent": req.headers["user-agent"] || "OTT",
          "Accept": "*/*",
          "Connection": "keep-alive"
        },
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastErr = err;
      session.originIndex = (session.originIndex + 1) % ORIGINS.length;
      await new Promise(r => setTimeout(r, 80));
    }
  }
  throw lastErr;
}

/* =========================
   HOME
========================= */
app.get("/", (_, res) => res.send("Enjoy Your Life"));

/* =========================
   DASH PROXY
========================= */
app.get("/:channelId/*", async (req, res) => {
  const { channelId } = req.params;
  const path = req.params[0];
  const session = getSession(channelId);

  const isMPD = path.endsWith(".mpd");
  const cacheKey = `${channelId}:${path}`;

  if (!isMPD) {
    session.started = true;
    session.startNumber += 6;
  }

  /* ---------- CACHE HIT ---------- */
  if (!isMPD && segmentCache.has(cacheKey)) {
    const cached = segmentCache.get(cacheKey);
    res.set(cached.headers);
    return res.end(cached.body);
  }

  const auth =
    `JITPTrackType=21&JITPDRMType=Widevine&JITPMediaType=DASH` +
    `&virtualDomain=001.live_hls.zte.com&ispcode=55` +
    `&ztecid=${session.ztecid}&m4s_min=1` +
    `&usersessionid=${session.userSession}` +
    `&NeedJITP=1&isjitp=0` +
    `&startNumber=${session.startNumber}` +
    `&filedura=6&IASHttpSessionId=${session.IAS}`;

  try {
    const upstream = await fetchSticky(origin => {
      const base = `${origin}/001/2/ch0000009099000000${channelId}/`;
      return path.includes("?")
        ? `${base}${path}&${auth}`
        : `${base}${path}?${auth}`;
    }, req, session);

    /* ---------- MPD ---------- */
    if (isMPD) {
      let mpd = await upstream.text();
      const proxyBase = `${req.protocol}://${req.get("host")}/${channelId}/`;

      mpd = mpd
        .replace(/<BaseURL>.*?<\/BaseURL>/gs, "")
        .replace(/<MPD([^>]*)>/, `<MPD$1><BaseURL>${proxyBase}</BaseURL>`)
        .replace(/(IASHttpSessionId|usersessionid|ztecid|startNumber|ispcode|virtualDomain)=[^&"]+/g, "$1=[redacted]");

      res.set({
        "Content-Type": "application/dash+xml",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*"
      });
      return res.end(mpd);
    }

    /* ---------- SEGMENT STREAM ---------- */
    const headers = {
      "Content-Type": "video/mp4",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    };
    res.set(headers);

    const buffer = [];
    const tee = new PassThrough();

    upstream.body.on("data", d => buffer.push(d));
    upstream.body.on("end", () => {
      segmentCache.set(cacheKey, {
        headers,
        body: Buffer.concat(buffer)
      });
    });

    pipeline(upstream.body, tee, res, err => {
      if (err) res.destroy();
    });

  } catch (err) {
    console.error("Proxy error:", err.message);
    res.sendStatus(502);
  }
});

/* =========================
   START
========================= */
app.listen(PORT, () =>
  console.log(`✅ Optimized DASH proxy running on ${PORT}`)
);
