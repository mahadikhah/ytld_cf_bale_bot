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

TOKEN = os.environ.get("BALE_BOT_TOKEN", "YOUR_TOKEN_HERE")
BASE_URL = f"https://tapi.bale.ai/bot{TOKEN}"
ACTION = os.environ.get("ACTION", "formats")
CHAT_ID = int(os.environ.get("CHAT_ID", "0"))
VIDEO_URL = os.environ.get("VIDEO_URL", "")
FORMAT_ID = os.environ.get("FORMAT_ID", "")
DELIVERY_METHOD = os.environ.get("DELIVERY_METHOD", "bale")
ENABLE_S3 = os.environ.get("ENABLE_S3", "false").lower() == "true"

TEMP_DIR = "temp_videos"
MAX_FILE_SIZE = 15 * 1024 * 1024   # 15 MB chunks (safe under Bale's 20 MB limit)

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

def ensure_mp4(file_path):
    if file_path.lower().endswith('.mp4'):
        cmd = ["ffprobe", "-v", "error", "-show_entries", "format=format_name", "-of", "default=noprint_wrappers=1:nokey=1", file_path]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if 'mp4' in result.stdout.lower():
            return file_path
    logger.info(f"Converting {file_path} to MP4 container...")
    new_path = file_path.rsplit('.', 1)[0] + "_remux.mp4"
    cmd = ["ffmpeg", "-i", file_path, "-c", "copy", "-movflags", "+faststart", new_path]
    subprocess.run(cmd, check=True, capture_output=True)
    os.remove(file_path)
    os.rename(new_path, file_path)
    return file_path

def get_clean_title(url):
    """Fetches the video title and removes illegal filename characters."""
    cmd = [
        "yt-dlp", "--cookies", "cookies.txt",
        "--remote-components", "ejs:github",
        "--no-check-certificates",
        "--print", "title", url
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode == 0 and result.stdout.strip():
        title = result.stdout.strip()
        # Strip illegal characters for OS file naming
        clean = re.sub(r'[\\/*?:"<>|]', "", title)
        # Limit length to 45 chars to prevent OS path length limits
        return clean[:45].strip()
    return "Video"

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

    resolution_map = {
        2160: "4K",
        1440: "QHD",
        1080: "FHD",
        720: "HD",
        480: "SD",
        360: "LD",
        240: "240p",
    }

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
        
        res_label = resolution_map.get(height, f"{height}p")
        stripped_note = ""
        if format_note:
            stripped_note = re.sub(
                rf'^{re.escape(f"{height}p")}\s*', '', format_note, count=1
            ).strip()
        
        if tbr and duration > 0:
            total_bytes = tbr * 1000 * duration / 8
            size_mb = total_bytes / (1024 * 1024)
        elif size > 0:
            size_mb = size / (1024 * 1024)
        else:
            size_mb = 0

        if size_mb >= 1024:
            size_label = f"{size_mb/1024:.1f} GB"
        elif size_mb > 0:
            size_label = f"{size_mb:.0f} MB"
        else:
            size_label = "? MB"
        
        label = res_label
        if stripped_note:
            label += f" {stripped_note}"
        if vcodec and vcodec not in label:
            label += f" ({vcodec})"
        label += f" - {size_label}"
        
        formats.append({
            "format_id": f["format_id"], 
            "label": label, 
            "height": height,
            "size": size
        })
        
    seen_keys = set()
    unique = []
    for f in formats:
        size_mb = f["size"] // 1024 // 1024
        unique_key = f"{f['height']}_{size_mb}"
        if unique_key not in seen_keys:
            seen_keys.add(unique_key)
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
    ensure_mp4(output_path)
    return output_path

def split_and_send(file_path, base_name):
    file_size = os.path.getsize(file_path)
    if file_size <= MAX_FILE_SIZE:
        if send_document(file_path):
            return
        raise Exception("Failed to send the complete file.")

    logger.info("File exceeds max size, creating multi-part zip archive...")
    
    file_dir = os.path.dirname(file_path) or "."
    file_name = os.path.basename(file_path)
    zip_base_name = f"{base_name}.zip"
    
    chunk_size_mb = MAX_FILE_SIZE // (1024 * 1024)
    
    cmd = [
        "zip", "-s", f"{chunk_size_mb}m",
        zip_base_name,
        file_name
    ]
    
    logger.info(f"Running command: {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=file_dir, capture_output=True, text=True)
    if result.returncode != 0:
        logger.error(f"Zip failed: {result.stderr}")
        raise Exception("Failed to create zip archives. Ensure 'zip' is installed.")

    split_files = []
    for f in os.listdir(file_dir):
        if f.startswith(base_name) and (f.endswith('.zip') or re.search(r'\.z\d+$', f)):
            split_files.append(os.path.join(file_dir, f))
            
    def sort_parts(filepath):
        ext = os.path.splitext(filepath)[1].lower()
        if ext == '.zip':
            return 999999
        try:
            return int(ext.replace('.z', ''))
        except ValueError:
            return 0

    split_files.sort(key=sort_parts)
    
    for part_num, chunk in enumerate(split_files, 1):
        chunk_size = os.path.getsize(chunk)
        logger.info(f"Sending zip part {part_num}/{len(split_files)}: {os.path.basename(chunk)} ({chunk_size//1024//1024} MB)")
        if not send_document(chunk):
            raise Exception(f"Failed to send zip part {part_num}")
        os.remove(chunk)
        time.sleep(1)

def cleanup():
    if os.path.exists(TEMP_DIR):
        for f in Path(TEMP_DIR).glob("*"):
            f.unlink()
        os.rmdir(TEMP_DIR)

# ---------- S3 helpers (only used when ENABLE_S3 is true) ----------
def upload_to_s3(file_path, file_name):
    accounts = []
    for i in range(1, 6):
        prefix = f"S3_ACCOUNT_{i}_"
        endpoint = os.environ.get(f"{prefix}ENDPOINT")
        if not endpoint:
            continue
        access_key = os.environ.get(f"{prefix}ACCESS_KEY")
        secret_key = os.environ.get(f"{prefix}SECRET_KEY")
        region = os.environ.get(f"{prefix}REGION")
        bucket = os.environ.get(f"{prefix}BUCKET_NAME")
        if not all([access_key, secret_key, region, bucket]):
            continue
        accounts.append({
            "endpoint": endpoint,
            "access_key": access_key,
            "secret_key": secret_key,
            "region": region,
            "bucket": bucket,
        })
    if not accounts:
        logger.error("No S3 accounts configured")
        return None
    best = None
    for acc in accounts:
        try:
            env = {
                **os.environ,
                "AWS_ACCESS_KEY_ID": acc["access_key"],
                "AWS_SECRET_ACCESS_KEY": acc["secret_key"],
                "AWS_DEFAULT_REGION": acc["region"],
            }
            cmd = [
                "aws", "s3", "ls", f"s3://{acc['bucket']}/",
                "--recursive", "--endpoint-url", acc["endpoint"],
                "--region", acc["region"], "--summarize"
            ]
            res = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=30)
            size_line = [l for l in res.stdout.splitlines() if "Total Size" in l]
            used = 0
            if size_line:
                used = int(size_line[0].split(":")[-1].strip())
            free = 5 * 1024 * 1024 * 1024 - used
            if free > 100 * 1024 * 1024:
                best = acc
                logger.info(f"Selected bucket '{acc['bucket']}' with {free//1024//1024} MB free")
                break
        except Exception as e:
            logger.warning(f"Error checking bucket '{acc['bucket']}': {e}")
    if not best:
        logger.error("No bucket with enough free space")
        return None
    acc = best
    s3_key = f"{file_name}_{int(time.time())}.mp4"
    env = {
        **os.environ,
        "AWS_ACCESS_KEY_ID": acc["access_key"],
        "AWS_SECRET_ACCESS_KEY": acc["secret_key"],
        "AWS_DEFAULT_REGION": acc["region"],
    }
    cmd_upload = [
        "aws", "s3", "cp", file_path, f"s3://{acc['bucket']}/{s3_key}",
        "--endpoint-url", acc["endpoint"], "--region", acc["region"]
    ]
    try:
        logger.info("Starting S3 upload (timeout 180s)…")
        upload_res = subprocess.run(cmd_upload, capture_output=True, text=True, env=env, timeout=180)
        if upload_res.returncode != 0:
            logger.error(f"Upload failed (rc={upload_res.returncode}): {upload_res.stderr.strip()}")
            return None
    except subprocess.TimeoutExpired:
        logger.error("S3 upload timed out after 3 minutes")
        return None
    cmd_presign = [
        "aws", "s3", "presign", f"s3://{acc['bucket']}/{s3_key}",
        "--endpoint-url", acc["endpoint"], "--region", acc["region"],
        "--expires-in", "7200"
    ]
    try:
        presign_res = subprocess.run(cmd_presign, capture_output=True, text=True, env=env, timeout=15)
        if presign_res.returncode != 0:
            logger.error(f"Presign failed: {presign_res.stderr.strip()}")
            return None
    except subprocess.TimeoutExpired:
        logger.error("Presign timed out")
        return None
    presigned = presign_res.stdout.strip()
    expire_epoch = int(time.time()) + 7200
    marker_key = f"{s3_key}.txt"
    with open("/tmp/marker.txt", "w") as f:
        f.write(str(expire_epoch))
    cmd_marker = [
        "aws", "s3", "cp", "/tmp/marker.txt", f"s3://{acc['bucket']}/{marker_key}",
        "--endpoint-url", acc["endpoint"], "--region", acc["region"]
    ]
    subprocess.run(cmd_marker, capture_output=True, text=True, env=env, timeout=15)
    logger.info("S3 upload successful")
    return presigned

def main():
    logger.info(f"Action: {ACTION} for chat {CHAT_ID}")
    out_file = None
    error_occurred = False
    try:
        if ACTION == "formats":
            title, duration, formats = get_video_formats(VIDEO_URL)
            if not formats:
                send_message("❌ No downloadable formats found.")
                return
            buttons, row = [], []
            for f in formats:
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
            send_message("⏳ Fetching video details and starting download...")
            clean_title = get_clean_title(VIDEO_URL)
            base_name = f"{clean_title}_{FORMAT_ID}"
            out_file = os.path.join(TEMP_DIR, f"{base_name}.mp4")
            os.makedirs(TEMP_DIR, exist_ok=True)
            download_video(VIDEO_URL, FORMAT_ID, out_file)
            file_size = os.path.getsize(out_file)

            # Delivery method handling
            delivery_method = DELIVERY_METHOD
            if delivery_method == "s3" and not ENABLE_S3:
                logger.info("S3 disabled – falling back to Bale")
                delivery_method = "bale"

            if delivery_method == "s3":
                send_message("☁️ Uploading to cloud and generating download link...")
                url = upload_to_s3(out_file, base_name)
                if url:
                    send_message(f"✅ *Your download link (valid 2 hours):*\n{url}")
                else:
                    send_message("❌ Cloud upload failed. Please try again later.")
            else:
                try:
                    send_message(f"📤 Uploading **{clean_title}** ({file_size//1024//1024} MB) as a multi-part zip...")
                    split_and_send(out_file, base_name)
                    send_message(
                        "✅ Download complete!\n\n"
                        "**How to open your video:**\n"
                        "1. Download all the parts (`.z01`, `.z02`... and `.zip`) into the *same folder*.\n"
                        "2. Open/Extract ONLY the final `.zip` file.\n"
                        "3. Your system will automatically pull the pieces together to rebuild the full `.mp4` video."
                    )
                except Exception as e:
                    logger.exception("Bale upload failed")
                    if ENABLE_S3:
                        send_message("⚠️ Bale upload failed. Trying cloud upload instead...")
                        url = upload_to_s3(out_file, base_name)
                        if url:
                            send_message(f"✅ *Your download link (valid 2 hours):*\n{url}")
                        else:
                            send_message("❌ All upload methods failed. Sorry!")
                    else:
                        send_message("❌ Bale upload failed and S3 is not enabled. Sorry!")
            
    except Exception as e:
        error_occurred = True
        logger.exception("Action failed")
        send_message(f"⚠️ Error: {str(e)[:200]}")
        if out_file and os.path.exists(out_file):
            logger.info(f"Saving failed file as artifact: {out_file}")
            os.makedirs("artifacts", exist_ok=True)
            os.rename(out_file, f"artifacts/{os.path.basename(out_file)}")
    finally:
        if out_file and os.path.exists(out_file):
            os.remove(out_file)
        cleanup()
        worker_url = os.environ.get("WORKER_URL")
        worker_secret = os.environ.get("WORKER_SECRET")
        if worker_url and worker_secret and ACTION == "download":
            try:
                requests.post(
                    f"{worker_url}/github/done",
                    json={"secret": worker_secret, "chat_id": str(CHAT_ID)},
                    timeout=5
                )
                logger.info("Successfully unlocked user queue on Cloudflare Worker.")
            except Exception as e:
                logger.error(f"Failed to unlock user queue: {e}")
        if error_occurred:
            sys.exit(1)

if __name__ == "__main__":
    main()
