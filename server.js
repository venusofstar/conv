const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const http = require("http");
const https = require("https");

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
    startNumber: 46489952 + Math.floor(Math.random() * 100000) * 6,
    IAS: "RR" + Date.now() + Math.random().toString(36).slice(2, 10),
    userSession: Math.floor(Math.random() * 1e15).toString(),
    // ✅ ztecid SAME AS channel path id
    ztecid: `ch0000009099000000${channelId}`,
    authInfo: null,
    authInfoTime: 0
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

// cleanup every 10 minutes
setInterval(() => channelSessions.clear(), 10 * 60 * 1000);

// =========================
// AUTHINFO ROTATION
// =========================
const AUTHINFO_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchNewAuthInfo(channelId) {
  // 🔴 replace with real auth source
  return "rSpjhsi8YPKuwtVD96LPO9APsXSpK2mq6dZZRgF8v7xYxw0MdBePEXRMFugy%2F7SuAXlR2%2FEFrpiArV%2FBblLcXA%3D%3D";
}

async function getAuthInfo(session, channelId) {
  if (!session.authInfo || Date.now() - session.authInfoTime > AUTHINFO_TTL) {
    session.authInfo = await fetchNewAuthInfo(channelId);
    session.authInfoTime = Date.now();
  }
  return session.authInfo;
}

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

      if (res.status === 401 || res.status === 403) {
        session.authInfo = null;
        throw new Error("AuthInfo expired");
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      return res;
    } catch (err) {
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
  res.send("Enjoy your life");
});

// =========================
// DASH / HLS PROXY
// =========================
app.get("/:channelId/*", async (req, res) => {
  const { channelId } = req.params;
  const path = req.params[0];
  const session = getSession(channelId);

  try {
    const authInfo = await getAuthInfo(session, channelId);

    const authParams =
      `AuthInfo=${authInfo}` +
      `&JITPDRMType=Widevine` +
      `&virtualDomain=001.live_hls.zte.com` +
      `&m4s_min=1` +
      `&NeedJITP=1` +
      `&isjitp=0` +
      `&startNumber=${session.startNumber}` +
      `&filedura=6` +
      `&ispcode=55` +
      `&IASHttpSessionId=${session.IAS}` +
      `&usersessionid=${session.userSession}` +
      `&ztecid=${session.ztecid}`;

    const upstream = await fetchSticky(origin => {
      const base = `${origin}/001/2/ch0000009099000000${channelId}/`;
      return path.includes("?")
        ? `${base}${path}&${authParams}`
        : `${base}${path}?${authParams}`;
    }, req, session);

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

    res.set({
      "Content-Type": "video/mp4",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    });

    upstream.body.pipe(res);

  } catch (err) {
    res.status(502).end();
  }
});

// =========================
// START SERVER
// =========================
app.listen(PORT, () => {
  console.log(`✅ DASH/HLS proxy running on port ${PORT}`);
});
