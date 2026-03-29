const { execSync, exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const fetch = require("node-fetch");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const YOUTUBE_CHANNEL = "https://www.youtube.com/@wiseeldersyt";
const DOWNLOAD_DIR = path.join(__dirname, "downloads");
const POSTED_LOG = path.join(__dirname, "posted.json");
const VIDEOS_PER_DAY = 4;
const POST_TIMES = ["08:00", "13:00", "18:00", "21:00"]; // UTC+3 (Türkiye) — ayarla

const PAGE_ID = process.env.WE_PAGE_ID;
const ACCESS_TOKEN = process.env.WE_ACCESS_TOKEN;

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function loadPosted() {
  if (!fs.existsSync(POSTED_LOG)) return [];
  return JSON.parse(fs.readFileSync(POSTED_LOG, "utf-8"));
}

function savePosted(list) {
  fs.writeFileSync(POSTED_LOG, JSON.stringify(list, null, 2));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── FETCH LATEST VIDEOS FROM CHANNEL ────────────────────────────────────────
function fetchChannelVideos() {
  console.log("📡 YouTube kanalı taranıyor...");
  const cmd = `yt-dlp --flat-playlist --dump-single-json --playlist-end 20 "${YOUTUBE_CHANNEL}"`;
  const output = execSync(cmd, { maxBuffer: 10 * 1024 * 1024 }).toString();
  const data = JSON.parse(output);
  return data.entries.map((e) => ({
    id: e.id,
    title: e.title,
    url: `https://www.youtube.com/watch?v=${e.id}`,
  }));
}

// ─── DOWNLOAD VIDEO + GET METADATA ───────────────────────────────────────────
function downloadVideo(videoId, videoUrl) {
  const outTemplate = path.join(DOWNLOAD_DIR, `${videoId}.%(ext)s`);
  console.log(`⬇️  İndiriliyor: ${videoUrl}`);

  // Video indir
  execSync(
    `yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" -o "${outTemplate}" "${videoUrl}"`,
    { stdio: "inherit" }
  );

  // Metadata JSON al
  const metaCmd = `yt-dlp --dump-single-json "${videoUrl}"`;
  const meta = JSON.parse(execSync(metaCmd, { maxBuffer: 10 * 1024 * 1024 }).toString());

  // Dosya yolunu bul
  const files = fs.readdirSync(DOWNLOAD_DIR).filter((f) => f.startsWith(videoId));
  const videoFile = files.find((f) => f.endsWith(".mp4") || f.endsWith(".webm") || f.endsWith(".mkv"));

  return {
    filePath: path.join(DOWNLOAD_DIR, videoFile),
    title: meta.title,
    description: meta.description || "",
    tags: meta.tags || [],
  };
}

// ─── BUILD FACEBOOK MESSAGE ───────────────────────────────────────────────────
function buildMessage(title, description, tags) {
  // Hashtag'leri description'dan ve tags'den topla
  const existingHashtags = (description.match(/#\w+/g) || []);
  const tagHashtags = tags.slice(0, 5).map((t) => `#${t.replace(/\s+/g, "")}`);
  const allHashtags = [...new Set([...existingHashtags, ...tagHashtags])].join(" ");

  // Description'ı temizle (varsa hashtag satırlarını sona taşı)
  const cleanDesc = description.replace(/#\w+/g, "").trim();

  return `${title}\n\n${cleanDesc}\n\n${allHashtags}`.trim();
}

// ─── UPLOAD TO FACEBOOK AS REEL + POST ───────────────────────────────────────
async function uploadToFacebook(filePath, message) {
  console.log("🚀 Facebook'a yükleniyor...");

  // STEP 1: Video upload session başlat
  const fileSize = fs.statSync(filePath).size;

  const startRes = await fetch(
    `https://graph.facebook.com/v19.0/${PAGE_ID}/videos`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        upload_phase: "start",
        file_size: fileSize,
        access_token: ACCESS_TOKEN,
      }),
    }
  );
  const startData = await startRes.json();
  if (!startData.upload_session_id) {
    throw new Error("Upload session başlatılamadı: " + JSON.stringify(startData));
  }

  const { upload_session_id, video_id, start_offset, end_offset } = startData;
  console.log(`📦 Session ID: ${upload_session_id}`);

  // STEP 2: Video chunk yükle
  let currentStart = parseInt(start_offset);
  let currentEnd = parseInt(end_offset);
  const fileBuffer = fs.readFileSync(filePath);

  while (currentStart < fileSize) {
    const chunk = fileBuffer.slice(currentStart, currentEnd);
    const form = new FormData();
    form.append("upload_phase", "transfer");
    form.append("upload_session_id", upload_session_id);
    form.append("start_offset", currentStart.toString());
    form.append("video_file_chunk", chunk, {
      filename: path.basename(filePath),
      contentType: "video/mp4",
    });
    form.append("access_token", ACCESS_TOKEN);

    const transferRes = await fetch(
      `https://graph.facebook.com/v19.0/${PAGE_ID}/videos`,
      { method: "POST", body: form }
    );
    const transferData = await transferRes.json();

    if (transferData.error) {
      throw new Error("Transfer hatası: " + JSON.stringify(transferData.error));
    }

    currentStart = parseInt(transferData.start_offset);
    currentEnd = parseInt(transferData.end_offset);
    console.log(`📤 Yüklendi: ${currentStart}/${fileSize} byte`);
  }

  // STEP 3: Finish — Reels olarak yayınla (ABD konumu)
  const finishRes = await fetch(
    `https://graph.facebook.com/v19.0/${PAGE_ID}/videos`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        upload_phase: "finish",
        upload_session_id,
        description: message,
        title: message.split("\n")[0],
        place: "110769898948540", // United States
        published: true,
        content_category: "ENLIGHTENING",
        access_token: ACCESS_TOKEN,
      }),
    }
  );
  const finishData = await finishRes.json();
  console.log("✅ Facebook'a yüklendi:", JSON.stringify(finishData));
  return finishData;
}

// ─── CLEANUP ──────────────────────────────────────────────────────────────────
function cleanup(filePath) {
  try {
    fs.unlinkSync(filePath);
    console.log(`🗑️  Silindi: ${filePath}`);
  } catch (e) {
    console.warn("Temizleme hatası:", e.message);
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== Wise Elders Bot Başladı ===");
  ensureDir(DOWNLOAD_DIR);

  const posted = loadPosted();
  const videos = fetchChannelVideos();

  // Daha önce paylaşılmamış videoları filtrele
  const newVideos = videos.filter((v) => !posted.includes(v.id));

  if (newVideos.length === 0) {
    console.log("⚠️  Yeni video bulunamadı.");
    return;
  }

  // Bugün için 1 video al (cron günde 4 kez çalışacak, her seferinde 1 video)
  const video = newVideos[0];
  console.log(`🎬 Video: ${video.title}`);

  let filePath = null;
  try {
    const { filePath: fp, title, description, tags } = downloadVideo(video.id, video.url);
    filePath = fp;
    const message = buildMessage(title, description, tags);
    await uploadToFacebook(filePath, message);

    // Başarılıysa kaydet
    posted.push(video.id);
    savePosted(posted);
    console.log("✅ Tamamlandı:", video.title);
  } catch (err) {
    console.error("❌ Hata:", err.message);
  } finally {
    if (filePath && fs.existsSync(filePath)) cleanup(filePath);
  }
}

main();
