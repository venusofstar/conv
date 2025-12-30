const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const http = require("http");
const https = require("https");
const { PassThrough } = require("stream");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

/* =========================
   KEEP-ALIVE AGENTS
========================= */
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 200,
  keepAliveMsecs: 30000
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 200,
  keepAliveMsecs: 30000
});

/* =========================
   ORIGINS
========================= */
const ORIGINS = [
  "http://136.239.158.18:6610",
  "http://136.239.158.20:6610",
  "http://136.239.158.30:6610",
  "http://136.239.173.3:6610",
  "http://136.158.97.2:6610",
  "http://136.239.173.10:6610",
  "http://136.239.158.10:6610",
  "http://136.239.159.20:6610"
];

/* =========================
   SESSION STATE
========================= */
const channelSessions = new Map();
const segmentCache = new Map();

/* =========================
   SESSION FACTORY
========================= */
function createSession(channelId) {
  return {
    originIndex: Math.floor(Math.random() * ORIGINS.length),
    IAS: "RR" + Date.now() + Math.random().toString(36).slice(2, 10),
    userSession: Math.floor(Math.random() * 1e15).toString(),
    ztecid: `ch0000009099000000${channelId}${Math.floor(
      Math.random() * 9000 + 1000
    )}`,
    lastUsed: Date.now()
  };
}

function getSession(channelId) {
  if (!channelSessions.has(channelId)) {
    channelSessions.set(channelId, createSession(channelId));
  }
  const s = channelSessions.get(channelId);
  s.lastUsed = Date.now();
  return s;
}

function rotateOrigin(session) {
  session.originIndex = (session.originIndex + 1) % ORIGINS.length;
}

/* =========================
   CLEANUP
========================= */
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of channelSessions) {
    if (now - v.lastUsed > 10 * 60 * 1000) {
      channelSessions.delete(k);
    }
  }
  segmentCache.clear();
}, 10 * 60 * 1000);

/* =========================
   FETCH WITH STICKY FAILOVER
========================= */
async function fetchSticky(urlBuilder, req, session) {
  for (let i = 0; i < ORIGINS.length; i++) {
    const origin = ORIGINS[session.originIndex];
    const url = urlBuilder(origin);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    try {
      const res = await fetch(url, {
        agent: url.startsWith("https") ? httpsAgent : httpAgent,
        signal: controller.signal,
        headers: {
          "User-Agent": req.headers["user-agent"] || "OTT",
          "Accept": "*/*",
          "Range": req.headers.range
        }
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;

    } catch (err) {
      rotateOrigin(session);
      await new Promise(r => setTimeout(r, 100));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("All origins failed");
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
  const isInit = path.includes("init");
  const isSegment = !isMPD;

  const authParams =
    `JITPTrackType=21&JITPDRMType=Widevine&JITPMediaType=DASH` +
    `&virtualDomain=001.live_hls.zte.com&ispcode=55` +
    `&ztecid=${session.ztecid}` +
    `&usersessionid=${session.userSession}` +
    `&NeedJITP=1&isjitp=0` +
    `&filedura=6&IASHttpSessionId=${session.IAS}`;

  try {
    const cacheKey = `${channelId}:${path}`;

    if (isSegment && !isInit && segmentCache.has(cacheKey)) {
      const cached = segmentCache.get(cacheKey);
      res.set(cached.headers);
      return res.end(cached.body);
    }

    const upstream = await fetchSticky(origin => {
      const base = `${origin}/001/2/ch0000009099000000${channelId}/`;
      return path.includes("?")
        ? `${base}${path}&${authParams}`
        : `${base}${path}?${authParams}`;
    }, req, session);

    /* ===== MPD ===== */
    if (isMPD) {
      let mpd = await upstream.text();
      const proxyBase = `${req.protocol}://${req.get("host")}/${channelId}/`;

      mpd = mpd.replace(/<BaseURL>.*?<\/BaseURL>/gs, "");
      mpd = mpd.replace(
        /<MPD([^>]*)>/,
        `<MPD$1><BaseURL>${proxyBase}</BaseURL>`
      );

      mpd = mpd.replace(
        /(IASHttpSessionId|usersessionid|ztecid|virtualDomain|ispcode)=[^&"]+/g,
        "$1=[honortvph]"
      );

      res.set({
        "Content-Type": "application/dash+xml",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*"
      });

      return res.send(mpd);
    }

    /* ===== SEGMENT STREAM ===== */
    const headers = {
      "Content-Type": "video/mp4",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    };

    res.status(upstream.status);
    res.set(headers);

    const tee = new PassThrough();
    const chunks = [];

    if (isSegment && !isInit) {
      tee.on("data", c => chunks.push(c));
      tee.on("end", () => {
        segmentCache.set(cacheKey, {
          headers,
          body: Buffer.concat(chunks)
        });
      });
    }

    upstream.body.pipe(tee).pipe(res);

  } catch (err) {
    console.error("❌ Proxy error:", err.message);
    res.status(502).end();
  }
});

/* =========================
   START
========================= */
app.listen(PORT, () => {
  console.log(`✅ DASH proxy running on port ${PORT}`);
});
