import os, subprocess, time, re, tempfile, asyncio
from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.tl.types import InputDocumentFileLocation
import requests
from bot_utils import format_progress_bar, BaleMessenger, TelegramMessenger, unlock_queue

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
worker_url = os.environ.get("WORKER_URL")
worker_secret = os.environ.get("WORKER_SECRET")

MAX_SIZE = 15 * 1024 * 1024
PARALLEL_CHUNKS = 8
CHUNK_SIZE = 10 * 1024 * 1024

# ---------- Messengers ----------
bale = BaleMessenger(bale_token, bale_chat)
telegram = TelegramMessenger(tg_token, tg_chat)

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

# ---------- Parallel download (unchanged) ----------
async def download_chunk(client, location, offset, size, part_num, progress_dict):
    part_file = f"part_{part_num}"
    with open(part_file, 'wb') as f:
        async for chunk in client.iter_download(location, offset=offset, request_size=1024*1024):
            f.write(chunk)
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
    chunks = []
    offset = 0
    while offset < total:
        size = min(CHUNK_SIZE, total - offset)
        chunks.append((offset, size))
        offset += size

    print(f"[Download] {len(chunks)} chunks, {PARALLEL_CHUNKS} parallel")
    for batch_start in range(0, len(chunks), PARALLEL_CHUNKS):
        batch = chunks[batch_start:batch_start+PARALLEL_CHUNKS]
        tasks = [
            download_chunk(client, location, off, sz, batch_start + i, progress_dict)
            for i, (off, sz) in enumerate(batch)
        ]
        await asyncio.gather(*tasks)

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
        bale.send("🔍 Locating your file in the channel…")
        telegram.send("🔍 Locating your file in the channel…")

        message = await client.get_messages(channel_id, ids=message_id)
        if not message or not message.document:
            bale.send("❌ File not found.")
            telegram.send("❌ File not found.")
            return

        total_size = message.document.size

        # Initial progress bar
        init_msg = format_progress_bar(original_name, 0, total_size)
        bale_res = bale.send(init_msg)
        bale_progress_id = bale_res["result"]["message_id"] if bale_res else None
        tg_res = telegram.send(init_msg)
        tg_progress_id = tg_res["result"]["message_id"] if tg_res else None

        bale.send(f"⚡ Parallel download ({PARALLEL_CHUNKS} streams)")
        telegram.send(f"⚡ Parallel download ({PARALLEL_CHUNKS} streams)")

        start = time.time()
        last_update = 0
        progress_dict = {'downloaded': 0}

        async def progress_loop():
            nonlocal last_update
            while progress_dict['downloaded'] < total_size:
                now = time.time()
                if now - last_update >= 5:
                    bar_text = format_progress_bar(original_name, progress_dict['downloaded'], total_size)
                    bale.edit(bale_progress_id, bar_text)
                    telegram.edit(tg_progress_id, bar_text)
                    last_update = now
                await asyncio.sleep(1)

        await asyncio.gather(
            download_parallel(client, message, download_path, progress_dict, total_size),
            progress_loop()
        )

        elapsed = time.time() - start
        local_size = os.path.getsize(download_path)
        speed_mbps = (local_size / (1024*1024)) / elapsed if elapsed > 0 else 0

        final_dl = f"✅ Downloaded {local_size//(1024*1024)} MB in {elapsed:.0f}s ({speed_mbps:.1f} MB/s). Processing…"
        bale.edit(bale_progress_id, final_dl)
        telegram.edit(tg_progress_id, final_dl)

        # --- Split & upload ---
        if local_size <= MAX_SIZE:
            if DELIVERY_METHOD == "s3":
                bale.send("☁️ Uploading to cloud…")
                url = upload_to_s3(download_path, safe_name)
                if url:
                    bale.send(f"✅ *Download link (valid 2 h):*\n{url}")
                    telegram.send(f"✅ *Download link:*\n{url}")
                else:
                    bale.send("❌ Cloud upload failed.")
                    telegram.send("❌ Cloud upload failed.")
            else:
                bale.send("📤 Uploading directly to Bale…")
                telegram.send("📤 Uploading directly to Bale…")
                if upload_file(download_path, original_name):
                    bale.send(f"✅ *{original_name}* sent.")
                    telegram.send(f"✅ *{original_name}* sent.")
                else:
                    bale.send("❌ Upload failed.")
                    telegram.send("❌ Upload failed.")
        else:
            # Use a distinct name for the split archive to avoid collision with source file
            base = os.path.splitext(safe_name)[0]
            split_zip_base = f"{base}_split.zip"

            if DELIVERY_METHOD == "s3":
                # For S3 we can upload the whole file without splitting
                bale.send(f"☁️ Uploading {local_size//(1024*1024)} MB to cloud…")
                telegram.send(f"☁️ Uploading {local_size//(1024*1024)} MB to cloud…")
                url = upload_to_s3(download_path, safe_name)
                if url:
                    bale.send(f"✅ *Download link (valid 2 h):*\n{url}")
                    telegram.send(f"✅ *Download link:*\n{url}")
                else:
                    bale.send("❌ Cloud upload failed.")
                    telegram.send("❌ Cloud upload failed.")
            else:
                bale.send(f"📦 Splitting {local_size//(1024*1024)} MB file into parts…")
                telegram.send(f"📦 Splitting {local_size//(1024*1024)} MB file into parts…")
                os.chdir(download_dir)
                # Important: use --out and a different name
                subprocess.run(
                    ["zip", "-s", "15m", split_zip_base, safe_name, "--out", split_zip_base],
                    check=True
                )

                # Collect split parts (avoid matching the source file)
                parts = sorted(
                    [f for f in os.listdir(download_dir)
                     if f.startswith(base + "_split") and (f.endswith('.zip') or '.z' in f)],
                    key=lambda x: (not x.endswith('.zip'), x)
                )
                if not parts:
                    bale.send("❌ Splitting failed.")
                    telegram.send("❌ Splitting failed.")
                    return

                total = len(parts)
                bale.send(f"📤 Uploading {total} parts…")
                telegram.send(f"📤 Uploading {total} parts…")
                for idx, part in enumerate(parts, 1):
                    bale.send(f"⬆️ Part {idx}/{total} ({part})")
                    telegram.send(f"⬆️ Part {idx}/{total} ({part})")
                    part_path = os.path.join(download_dir, part)
                    if not upload_file(part_path, part):
                        bale.send(f"❌ Failed to upload part {idx}. Aborting.")
                        telegram.send(f"❌ Failed to upload part {idx}. Aborting.")
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
                bale.send(final_msg)
                telegram.send(final_msg)

    except Exception as e:
        print(f"[Error] {e}")
        telegram.send(f"❌ Error: {str(e)[:200]}")
    finally:
        await client.disconnect()
        import shutil
        shutil.rmtree(download_dir, ignore_errors=True)
        unlock_queue(worker_url, worker_secret, bale_chat)

asyncio.run(main())
