import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const pexec = promisify(execFile);
const app = express();

// Capture raw body so HMAC matches exactly what the app signed.
app.use(express.json({
  limit: "4mb",
  verify: (req, _res, buf) => { req.rawBody = buf.toString("utf8"); },
}));

const SECRET = (process.env.CLIPPER_WORKER_SHARED_SECRET || process.env.WORKER_SHARED_SECRET || "").trim();

function safeEq(a, b) {
  const A = Buffer.from(a || ""), B = Buffer.from(b || "");
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function authed(req) {
  if (!SECRET) return true;
  const sig = req.header("x-signature") || "";
  const mac = crypto.createHmac("sha256", SECRET).update(req.rawBody || "").digest("hex");
  if (safeEq(sig, mac)) return true;
  const raw = (req.header("x-shared-secret") || req.header("x-worker-secret") || req.header("authorization") || "").replace(/^Bearer\s+/i, "");
  return safeEq(raw, SECRET);
}

app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/render", async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: "bad signature" });

  const b = req.body || {};
  const source_url = b.source_url || b.sourceUrl;
  const upload = b.upload || {};
  const uploadUrl = upload.url || upload.signed_upload_url || b.upload_url || b.signed_upload_url;
  const callbackUrl = b.callback_url || b.callbackUrl || b.webhook_url || b.callback?.url;
  const callbackSecret = b.callback_secret || b.callbackSecret || b.callback?.secret || SECRET;

  // Accept either clips[] or a single top-level clip
  let clips = Array.isArray(b.clips) ? b.clips : [];
  if (clips.length === 0 && (b.clip_id || b.clipId)) {
    clips = [{
      id: b.clip_id || b.clipId,
      start: b.start ?? b.start_time_seconds,
      end: b.end ?? b.end_time_seconds,
    }];
  }
  clips = clips.map(c => ({
    id: c.id || c.clip_id || c.clipId,
    start: Number(c.start ?? c.start_time_seconds),
    end: Number(c.end ?? c.end_time_seconds),
  }));

  if (!source_url || !uploadUrl || clips.length === 0) {
    return res.status(400).json({ error: "missing source_url, upload.url or clips" });
  }

  res.json({ accepted: true, count: clips.length });

  const dir = await mkdtemp(path.join(tmpdir(), "clipr-"));
  const src = path.join(dir, "src.mp4");
  const sendCallback = async (payload) => {
    if (!callbackUrl) return;
    const body = JSON.stringify(payload);
    const sig = crypto.createHmac("sha256", callbackSecret).update(body).digest("hex");
    await fetch(callbackUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature": sig,
        "x-worker-secret": callbackSecret,
      },
      body,
    }).catch(() => {});
  };

  try {
    await pexec("yt-dlp", ["-f", "mp4/bestvideo*+bestaudio/best", "--merge-output-format", "mp4", "-o", src, source_url], { maxBuffer: 1 << 26 });

    for (const c of clips) {
      const out = path.join(dir, `${c.id}.mp4`);
      const dur = Math.max(1, c.end - c.start);
      const vf = "crop=ih*9/16:ih,scale=1080:1920";
      await pexec("ffmpeg", ["-y","-ss",String(c.start),"-i",src,"-t",String(dur),
        "-vf",vf,"-c:v","libx264","-preset","veryfast","-crf","23","-c:a","aac","-b:a","128k",out]);

      const buf = await readFile(out);
      const putUrl = typeof uploadUrl === "string" ? uploadUrl : uploadUrl[c.id];
      const putRes = await fetch(putUrl, {
        method: "PUT",
        headers: { "content-type": "video/mp4", ...(upload.headers || {}) },
        body: buf,
      });
      if (!putRes.ok) throw new Error(`upload failed ${putRes.status}: ${(await putRes.text()).slice(0,200)}`);

      await sendCallback({
        status: "done",
        clip_id: c.id,
        storage_path: upload.path,
      });
    }
  } catch (e) {
    await sendCallback({
      status: "error",
      clip_id: clips[0]?.id,
      error: String(e?.message || e).slice(0, 500),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

app.listen(process.env.PORT || 10000, () => console.log("worker up"));
