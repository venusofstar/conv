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

// =========================
// KEEP-ALIVE AGENTS
// =========================
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

// =========================
// ORIGINS
// =========================
const ORIGINS = [
  "http://143.44.136.67:6060"
];

// =========================
// SESSION & CACHE
// =========================
const channelSessions = new Map();
const segmentCache = new Map();

function createSession(channelId) {
  return {
    originIndex: Math.floor(Math.random() * ORIGINS.length),
    startNumber: 46548662,
    IAS: "RR" + Date.now() + Math.random().toString(36).slice(2),
    userSession: Math.floor(Math.random() * 1e15).toString(),
    ztecid: `ch0000009099000000${channelId}${Math.floor(1000 + Math.random() * 9000)}`,
    started: false
  };
}

function getSession(channelId) {
  if (!channelSessions.has(channelId)) {
    channelSessions.set(channelId, createSession(channelId));
  }
  return channelSessions.get(channelId);
}

function rotateOrigin(session) {
  session.originIndex = (session.originIndex + 1) % ORIGINS.length;
}

// Cleanup every 10 minutes
setInterval(() => {
  channelSessions.clear();
  segmentCache.clear();
}, 10 * 60 * 1000);

// =========================
// FETCH WITH FAILOVER
// =========================
async function fetchSticky(urlBuilder, req, session) {
  for (let i = 0; i < ORIGINS.length; i++) {
    const origin = ORIGINS[session.originIndex];
    const url = urlBuilder(origin);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);

      const res = await fetch(url, {
        agent: url.startsWith("https") ? httpsAgent : httpAgent,
        headers: {
          "User-Agent":
            req.headers["user-agent"] ||
            "Mozilla/5.0 (Linux; Android 10; SmartTV)",
          "Accept": req.headers["accept"] || "*/*",
          "Range": req.headers["range"],
          "Connection": "keep-alive"
        },
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      console.warn("⚠️ Origin failed:", origin, err.message);
      rotateOrigin(session);
      await new Promise(r => setTimeout(r, 150));
    }
  }
  throw new Error("All origins failed");
}

// =========================
// HOME
// =========================
app.get("/", (_, res) => res.send("Enjoy Your Life"));

// =========================
// HEAD SUPPORT (IMPORTANT)
// =========================
app.head("/:channelId/*", async (req, res) => {
  try {
    const session = getSession(req.params.channelId);

    const upstream = await fetchSticky(
      origin => `${origin}${req.originalUrl}`,
      req,
      session
    );

    upstream.headers.forEach((v, k) => res.setHeader(k, v));
    res.status(200).end();
  } catch {
    res.status(502).end();
  }
});

// =========================
// DASH PROXY
// =========================
app.get("/:channelId/*", async (req, res) => {
  const { channelId } = req.params;
  const path = req.params[0];
  const session = getSession(channelId);

  const isMPD = path.endsWith(".mpd");
  const isSegment = !isMPD;

  if (isSegment && !session.started) {
    session.started = true;
    console.log(`▶️ Playback started: ${channelId}`);
  }

  if (isSegment) session.startNumber += 6;

  const authParams =
    `JITPTrackType=21&JITPDRMType=Widevine&JITPMediaType=DASH` +
    `&virtualDomain=001.live_hls.zte.com&ispcode=55` +
    `&ztecid=${session.ztecid}&m4s_min=1` +
    `&usersessionid=${session.userSession}&NeedJITP=1&isjitp=0` +
    `&startNumber=${session.startNumber}&filedura=6` +
    `&IASHttpSessionId=${session.IAS}`;

  try {
    const cacheKey = `${channelId}-${path}-${req.headers.range || ""}`;

    // =========================
    // CACHE HIT
    // =========================
    if (isSegment && segmentCache.has(cacheKey)) {
      const cached = segmentCache.get(cacheKey);
      Object.entries(cached.headers).forEach(([k, v]) => res.setHeader(k, v));
      return res.send(cached.body);
    }

    const upstream = await fetchSticky(origin => {
      const base = `${origin}/001/2/ch0000009099000000${channelId}/`;
      return path.includes("?")
        ? `${base}${path}&${authParams}`
        : `${base}${path}?${authParams}`;
    }, req, session);

    // Forward upstream headers
    upstream.headers.forEach((v, k) => res.setHeader(k, v));

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Length, Content-Range"
    );

    // =========================
    // MPD HANDLING
    // =========================
    if (isMPD) {
      let mpd = await upstream.text();
      const proxyBase = `${req.protocol}://${req.get("host")}/${channelId}/`;

      mpd = mpd.replace(/<BaseURL>.*?<\/BaseURL>/gs, "");
      mpd = mpd.replace(
        /<MPD([^>]*)>/,
        `<MPD$1><BaseURL>${proxyBase}</BaseURL>`
      );

      mpd = mpd.replace(/(IASHttpSessionId|usersessionid|ztecid|startNumber|ispcode|virtualDomain)=[^&"]+/g, "$1=[redacted]");

      res.setHeader("Content-Type", "application/dash+xml");
      res.setHeader("Cache-Control", "no-store");
      return res.send(mpd);
    }

    // =========================
    // SEGMENT STREAM (SAFE)
    // =========================
    const pass = new PassThrough();
    const chunks = [];

    upstream.body.on("data", chunk => {
      chunks.push(chunk);
      pass.write(chunk);
    });

    upstream.body.on("end", () => {
      pass.end();
      segmentCache.set(cacheKey, {
        headers: {
          "Content-Type":
            upstream.headers.get("content-type") ||
            "application/octet-stream",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*"
        },
        body: Buffer.concat(chunks)
      });
    });

    upstream.body.on("error", err => pass.destroy(err));

    pass.pipe(res);

  } catch (err) {
    console.error("❌ Proxy error:", err.message);
    res.status(502).end();
  }
});

// =========================
// START SERVER
// =========================
app.listen(PORT, () =>
  console.log(`✅ Proxy running on port ${PORT}`)
);
