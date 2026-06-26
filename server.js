import express from "express";
import crypto from "crypto";
import { spawn } from "child_process";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import { createClient } from "@supabase/supabase-js";

const PORT = process.env.PORT || 10000;
const SECRET = (process.env.WORKER_SHARED_SECRET || "").trim();
const COOKIES_SRC = "/etc/secrets/youtube-cookies.txt";
const COOKIES_DST = "/tmp/youtube-cookies.txt";

const app = express();
app.use(express.json({
  limit: "2mb",
  verify: (req, _res, buf) => { req.rawBody = buf.toString("utf8"); },
}));

function authOk(req) {
  if (!SECRET) return false;
  const hdr =
    req.headers["x-shared-secret"] ||
    req.headers["x-worker-secret"] ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (hdr && hdr === SECRET) return true;
  const sig = req.headers["x-signature"];
  if (sig && req.rawBody) {
    const expected = crypto.createHmac("sha256", SECRET).update(req.rawBody).digest("hex");
    try {
      if (crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return true;
    } catch {}
  }
  return false;
}

function ensureCookies() {
  try {
    if (fs.existsSync(COOKIES_SRC)) {
      fs.copyFileSync(COOKIES_SRC, COOKIES_DST);
      return COOKIES_DST;
    }
  } catch (e) {
    console.warn("cookie copy failed:", e.message);
  }
  return null;
}

function run(cmd, args, label) {
  return new Promise((resolve, reject) => {
    console.log(`[${label}] ${cmd} ${args.join(" ")}`);
    const p = spawn(cmd, args);
    let stderr = "";
    p.stdout.on("data", (d) => process.stdout.write(`[${label}] ${d}`));
    p.stderr.on("data", (d) => { stderr += d.toString(); process.stderr.write(`[${label}] ${d}`); });
    p.on("error", reject);
    p.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${label} exit ${code}: ${stderr.slice(-400)}`)));
  });
}

async function downloadSegment({ sourceUrl, start, end, outTemplate, label }) {
  const cookies = ensureCookies();
  const section = `*${Math.max(0, start - 1)}-${end + 1}`;
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--force-overwrites",
    "--download-sections", section,
    "-f", "bv*+ba/b",
    "-S", "res:1080,fps,br",
    "--merge-output-format", "mp4",
    "-o", outTemplate,
  ];
  if (cookies) args.push("--cookies", cookies);
  args.push(sourceUrl);
  await run("yt-dlp", args, label);
}

async function ffmpegCrop916({ inFile, outFile, start, end, label }) {
  const duration = Math.max(1, end - start);
  const vf =
    "[0:v]split=2[bg][fg];" +
    "[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=40:1[bgb];" +
    "[fg]scale=1080:-2[fgs];" +
    "[bgb][fgs]overlay=(W-w)/2:(H-h)/2";
  await run("ffmpeg", [
    "-y",
    "-ss", String(start),
    "-i", inFile,
    "-t", String(duration),
    "-filter_complex", vf,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    outFile,
  ], label);
}

async function uploadToSignedUrl(signedUrl, filePath) {
  const buf = await fsp.readFile(filePath);
  const r = await fetch(signedUrl, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4", "x-upsert": "true" },
    body: buf,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`upload ${r.status}: ${t.slice(0, 200)}`);
  }
}

async function callback({ url, secret, payload }) {
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-worker-secret": secret || "",
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.warn("callback failed:", e.message);
  }
}

async function processClip({ clip, sourceUrl, upload, callbackUrl, callbackSecret }) {
  const id = clip.clip_id || clip.clipId || clip.id;
  const start = Number(clip.start ?? clip.start_time_seconds ?? 0);
  const end = Number(clip.end ?? clip.end_time_seconds ?? start + 30);
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), `clip-${id}-`));
  const sourceTemplate = path.join(tmpDir, "src.%(ext)s");
  const finalPath = path.join(tmpDir, "out.mp4");
  const label = `clip ${id}`;
  try {
    await downloadSegment({ sourceUrl, start, end, outTemplate: sourceTemplate, label });
    const files = await fsp.readdir(tmpDir);
    const srcFile = files.find((f) => f.startsWith("src."));
    if (!srcFile) throw new Error("downloaded source file missing");
    const sourcePath = path.join(tmpDir, srcFile);
    await ffmpegCrop916({ inFile: sourcePath, outFile: finalPath, start: 0, end: end - start, label });
    if (upload?.url) {
      await uploadToSignedUrl(upload.url, finalPath);
    }
    await callback({
      url: callbackUrl,
      secret: callbackSecret,
      payload: {
        status: "done",
        clip_id: id,
        storage_path: upload?.path,
        output_url: null,
      },
    });
    console.log(`[${label}] done`);
  } catch (e) {
    console.error(`[${label}] error:`, e.message);
    await callback({
      url: callbackUrl,
      secret: callbackSecret,
      payload: { status: "error", clip_id: id, error: e.message.slice(0, 500) },
    });
  } finally {
    fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

app.get("/health", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: "unauthorized" });
  res.json({ ok: true });
});

app.post("/render", async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: "unauthorized" });
  const body = req.body || {};
  const sourceUrl = body.source_url || body.sourceUrl;
  const upload = body.upload || (body.upload_url ? { url: body.upload_url, path: body.storage_path } : null);
  const callbackUrl = body.callback_url || body.callbackUrl || body.webhook_url;
  const callbackSecret = body.callback_secret || body.callbackSecret || SECRET;

  let clips = Array.isArray(body.clips) && body.clips.length
    ? body.clips
    : (body.clip_id || body.clipId || body.id)
      ? [{ clip_id: body.clip_id || body.clipId || body.id, start: body.start, end: body.end,
           start_time_seconds: body.start_time_seconds, end_time_seconds: body.end_time_seconds }]
      : [];

  if (!sourceUrl) return res.status(400).json({ error: "missing source_url" });
  if (!upload?.url) return res.status(400).json({ error: "missing upload.url" });
  if (!clips.length) return res.status(400).json({ error: "missing clips" });

  res.status(202).json({ accepted: true, count: clips.length });

  Promise.all(clips.map((clip) =>
    processClip({ clip, sourceUrl, upload, callbackUrl, callbackSecret })
  )).catch((e) => console.error("batch error:", e.message));
});

app.listen(PORT, () => console.log(`worker listening on ${PORT}, cookies=${fs.existsSync(COOKIES_SRC) ? "yes" : "no"}`));
