import os, subprocess, time, re, tempfile, asyncio
from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.tl.types import InputDocumentFileLocation
import requests

API_ID = 2040
API_HASH = "b18441a1ff607e10a989891a5462e627"

session_str = os.environ["TG_USER_SESSION"]
bale_token = os.environ["BALE_BOT_TOKEN"]
bale_chat = os.environ["CHAT_ID"]
tg_token = os.environ["TELEGRAM_BOT_TOKEN"]
tg_chat = os.environ["TG_CHAT_ID"]
channel_id = int(os.environ["CHANNEL_ID"])
message_id = int(os.environ["MESSAGE_ID"])
original_name = os.environ["FILE_NAME"]

MAX_SIZE = 15 * 1024 * 1024
PARALLEL_CHUNKS = 8            # number of parallel downloads
CHUNK_SIZE = 10 * 1024 * 1024   # 5 MB per chunk → less data to reassemble on failure

# ---------- Messaging ----------
def bale_api(method, payload):
    try:
        return requests.post(f"https://tapi.bale.ai/bot{bale_token}/{method}", json=payload, timeout=15).json()
    except:
        return None

def telegram_api(method, payload):
    try:
        return requests.post(f"https://api.telegram.org/bot{tg_token}/{method}", json=payload, timeout=15).json()
    except:
        return None

def send_bale(text):
    print(f"[Bale] {text}")
    return bale_api("sendMessage", {"chat_id": bale_chat, "text": text, "parse_mode": "Markdown"})

def edit_bale(msg_id, text):
    if msg_id: bale_api("editMessageText", {"chat_id": bale_chat, "message_id": msg_id, "text": text, "parse_mode": "Markdown"})

def send_telegram(text):
    print(f"[Telegram] {text}")
    return telegram_api("sendMessage", {"chat_id": tg_chat, "text": text, "parse_mode": "Markdown"})

def edit_telegram(msg_id, text):
    if msg_id: telegram_api("editMessageText", {"chat_id": tg_chat, "message_id": msg_id, "text": text, "parse_mode": "Markdown"})

def upload_file(path, caption):
    size_mb = os.path.getsize(path) // (1024*1024)
    print(f"[Upload] Sending {os.path.basename(path)} ({size_mb} MB)")
    with open(path, "rb") as f:
        resp = requests.post(f"https://tapi.bale.ai/bot{bale_token}/sendDocument",
                             data={"chat_id": bale_chat, "caption": caption},
                             files={"document": f}, timeout=120)
    if resp.ok and resp.json().get("ok"):
        print("[Upload] Success")
        return True
    print(f"[Upload] Failed: {resp.text[:200]}")
    return False

def unlock_queue():
    worker_url = os.environ.get("WORKER_URL")
    worker_secret = os.environ.get("WORKER_SECRET")
    if worker_url and worker_secret:
        try:
            requests.post(f"{worker_url}/github/done",
                          json={"secret": worker_secret, "chat_id": bale_chat}, timeout=5)
            print("[Unlock] Queue unlocked")
        except Exception as e:
            print(f"[Unlock] Failed: {e}")

# ---------- Parallel download ----------
async def download_chunk(client, location, offset, size, part_num, progress_dict):
    """Download a chunk and write to a temp file. Updates progress_dict."""
    part_file = f"part_{part_num}"
    with open(part_file, 'wb') as f:
        async for chunk in client.iter_download(location, offset=offset, request_size=1024*1024):
            f.write(chunk)
            # Update progress atomically
            if progress_dict is not None:
                progress_dict['downloaded'] += len(chunk)
            if os.path.getsize(part_file) >= size:
                break
    return part_file

async def download_parallel(client, msg, file_path, progress_dict, total):
    doc = msg.document
    location = InputDocumentFileLocation(
        id=doc.id,
        access_hash=doc.access_hash,
        file_reference=doc.file_reference,
        thumb_size=''
    )
    # Calculate chunks
    chunks = []
    offset = 0
    while offset < total:
        size = min(CHUNK_SIZE, total - offset)
        chunks.append((offset, size))
        offset += size

    print(f"[Download] {len(chunks)} chunks, {PARALLEL_CHUNKS} parallel")
    # Download in parallel batches
    for batch_start in range(0, len(chunks), PARALLEL_CHUNKS):
        batch = chunks[batch_start:batch_start+PARALLEL_CHUNKS]
        tasks = [
            download_chunk(client, location, off, sz, batch_start + i, progress_dict)
            for i, (off, sz) in enumerate(batch)
        ]
        await asyncio.gather(*tasks)

    # Reassemble
    with open(file_path, 'wb') as out:
        for i in range(len(chunks)):
            part_file = f"part_{i}"
            with open(part_file, 'rb') as p:
                out.write(p.read())
            os.remove(part_file)

# ---------- Main ----------
async def main():
    safe_name = re.sub(r'[\\/*?:"<>|]', "_", original_name)
    if len(safe_name) > 100:
        safe_name = safe_name[:50] + safe_name[-50:]

    download_dir = tempfile.mkdtemp()
    download_path = os.path.join(download_dir, safe_name)

    client = TelegramClient(StringSession(session_str), API_ID, API_HASH,
                            connection_retries=5, retry_delay=1, request_retries=5)
    await client.start()

    try:
        send_bale("🔍 Locating your file in the channel…")
        send_telegram("🔍 Locating your file in the channel…")

        message = await client.get_messages(channel_id, ids=message_id)
        if not message or not message.document:
            send_bale("❌ File not found.")
            send_telegram("❌ File not found.")
            return

        file_size_mb = message.document.size / (1024 * 1024)
        total_size = message.document.size

        bale_res = send_bale(f"📥 *{original_name}*\n0% · 0 / {file_size_mb:.1f} MB")
        bale_progress_id = bale_res["result"]["message_id"] if bale_res else None
        tg_res = send_telegram(f"📥 *{original_name}*\n0% · 0 / {file_size_mb:.1f} MB")
        tg_progress_id = tg_res["result"]["message_id"] if tg_res else None

        # Send parallel download message BEFORE starting
        send_bale(f"⚡ Parallel download ({PARALLEL_CHUNKS} streams)")
        send_telegram(f"⚡ Parallel download ({PARALLEL_CHUNKS} streams)")

        start = time.time()
        last_update = 0
        progress_dict = {'downloaded': 0}  # shared dictionary for all threads

        async def progress_loop():
            nonlocal last_update
            while progress_dict['downloaded'] < total_size:
                now = time.time()
                if now - last_update >= 8:
                    pct = progress_dict['downloaded'] / total_size * 100
                    text = f"📥 *{original_name}*\n{pct:.0f}% · {progress_dict['downloaded']//(1024*1024)} / {total_size//(1024*1024)} MB"
                    edit_bale(bale_progress_id, text)
                    edit_telegram(tg_progress_id, text)
                    last_update = now
                await asyncio.sleep(1)  # check every second

        # Start download and progress updater together
        await asyncio.gather(
            download_parallel(client, message, download_path, progress_dict, total_size),
            progress_loop()
        )

        elapsed = time.time() - start
        local_size = os.path.getsize(download_path)
        speed_mbps = (local_size / (1024*1024)) / elapsed if elapsed > 0 else 0

        final_dl = f"✅ Downloaded {local_size//(1024*1024)} MB in {elapsed:.0f}s ({speed_mbps:.1f} MB/s). Processing…"
        edit_bale(bale_progress_id, final_dl)
        edit_telegram(tg_progress_id, final_dl)

        # --- Split & upload (unchanged) ---
        if local_size <= MAX_SIZE:
            send_bale("📤 Uploading directly to Bale…")
            send_telegram("📤 Uploading directly to Bale…")
            if upload_file(download_path, original_name):
                send_bale(f"✅ *{original_name}* sent.")
                send_telegram(f"✅ *{original_name}* sent.")
            else:
                send_bale("❌ Upload failed.")
                send_telegram("❌ Upload failed.")
        else:
            send_bale(f"📦 Splitting {local_size//(1024*1024)} MB file into parts…")
            send_telegram(f"📦 Splitting {local_size//(1024*1024)} MB file into parts…")
            os.chdir(download_dir)
            base = os.path.splitext(safe_name)[0]
            subprocess.run(["zip", "-s", "15m", f"{base}.zip", safe_name], check=True)
            parts = sorted(
                [f for f in os.listdir(download_dir) if f.startswith(base) and (f.endswith('.zip') or '.z' in f)],
                key=lambda x: (not x.endswith('.zip'), x)
            )
            if not parts:
                send_bale("❌ Splitting failed.")
                send_telegram("❌ Splitting failed.")
                return
            total = len(parts)
            send_bale(f"📤 Uploading {total} parts…")
            send_telegram(f"📤 Uploading {total} parts…")
            for idx, part in enumerate(parts, 1):
                send_bale(f"⬆️ Part {idx}/{total} ({part})")
                send_telegram(f"⬆️ Part {idx}/{total} ({part})")
                part_path = os.path.join(download_dir, part)
                if not upload_file(part_path, part):
                    send_bale(f"❌ Failed to upload part {idx}. Aborting.")
                    send_telegram(f"❌ Failed to upload part {idx}. Aborting.")
                    return
                time.sleep(1)
            ext = os.path.splitext(original_name)[1] or ".file"
            final_msg = (
                f"✅ *File forwarded successfully!*\n\n"
                f"*How to open your file:*\n"
                f"1. Download all the parts (`.z01`, `.z02`... and `.zip`) into the *same folder*.\n"
                f"2. Open/Extract ONLY the final `.zip` file.\n"
                f"3. Your system will reassemble the full `{ext}` file automatically."
            )
            send_bale(final_msg)
            send_telegram(final_msg)
    except Exception as e:
        print(f"[Error] {e}")
        send_telegram(f"❌ Error: {str(e)[:200]}")
    finally:
        await client.disconnect()
        import shutil
        shutil.rmtree(download_dir, ignore_errors=True)
        unlock_queue()

asyncio.run(main())
