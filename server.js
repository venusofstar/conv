const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const http = require("http");
const https = require("https");
const { PassThrough } = require("stream");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.raw({ type: "*/*" }));

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
  "http://143.44.136.67:6060",
  "http://136.239.158.18:6610"
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
    startNumber: 46548662,
    IAS: "RR" + Date.now() + Math.random().toString(36).slice(2, 10),
    userSession: Math.floor(Math.random() * 1e15).toString(),
    ztecid: `ch0000009099000000${channelId}${Math.floor(Math.random() * 9000 + 1000)}`,
    started: false,
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
   CLEANUP (SAFE)
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
   FETCH (UNCHANGED LOGIC)
========================= */
async function fetchSticky(urlBuilder, req, session) {
  for (let attempt = 0; attempt < ORIGINS.length; attempt++) {
    const origin = ORIGINS[session.originIndex];
    const url = urlBuilder(origin);

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
      rotateOrigin(session);
      await new Promise(r => setTimeout(r, 100));
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
  const isSegment = !isMPD;

  if (isSegment && !session.started) {
    session.started = true;
    console.log(`▶️ Playback started for channel ${channelId}`);
  }

  if (isSegment) {
    session.startNumber += 6;
  }

  const authParams =
    `JITPTrackType=21&JITPDRMType=Widevine&JITPMediaType=DASH` +
    `&virtualDomain=001.live_hls.zte.com&ispcode=55` +
    `&ztecid=${session.ztecid}&m4s_min=1` +
    `&usersessionid=${session.userSession}` +
    `&NeedJITP=1&isjitp=0` +
    `&startNumber=${session.startNumber}` +
    `&filedura=6&IASHttpSessionId=${session.IAS}`;

  try {
    /* ===== SEGMENT CACHE ===== */
    const cacheKey = `${channelId}-${path}`;
    if (isSegment && segmentCache.has(cacheKey)) {
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

      mpd = mpd
        .replace(/IASHttpSessionId=[^&"]+/g, "IASHttpSessionId=[honortvph]")
        .replace(/usersessionid=[^&"]+/g, "usersessionid=[honortvph]")
        .replace(/ztecid=[^&"]+/g, "ztecid=[honortvph]")
        .replace(/startNumber=[^&"]+/g, "startNumber=[honortvph]")
        .replace(/virtualDomain=[^&"]+/g, "virtualDomain=[honortvph]")
        .replace(/ispcode=[^&"]+/g, "ispcode=[honortvph]");

      res.set({
        "Content-Type": "application/dash+xml",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*"
      });
      return res.send(mpd);
    }

    /* ===== SEGMENT STREAM (FIXED) ===== */
    const headers = {
      "Content-Type": "video/mp4",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Connection": "keep-alive"
    };

    res.set(headers);

    const stream = new PassThrough();
    upstream.body.pipe(stream).pipe(res);

    if (isSegment) {
      const chunks = [];
      upstream.body.on("data", c => chunks.push(c));
      upstream.body.on("end", () => {
        segmentCache.set(cacheKey, {
          headers,
          body: Buffer.concat(chunks)
        });
      });
    }

  } catch (err) {
    console.error("❌ Proxy error:", err.message);
    res.status(502).end();
  }
});

/* =========================
   START
========================= */
app.listen(PORT, () =>
  console.log(`✅ DASH proxy running (playable) on port ${PORT}`)
);
