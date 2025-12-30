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
// ORIGINS (REAL)
// =========================
const ORIGINS = [
  "http://143.44.136.67:6060",
  "http://136.239.158.18:6610"
];

// =========================
// PER-CHANNEL SESSION
// =========================
const channelSessions = new Map();

function createSession(channelId) {
  return {
    originIndex: Math.floor(Math.random() * ORIGINS.length),

    // ORIGINAL BEHAVIOR PRESERVED
    startNumber: 46548662,

    IAS: "RR" + Date.now() + Math.random().toString(36).slice(2, 10),
    userSession: Math.floor(Math.random() * 1e15).toString(),

    ztecid: `ch0000009099000000${channelId}${Math.floor(
      Math.random() * 9000 + 1000
    )}`,

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
setInterval(() => channelSessions.clear(), 10 * 60 * 1000);

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
      console.warn("⚠️ Origin failed:", origin, err.message);
      rotateOrigin(session);
      await new Promise(r => setTimeout(r, 200));
    }
  }

  throw new Error("All origins failed");
}

// =========================
// HOME
// =========================
app.get("/", (_, res) => {
  res.send("DASH proxy running");
});

// =========================
// DASH / HLS PROXY
// =========================
app.get("/:channelId/*", async (req, res) => {
  const { channelId } = req.params;
  const path = req.params[0];
  const session = getSession(channelId);

  const isMPD = path.endsWith(".mpd");
  const isSegment = !isMPD;

  // =========================
  // ORIGINAL STARTNUMBER LOGIC
  // =========================
  if (isSegment) {
    if (!session.started) {
      session.started = true;
      console.log(`▶️ Playback started for channel ${channelId}`);
    }

    // ORIGINAL (+6) — NOT CHANGED
    session.startNumber += 6;
  }

  const authParams =
    `JITPTrackType=21` +
    `&JITPDRMType=Widevine` +
    `&JITPMediaType=DASH` +
    `&virtualDomain=001.live_hls.zte.com` +
    `&ispcode=55` +
    `&ztecid=${session.ztecid}` +
    `&m4s_min=1` +
    `&usersessionid=${session.userSession}` +
    `&NeedJITP=1` +
    `&isjitp=0` +
    `&startNumber=${session.startNumber}` +
    `&filedura=6` +
    `&IASHttpSessionId=${session.IAS}`;

  try {
    const upstream = await fetchSticky(origin => {
      const base = `${origin}/001/2/ch0000009099000000${channelId}/`;
      return path.includes("?")
        ? `${base}${path}&${authParams}`
        : `${base}${path}?${authParams}`;
    }, req, session);

    // =========================
    // MPD (PROTECTED OUTPUT)
    // =========================
    if (isMPD) {
      let mpd = await upstream.text();
      const proxyBase = `${req.protocol}://${req.get("host")}/${channelId}/`;

      // Remove original BaseURL
      mpd = mpd.replace(/<BaseURL>.*?<\/BaseURL>/gs, "");

      // Insert proxy BaseURL
      mpd = mpd.replace(
        /<MPD([^>]*)>/,
        `<MPD$1><BaseURL>${proxyBase}</BaseURL>`
      );

      // 🔐 REDACT SENSITIVE QUERY VALUES (DISPLAY ONLY)
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

    // =========================
    // SEGMENTS (UNCHANGED)
    // =========================
    res.set({
      "Content-Type": "video/mp4",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Connection": "keep-alive"
    });

    const proxyStream = new PassThrough();
    proxyStream.pipe(res);

    upstream.body.on("data", chunk => proxyStream.write(chunk));
    upstream.body.on("end", () => proxyStream.end());
    upstream.body.on("error", () => proxyStream.end());

  } catch (err) {
    console.error("❌ Proxy error:", err.message);
    res.status(502).end();
  }
});

// =========================
// START SERVER
// =========================
app.listen(PORT, () => {
  console.log(`✅ Proxy running on port ${PORT}`);
});
