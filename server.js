import express from "express";
import crypto from "crypto";
import { spawn } from "child_process";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import { createClient } from "@supabase/supabase-js";

const PORT = process.env.PORT || 10000;
const SHARED_SECRET = process.env.WORKER_SHARED_SECRET || process.env.CLIPPER_WORKER_SHARED_SECRET || "";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STORAGE_BUCKET = process.env.STORAGE_BUCKET || "clips";
const COOKIES_SRC = "/etc/secrets/youtube-cookies.txt";
const COOKIES_DST = "/tmp/youtube-cookies.txt";

function ensureWritableCookies() {
  try {
    if (fs.existsSync(COOKIES_SRC)) {
      fs.copyFileSync(COOKIES_SRC, COOKIES_DST);
      return COOKIES_DST;
    }
  } catch (e) {
    console.error("cookie copy failed:", e.message);
  }
  return null;
}

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

const app = express();
app.use(express.json({
  limit: "2mb",
  verify: (req, _res, buf) => { req.rawBody = buf.toString("utf8"); },
}));

function verifyAuth(req) {
  const header = req.headers["x-worker-signature"] || req.headers["authorization"] || "";
  const token = String(header).replace(/^Bearer\s+/i, "").trim();
  if (!SHARED_SECRET) return false;
  if (token === SHARED_SECRET) return true;
  try {
    const expected = crypto.createHmac("sha256", SHARED_SECRET).update(req.rawBody || "").digest("hex");
    return token.length === expected.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch { return false; }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    console.log(`+ ${cmd} ${args.join(" ")}`);
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let stderr = "";
    p.stdout.on("data", (d) => process.stdout.write(d));
    p.stderr.on("data", (d) => { stderr += d.toString(); process.stderr.write(d); });
    p.on("error", reject);
    p.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}: ${stderr.slice(-500)}`)));
  });
}

function fmtTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(Math.floor(s % 60)).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

async function ffmpegCrop916(input, output, clip) {
  const duration = Math.max(1, (clip.end_time_seconds || 0) - (clip.start_time_seconds || 0));
  const vf = "[0:v]split=2[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:1[bgb];[fg]scale=1080:-2[fgs];[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1";
  await run("ffmpeg", [
    "-y", "-i", input, "-t", String(duration),
    "-filter_complex", vf,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    output,
  ]);
}

async function uploadToStorage(localPath, key) {
  if (!supabase) throw new Error("supabase not configured");
  const data = await fsp.readFile(localPath);
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(key, data, {
    contentType: "video/mp4", upsert: true,
  });
  if (error) throw new Error(`upload: ${error.message}`);
  const { data: pub } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(key);
  return pub.publicUrl;
}

async function postCallback(callbackUrl, callbackSecret, payload) {
  if (!callbackUrl) return;
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac("sha256", callbackSecret || SHARED_SECRET).update(body).digest("hex");
  try {
    const r = await fetch(callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-worker-signature": sig },
      body,
    });
    console.log(`callback ${callbackUrl} -> ${r.status}`);
  } catch (e) {
    console.error("callback error:", e.message);
  }
}

async function processClip({ clip, sourceUrl, upload, callbackUrl, callbackSecret }) {
  const clipId = clip.id || crypto.randomUUID();
  let tmpDir;
  try {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), `clip-${clipId}-`));
    const sourceTemplate = path.join(tmpDir, "source.%(ext)s");
    const finalPath = path.join(tmpDir, "final.mp4");
    const cookiesPath = ensureWritableCookies();

    const start = Math.max(0, Number(clip.start_time_seconds) || 0);
    const end = Math.max(start + 1, Number(clip.end_time_seconds) || start + 30);
    const section = `*${fmtTime(start)}-${fmtTime(end)}`;

    const ytArgs = [
      "--no-playlist",
      "--force-overwrites",
      "--no-check-formats",
      "--download-sections", section,
      "-f", "bv*+ba/b",
      "-S", "res:1080,fps,br",
      "--merge-output-format", "mp4",
      "-o", sourceTemplate,
    ];
    if (cookiesPath) ytArgs.push("--cookies", cookiesPath);
    ytArgs.push(sourceUrl);

    await run("yt-dlp", ytArgs);

    const files = await fsp.readdir(tmpDir);
    const srcFile = files.map((f) => path.join(tmpDir, f)).find((f) => /source\.(mp4|mkv|webm|m4a|mov)$/i.test(f));
    if (!srcFile) throw new Error(`yt-dlp produced no source file in ${tmpDir}: ${files.join(",")}`);

    // If yt-dlp downloaded section starting at 'start', reset start offset for ffmpeg
    const clipForCut = { ...clip, start_time_seconds: 0, end_time_seconds: end - start };
    await ffmpegCrop916(srcFile, finalPath, clipForCut);

    let publicUrl = null;
    if (upload?.url) {
      const data = await fsp.readFile(finalPath);
      const put = await fetch(upload.url, {
        method: upload.method || "PUT",
        headers: upload.headers || { "content-type": "video/mp4" },
        body: data,
      });
      if (!put.ok) throw new Error(`upload PUT ${put.status}`);
      publicUrl = upload.public_url || null;
    } else {
      const key = `renders/${clipId}.mp4`;
      publicUrl = await uploadToStorage(finalPath, key);
    }

    await postCallback(callbackUrl, callbackSecret, {
      clip_id: clipId, status: "completed", storage_url_mp4: publicUrl,
    });
    console.log(`[clip ${clipId}] done`);
  } catch (e) {
    console.error(`[clip ${clipId}] error:`, e.message);
    await postCallback(callbackUrl, callbackSecret, {
      clip_id: clipId, status: "failed", error: e.message,
    });
  } finally {
    if (tmpDir) { try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch {} }
  }
}

app.get("/health", (_req, res) => res.json({ ok: true, cookies: fs.existsSync(COOKIES_SRC) }));

app.post("/render", (req, res) => {
  if (!verifyAuth(req)) return res.status(401).json({ error: "unauthorized" });
  const { source_url, sourceUrl, upload, callback_url, callbackUrl, callback_secret, callbackSecret, clips, clip } = req.body || {};
  const src = source_url || sourceUrl;
  const cbUrl = callback_url || callbackUrl;
  const cbSecret = callback_secret || callbackSecret;
  const list = Array.isArray(clips) ? clips : (clip ? [clip] : []);
  if (!src) return res.status(400).json({ error: "missing source_url" });
  if (!list.length) return res.status(400).json({ error: "missing clips" });

  res.status(202).json({ accepted: true, count: list.length });

  Promise.all(list.map((c) => processClip({
    clip: c, sourceUrl: src, upload, callbackUrl: cbUrl, callbackSecret: cbSecret,
  }))).catch((e) => console.error("batch error:", e.message));
});

app.listen(PORT, () => console.log(`worker on :${PORT}, cookies=${fs.existsSync(COOKIES_SRC) ? "yes" : "no"}`));
