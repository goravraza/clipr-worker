import express from "express";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const pexec = promisify(execFile);
const app = express();
app.use(express.json({ limit: "2mb" }));

const SECRET = process.env.WORKER_SHARED_SECRET || "";

function verify(req) {
  const sig = req.header("x-worker-signature") || "";
  const mac = crypto.createHmac("sha256", SECRET)
    .update(JSON.stringify(req.body)).digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(mac)); }
  catch { return false; }
}

app.get("/health", (_, res) => res.json({ ok: true }));

// POST /render  { source_url, clips:[{id,start,end,caption?}], upload: { url, headers }, callback?: {url, secret} }
app.post("/render", async (req, res) => {
  if (SECRET && !verify(req)) return res.status(401).json({ error: "bad signature" });
  const { source_url, clips = [], upload, callback } = req.body || {};
  if (!source_url || !upload?.url) return res.status(400).json({ error: "missing source_url or upload.url" });

  res.json({ accepted: true, count: clips.length });

  const dir = await mkdtemp(path.join(tmpdir(), "clipr-"));
  const src = path.join(dir, "src.mp4");
  try {
    await pexec("yt-dlp", ["-f", "mp4/bestvideo*+bestaudio/best", "-o", src, source_url], { maxBuffer: 1 << 26 });
    for (const c of clips) {
      const out = path.join(dir, `${c.id}.mp4`);
      const dur = Math.max(1, Number(c.end) - Number(c.start));
      const vf = "crop=ih*9/16:ih,scale=1080:1920";
      await pexec("ffmpeg", ["-y","-ss",String(c.start),"-i",src,"-t",String(dur),
        "-vf",vf,"-c:v","libx264","-preset","veryfast","-crf","23","-c:a","aac","-b:a","128k",out]);
      const buf = await readFile(out);
      const putUrl = typeof upload.url === "string" ? upload.url : upload.url[c.id];
      await fetch(putUrl, { method: "PUT", headers: upload.headers || {}, body: buf });
    }
    if (callback?.url) {
      const body = JSON.stringify({ ok: true, clips: clips.map(c => c.id) });
      const sig = crypto.createHmac("sha256", callback.secret || SECRET).update(body).digest("hex");
      await fetch(callback.url, { method: "POST", headers: { "content-type":"application/json", "x-worker-signature": sig }, body });
    }
  } catch (e) {
    if (callback?.url) {
      const body = JSON.stringify({ ok: false, error: String(e?.message || e) });
      const sig = crypto.createHmac("sha256", callback.secret || SECRET).update(body).digest("hex");
      await fetch(callback.url, { method: "POST", headers: { "content-type":"application/json", "x-worker-signature": sig }, body }).catch(()=>{});
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

app.listen(process.env.PORT || 10000, () => console.log("worker up"));
