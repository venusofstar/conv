const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const http = require("http");
const https = require("https");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

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
  "http://136.239.158.18:6610",
  "http://136.239.158.20:6610",
  "http://136.239.158.30:6610",
  "http://136.239.173.3:6610",
  "http://136.158.97.2:6610",
  "http://136.239.173.10:6610",
  "http://136.239.158.10:6610",
  "http://136.239.159.20:6610"
];

// =========================
// AUTHINFO GENERATOR
// =========================
function generateAuthInfo() {
  return encodeURIComponent(
    crypto.randomBytes(64).toString("base64")
  );
}

// =========================
// PER-CHANNEL SESSION
// =========================
const sessions = new Map();

function createSession(channelId) {
  return {
    originIndex: Math.floor(Math.random() * ORIGINS.length),
    startNumber: 46489952 + Math.floor(Math.random() * 100000),
    IAS: "RR" + Date.now() + Math.random().toString(36).slice(2, 10),
    userSession: Math.floor(Math.random() * 1e15).toString(),
    ztecid: `ch0000009099000000${channelId}`,
    authInfo: generateAuthInfo()
  };
}

function getSession(channelId) {
  if (!sessions.has(channelId)) {
    sessions.set(channelId, createSession(channelId));
  }
  return sessions.get(channelId);
}

// =========================
// ROTATION (FAILURE ONLY)
// =========================
function rotateOrigin(session) {
  session.originIndex = (session.originIndex + 1) % ORIGINS.length;
  session.startNumber += 6;          // avoid segment repeat
  session.authInfo = generateAuthInfo(); // rotate AuthInfo
}

// cleanup every 10 minutes
setInterval(() => sessions.clear(), 10 * 60 * 1000);

// =========================
// FETCH WITH FAILOVER
// =========================
async function fetchWithFailover(urlBuilder, req, session) {
  for (let i = 0; i < ORIGINS.length; i++) {
    const origin = ORIGINS[session.originIndex];
    const url = urlBuilder(origin);

    try {
      const res = await fetch(url, {
        agent: url.startsWith("https") ? httpsAgent : httpAgent,
        headers: {
          "User-Agent": req.headers["user-agent"] || "OTT",
          "Accept": "*/*",
          "Connection": "keep-alive"
        },
        timeout: 12000
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;

    } catch (e) {
      console.warn("⚠️ Origin failed:", origin);
      rotateOrigin(session);
    }
  }
  throw new Error("All origins failed");
}

// =========================
// HOME
// =========================
app.get("/", (_, res) => {
  res.send("✅ DASH Proxy – AuthInfo Auto / Stable / No Repeat");
});

// =========================
// DASH PROXY
// =========================
app.get("/:channelId/*", async (req, res) => {
  const { channelId } = req.params;
  const path = req.params[0];
  const session = getSession(channelId);

  const auth =
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
    `&ztecid=${session.ztecid}` +
    `&AuthInfo=${session.authInfo}`;

  try {
    const upstream = await fetchWithFailover(origin => {
      const base = `${origin}/001/2/ch0000009099000000${channelId}/`;
      return path.includes("?")
        ? `${base}${path}&${auth}`
        : `${base}${path}?${auth}`;
    }, req, session);

    // ===== MPD =====
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
        "Cache-Control": "no-store"
      });

      return res.send(mpd);
    }

    // ===== SEGMENTS =====
    res.set({
      "Content-Type": "video/mp4",
      "Cache-Control": "no-store"
    });

    upstream.body.pipe(res);

    upstream.body.on("error", () => {
      rotateOrigin(session);
      res.destroy();
    });

  } catch (e) {
    console.error("❌ Proxy error:", e.message);
    res.status(502).end();
  }
});

// =========================
// START SERVER
// =========================
app.listen(PORT, () => {
  console.log(`✅ DASH proxy running on port ${PORT}`);
});
