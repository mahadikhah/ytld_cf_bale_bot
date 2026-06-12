import os, subprocess, time, re, tempfile, asyncio
from telethon import TelegramClient
from telethon.sessions import StringSession
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

# ---------- Messaging helpers ----------
def bale_api(method, payload):
    return requests.post(f"https://tapi.bale.ai/bot{bale_token}/{method}", json=payload).json()

def telegram_api(method, payload):
    return requests.post(f"https://api.telegram.org/bot{tg_token}/{method}", json=payload).json()

def send_bale(text):
    print(f"[Bale] {text}")
    return bale_api("sendMessage", {"chat_id": bale_chat, "text": text, "parse_mode": "Markdown"})

def edit_bale(msg_id, text):
    bale_api("editMessageText", {"chat_id": bale_chat, "message_id": msg_id, "text": text, "parse_mode": "Markdown"})

def send_telegram(text):
    print(f"[Telegram] {text}")
    return telegram_api("sendMessage", {"chat_id": tg_chat, "text": text, "parse_mode": "Markdown"})

def edit_telegram(msg_id, text):
    telegram_api("editMessageText", {"chat_id": tg_chat, "message_id": msg_id, "text": text, "parse_mode": "Markdown"})

def upload_file(path, caption):
    size_mb = os.path.getsize(path) // (1024*1024)
    print(f"[Upload] Sending {os.path.basename(path)} ({size_mb} MB)")
    with open(path, "rb") as f:
        resp = requests.post(f"https://tapi.bale.ai/bot{bale_token}/sendDocument",
                             data={"chat_id": bale_chat, "caption": caption},
                             files={"document": f})
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
                          json={"secret": worker_secret, "chat_id": bale_chat},
                          timeout=5)
            print("[Unlock] Queue unlocked")
        except Exception as e:
            print(f"[Unlock] Failed: {e}")

# ---------- Main logic ----------
async def main():
    safe_name = re.sub(r'[\\/*?:"<>|]', "_", original_name)
    if len(safe_name) > 100:
        safe_name = safe_name[:50] + safe_name[-50:]

    download_dir = tempfile.mkdtemp()
    download_path = os.path.join(download_dir, safe_name)

    client = TelegramClient(
        StringSession(session_str), API_ID, API_HASH,
        connection_retries=5, retry_delay=1, request_retries=5
    )
    await client.start()

    try:
        # Locate file
        send_bale("🔍 Locating your file in the channel…")
        send_telegram("🔍 Locating your file in the channel…")

        message = await client.get_messages(channel_id, ids=message_id)
        if not message or not message.document:
            send_bale("❌ File not found in channel.")
            send_telegram("❌ File not found in channel.")
            return

        file_size_mb = message.document.size / (1024 * 1024)

        # Send initial progress messages
        bale_res = send_bale(f"📥 *{original_name}*\n0% · 0 / {file_size_mb:.1f} MB")
        bale_progress_id = bale_res["result"]["message_id"]

        tg_res = send_telegram(f"📥 *{original_name}*\n0% · 0 / {file_size_mb:.1f} MB")
        tg_progress_id = tg_res["result"]["message_id"]

        last_update = 0
        def progress_callback(received, total):
            nonlocal last_update
            now = time.time()
            if total > 0 and now - last_update >= 8:
                pct = received / total * 100
                text = f"📥 *{original_name}*\n{pct:.0f}% · {received//(1024*1024)} / {total//(1024*1024)} MB"
                edit_bale(bale_progress_id, text)
                edit_telegram(tg_progress_id, text)
                last_update = now

        start = time.time()
        # Use a larger chunk size for faster download
        await message.download_media(
            file=download_path,
            progress_callback=progress_callback,
            part_size_kb=512      # 512 KB per chunk (default is 128 KB)
        )
        elapsed = time.time() - start
        local_size = os.path.getsize(download_path)
        speed_mbps = (local_size / (1024*1024)) / elapsed if elapsed > 0 else 0

        # Final update
        final_dl = f"✅ Downloaded {local_size//(1024*1024)} MB in {elapsed:.0f}s ({speed_mbps:.1f} MB/s). Processing…"
        edit_bale(bale_progress_id, final_dl)
        edit_telegram(tg_progress_id, final_dl)

        # --- Split & upload ---
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
        send_bale(f"❌ Error: {str(e)[:200]}")
        send_telegram(f"❌ Error: {str(e)[:200]}")
    finally:
        await client.disconnect()
        import shutil
        shutil.rmtree(download_dir, ignore_errors=True)
        unlock_queue()

asyncio.run(main())
