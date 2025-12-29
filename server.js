import express from "express";
import cors from "cors";
import http from "http";
import https from "https";
import { PassThrough } from "stream";

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
    ztecid: `ch0000009099000000${channelId}${Math.floor(Math.random() * 9000 + 1000)}`,
    lastUsed: Date.now()
  };
}

function getSession(channelId) {
  let session = channelSessions.get(channelId);
  if (!session) {
    session = createSession(channelId);
    channelSessions.set(channelId, session);
  }
  session.lastUsed = Date.now();
  return session;
}

function rotateOrigin(session) {
  session.originIndex = (session.originIndex + 1) % ORIGINS.length;
}

// cleanup idle sessions (30 min)
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of channelSessions) {
    if (now - session.lastUsed > 30 * 60 * 1000) {
      channelSessions.delete(id);
    }
  }
}, 5 * 60 * 1000);

// =========================
// FETCH WITH FAILOVER
// =========================
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
          "Accept": req.headers["accept"] || "*/*",
          "Range": req.headers["range"],
          "Connection": "keep-alive"
        }
      });

      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { res, controller };

    } catch (err) {
      clearTimeout(timeout);
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
  res.send("Enjoy your life");
});

// =========================
// DASH / SEGMENT PROXY
// =========================
app.get("/:channelId/*", async (req, res) => {
  const { channelId } = req.params;
  const path = req.params[0];

  if (!/^\d+$/.test(channelId) || path.includes("..")) {
    return res.status(400).end();
  }

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
    `&ztecid=${session.ztecid}`;

  try {
    const { res: upstream, controller } = await fetchSticky(origin => {
      const base = `${origin}/001/2/ch0000009099000000${channelId}/`;
      return path.includes("?")
        ? `${base}${path}&${authParams}`
        : `${base}${path}?${authParams}`;
    }, req, session);

    // =========================
    // MPD REWRITE
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
    // SEGMENT STREAMING
    // =========================
    res.set({
      "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Connection": "keep-alive"
    });

    const proxyStream = new PassThrough();
    proxyStream.pipe(res);

    let lastChunk = Date.now();
    const STALL_LIMIT = 3000;

    const stallTimer = setInterval(() => {
      if (Date.now() - lastChunk > STALL_LIMIT) {
        console.warn("⚠️ Stall detected, rotating origin");
        rotateOrigin(session);
        controller.abort();
      }
    }, 500);

    const reader = upstream.body.getReader();

    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          lastChunk = Date.now();
          proxyStream.write(Buffer.from(value));
        }
      } catch {
        rotateOrigin(session);
      } finally {
        clearInterval(stallTimer);
        proxyStream.end();
      }
    })();

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
