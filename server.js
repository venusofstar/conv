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
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 200, keepAliveMsecs: 30000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 200, keepAliveMsecs: 30000 });

// =========================
// ORIGINS
// =========================
const ORIGINS = [
  "http://136.239.158.10:6610",
  "http://136.239.158.18:6610",
  "http://136.239.158.20:6610",
  "http://136.239.158.30:6610",
  "http://136.239.159.20:6610",
  "http://136.239.173.3:6610",
  "http://136.239.173.10:6610",
  "http://136.158.97.2:6610"
];

// =========================
// PER-CHANNEL SESSION
// =========================
const channelSessions = new Map();

function createSession(channelId) {
  const ztecid = `ch0000009099000000${channelId}`;

  const session = {
    originIndex: Math.floor(Math.random() * ORIGINS.length),
    startNumber: 46489952 + Math.floor(Math.random() * 100000) * 6,
    IAS: "RR" + Date.now() + Math.random().toString(36).slice(2, 10),
    userSession: Math.floor(Math.random() * 1e15).toString(),
    ztecid,
    lastChunk: Date.now(),
    stallTimer: null,
    rotateTimer: null
  };

  // ⏱ Rotate origin every 1000ms
  session.rotateTimer = setInterval(() => {
    session.originIndex = (session.originIndex + 1) % ORIGINS.length;
  }, 1000);

  return session;
}

function clearSession(session) {
  if (!session) return;
  if (session.rotateTimer) {
    clearInterval(session.rotateTimer);
    session.rotateTimer = null;
  }
  if (session.stallTimer) {
    clearInterval(session.stallTimer);
    session.stallTimer = null;
  }
}

function getSession(channelId) {
  if (!channelSessions.has(channelId)) {
    channelSessions.set(channelId, createSession(channelId));
  }
  return channelSessions.get(channelId);
}

function deleteSession(channelId) {
  const session = channelSessions.get(channelId);
  if (session) {
    clearSession(session);
    channelSessions.delete(channelId);
  }
}

// Cleanup all sessions every 10 min
setInterval(() => {
  for (const session of channelSessions.values()) {
    clearSession(session);
  }
  channelSessions.clear();
}, 10 * 60 * 1000);

// =========================
// FETCH WITH STICKY ORIGIN
// =========================
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
      console.error("⚠️ Origin failed:", ORIGINS[session.originIndex], err.message);
      session.originIndex = (session.originIndex + 1) % ORIGINS.length;
      await new Promise(r => setTimeout(r, 200));
    }
  }

  throw new Error("All origins failed");
}

// =========================
// HOME
// =========================
app.get("/", (_, res) => {
  res.send("Enjoy your life");
});

// =========================
// DASH/HLS PROXY
// =========================
app.get("/:channelId/*", async (req, res) => {
  const { channelId } = req.params;
  const path = req.params[0];
  const session = getSession(channelId);

  const authParams =
    `JITPDRMType=Widevine` +
    `&virtualDomain=001.live_hls.zte.com` +
    `&m4s_min=1` +
    `&NeedJITP=1` +
    `&isjitp=0` +
    `&startNumber=${session.startNumber}` +
    `&filedura=6` +
    `&ispcode=55` +
    `&IASHttpSessionId=${session.IAS}` +
    `&usersessionid=${session.userSession}` +
    `&ztecid=${session.ztecid}`; // fixed per channel

  try {
    const upstream = await fetchSticky(origin => {
      const base = `${origin}/001/2/${session.ztecid}/`;
      return path.includes("?")
        ? `${base}${path}&${authParams}`
        : `${base}${path}?${authParams}`;
    }, req, session);

    // =========================
    // MPD
    // =========================
    if (path.endsWith(".mpd")) {
      let mpd = await upstream.text();
      const proxyBase = `${req.protocol}://${req.get("host")}/${channelId}/`;

      mpd = mpd.replace(/<BaseURL>.*?<\/BaseURL>/gs, "");
      mpd = mpd.replace(
        /<MPD([^>]*)>/,
        `<MPD$1><BaseURL>${proxyBase}</BaseURL>`
      );

      res.set({
        "Content-Type": "application/dash+xml",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*"
      });

      return res.send(mpd);
    }

    // =========================
    // SEGMENTS
    // =========================
    res.set({
      "Content-Type": "video/mp4",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Connection": "keep-alive"
    });

    const proxyStream = new PassThrough();
    proxyStream.pipe(res);

    // Stall detection
    session.lastChunk = Date.now();
    const STALL_LIMIT = 3000;

    if (!session.stallTimer) {
      session.stallTimer = setInterval(() => {
        if (Date.now() - session.lastChunk > STALL_LIMIT) {
          console.warn("⚠️ Segment stall detected, rotating origin...");
          session.originIndex = (session.originIndex + 1) % ORIGINS.length;
          upstream.body.destroy();
        }
      }, 500);
    }

    upstream.body.on("data", chunk => {
      session.lastChunk = Date.now();
      proxyStream.write(chunk);
    });

    upstream.body.on("end", () => {
      proxyStream.end();
    });

    upstream.body.on("error", err => {
      console.warn("⚠️ Stream error, rotating origin...", err.message);
      session.originIndex = (session.originIndex + 1) % ORIGINS.length;
      proxyStream.end();
    });

  } catch (err) {
    console.error("❌ Proxy error:", err.message);
    res.status(502).end();
  }
});

// =========================
// START SERVER
// =========================
app.listen(PORT, () => {
  console.log(`✅ DASH/HLS proxy running on port ${PORT}`);
});
