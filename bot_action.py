#!/usr/bin/env python3
import os
import sys
import json
import logging
import subprocess
import time
import requests
import re
from pathlib import Path
from urllib.parse import quote

TOKEN = os.environ["BALE_BOT_TOKEN"]
BASE_URL = f"https://tapi.bale.ai/bot{TOKEN}"
ACTION = os.environ["ACTION"]
CHAT_ID = int(os.environ["CHAT_ID"])
VIDEO_URL = os.environ["VIDEO_URL"]
FORMAT_ID = os.environ.get("FORMAT_ID", "")

TEMP_DIR = "temp_videos"
MAX_FILE_SIZE = 15 * 1024 * 1024   # 15 MB chunks (safe under Bale's 50 MB limit)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler("bot.log"),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

def send_message(text, reply_markup=None):
    url = f"{BASE_URL}/sendMessage"
    payload = {"chat_id": CHAT_ID, "text": text, "parse_mode": "Markdown"}
    if reply_markup:
        payload["reply_markup"] = json.dumps(reply_markup)
    try:
        r = requests.post(url, json=payload, timeout=10)
        if not r.ok:
            logger.error(f"Send message failed: {r.status_code} {r.text}")
    except Exception as e:
        logger.error(f"Send message exception: {e}")

def send_document(file_path):
    """Send a document (generic file) via multipart/form-data."""
    url = f"{BASE_URL}/sendDocument"
    try:
        with open(file_path, "rb") as f:
            files = {"document": (os.path.basename(file_path), f)}
            data = {"chat_id": CHAT_ID}
            r = requests.post(url, data=data, files=files, timeout=120)
            if r.ok:
                logger.info(f"Document sent: {file_path} ({os.path.getsize(file_path)//1024//1024} MB)")
                return True
            else:
                logger.error(f"sendDocument failed: {r.status_code} {r.text[:300]}")
                return False
    except Exception as e:
        logger.error(f"sendDocument exception: {e}")
        return False

def send_video(file_path):
    """Send a video file via multipart/form-data."""
    url = f"{BASE_URL}/sendVideo"
    try:
        with open(file_path, "rb") as f:
            files = {"video": (os.path.basename(file_path), f)}
            data = {"chat_id": CHAT_ID}
            r = requests.post(url, data=data, files=files, timeout=120)
            if r.ok:
                logger.info(f"Video sent: {file_path} ({os.path.getsize(file_path)//1024//1024} MB)")
                return True
            else:
                logger.error(f"sendVideo failed: {r.status_code} {r.text[:300]}")
                return False
    except Exception as e:
        logger.error(f"sendVideo exception: {e}")
        return False

def ensure_mp4(file_path):
    """Check if file is a valid MP4; if not, attempt to remux with ffmpeg."""
    # Quick check by extension
    if file_path.lower().endswith('.mp4'):
        # Use ffprobe to verify container
        cmd = ["ffprobe", "-v", "error", "-show_entries", "format=format_name", "-of", "default=noprint_wrappers=1:nokey=1", file_path]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if 'mp4' in result.stdout.lower():
            return file_path
    # If not MP4, remux to MP4
    logger.info(f"Converting {file_path} to MP4 container...")
    new_path = file_path.rsplit('.', 1)[0] + "_remux.mp4"
    cmd = ["ffmpeg", "-i", file_path, "-c", "copy", "-movflags", "+faststart", new_path]
    subprocess.run(cmd, check=True, capture_output=True)
    os.remove(file_path)
    os.rename(new_path, file_path)
    return file_path

def get_video_formats(url):
    cmd = [
        "yt-dlp", "--cookies", "cookies.txt",
        "--remote-components", "ejs:github",
        "--extractor-args", "youtube:skip=webpage",
        "--no-check-certificates",
        "--dump-json", url
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        logger.error(f"yt-dlp stderr:\n{result.stderr}")
        with open("yt-dlp-error.log", "w") as f:
            f.write(f"STDERR:\n{result.stderr}\n\nSTDOUT:\n{result.stdout}")
        raise Exception("Failed to get video info. Check yt-dlp-error.log artifact.")
    data = json.loads(result.stdout)
    title = data.get("title", "Unknown")
    duration = data.get("duration", 0)
    formats = []
    for f in data.get("formats", []):
        if f.get("vcodec") == "none":
            continue
        height = f.get("height") or 0
        if height == 0:
            continue
        size = f.get("filesize") or f.get("filesize_approx") or 0
        vcodec = f.get("vcodec", "").split(".")[0]
        format_note = f.get("format_note", "")
        tbr = f.get("tbr")
        label = f"{height}p"
        if format_note and format_note != str(height):
            label += f" {format_note}"
        if vcodec and vcodec not in label:
            label += f" ({vcodec})"
        if tbr:
            label += f" ~{tbr:.0f}kbps"
        elif size:
            label += f" ~{size//1024//1024} MB"
        formats.append({"format_id": f["format_id"], "label": label, "height": height})
    seen = set()
    unique = []
    for f in formats:
        if f["format_id"] not in seen:
            seen.add(f["format_id"])
            unique.append(f)
    unique.sort(key=lambda x: -x["height"])
    logger.info(f"Found {len(unique)} formats")
    return title, duration, unique

def download_video(url, format_id, output_path):
    cmd = [
        "yt-dlp", "--cookies", "cookies.txt",
        "--remote-components", "ejs:github",
        "--extractor-args", "youtube:skip=webpage",
        "--no-check-certificates",
        "-f", f"{format_id}+bestaudio[ext=m4a]/bestaudio",
        "--merge-output-format", "mp4",
        "-o", output_path, url
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        logger.error(f"Download stderr: {result.stderr}")
        raise Exception("Download failed")
    if not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
        raise Exception("Downloaded file empty")
    # Ensure the file is MP4 container
    ensure_mp4(output_path)
    return output_path

def split_and_send(file_path, base_name):
    file_size = os.path.getsize(file_path)
    if file_size <= MAX_FILE_SIZE:
        # Try sendVideo first for MP4
        if send_video(file_path):
            return
        elif send_document(file_path):
            return
        else:
            raise Exception("Failed to send file (both document and video methods).")
    os.makedirs(TEMP_DIR, exist_ok=True)
    ext = os.path.splitext(file_path)[1]
    base = os.path.basename(file_path).replace(ext, "")
    pattern = os.path.join(TEMP_DIR, f"{base}_part_%03d{ext}")
    cmd = [
        "ffmpeg", "-i", file_path, "-c", "copy", "-map", "0",
        "-f", "segment", "-segment_time", "999999", "-reset_timestamps", "1",
        "-fs", str(MAX_FILE_SIZE), pattern
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    part = 1
    while True:
        chunk = os.path.join(TEMP_DIR, f"{base}_part_{part:03d}{ext}")
        if not os.path.exists(chunk):
            break
        chunk_size = os.path.getsize(chunk)
        logger.info(f"Sending part {part} ({chunk_size//1024//1024} MB)")
        if not send_video(chunk):
            if not send_document(chunk):
                raise Exception(f"Failed to send part {part}")
        os.remove(chunk)
        part += 1
        time.sleep(0.5)

def cleanup():
    if os.path.exists(TEMP_DIR):
        for f in Path(TEMP_DIR).glob("*"):
            f.unlink()
        os.rmdir(TEMP_DIR)

def main():
    logger.info(f"Action: {ACTION} for chat {CHAT_ID}")
    try:
        if ACTION == "formats":
            title, duration, formats = get_video_formats(VIDEO_URL)
            if not formats:
                send_message("❌ No downloadable formats found.")
                return
            buttons, row = [], []
            for f in formats[:6]:
                cb = f"format|{quote(VIDEO_URL, safe='')}|{quote(f['format_id'], safe='')}"
                row.append({"text": f["label"], "callback_data": cb})
                if len(row) == 2:
                    buttons.append(row)
                    row = []
            if row:
                buttons.append(row)
            dur_str = f"{duration//60}:{duration%60:02d}" if duration else "unknown"
            send_message(f"🎥 *{title}*\n⏱️ {dur_str}\n\nSelect quality:", {"inline_keyboard": buttons})
        elif ACTION == "download":
            if not FORMAT_ID:
                raise ValueError("Missing format_id")
            send_message("⏳ Downloading and processing video...")
            video_id = re.search(r'(?:v=|youtu\.be/)([a-zA-Z0-9_-]{11})', VIDEO_URL)
            video_id = video_id.group(1) if video_id else "video"
            out_file = os.path.join(TEMP_DIR, f"{video_id}_{FORMAT_ID}.mp4")
            os.makedirs(TEMP_DIR, exist_ok=True)
            download_video(VIDEO_URL, FORMAT_ID, out_file)
            file_size = os.path.getsize(out_file)
            send_message(f"📤 Uploading file ({file_size//1024//1024} MB) in chunks...")
            split_and_send(out_file, f"{video_id}_{FORMAT_ID}")
            send_message("✅ Download complete!")
            os.remove(out_file)
            cleanup()
    except Exception as e:
        logger.exception("Action failed")
        send_message(f"⚠️ Error: {str(e)[:200]}")
        # Save failed file as artifact for debugging
        if 'out_file' in locals() and os.path.exists(out_file):
            logger.info(f"Saving failed file as artifact: {out_file}")
            os.makedirs("artifacts", exist_ok=True)
            os.rename(out_file, f"artifacts/{os.path.basename(out_file)}")
        raise

if __name__ == "__main__":
    main()
