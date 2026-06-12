import os, subprocess, time
from telethon import TelegramClient
from telethon.sessions import StringSession
import requests

# Official Telegram API credentials (public)
API_ID = 2040
API_HASH = "b18441a1ff607e10a989891a5462e627"

session_str = os.environ["TG_USER_SESSION"]
bale_token = os.environ["BALE_BOT_TOKEN"]
bale_chat = os.environ["CHAT_ID"]
channel_id = int(os.environ["CHANNEL_ID"])
message_id = int(os.environ["MESSAGE_ID"])
file_name = os.environ["FILE_NAME"]

MAX_SIZE = 15 * 1024 * 1024  # 15 MB per part

def send_message(text):
    """Send a message to the Bale user."""
    print(f"[Bale] {text}")
    requests.post(f"https://tapi.bale.ai/bot{bale_token}/sendMessage",
                  json={"chat_id": bale_chat, "text": text, "parse_mode": "Markdown"})

def upload_file(path, caption):
    """Upload a file to Bale. Returns True on success."""
    print(f"[Upload] Sending {os.path.basename(path)} ({os.path.getsize(path)//1024//1024} MB)")
    with open(path, "rb") as f:
        resp = requests.post(f"https://tapi.bale.ai/bot{bale_token}/sendDocument",
                             data={"chat_id": bale_chat, "caption": caption},
                             files={"document": f})
    if resp.ok and resp.json().get("ok"):
        print("[Upload] Success")
        return True
    else:
        print(f"[Upload] Failed: {resp.text[:200]}")
        return False

async def main():
    client = TelegramClient(StringSession(session_str), API_ID, API_HASH)
    await client.start()
    try:
        send_message("🔍 Locating your file in the channel…")
        message = await client.get_messages(channel_id, ids=message_id)
        if not message or not message.document:
            send_message("❌ File not found in channel. It may have been deleted or the ID is wrong.")
            return

        file_size_mb = message.document.size / (1024 * 1024)
        send_message(f"📥 Downloading *{file_name}* ({file_size_mb:.1f} MB) via user account…")
        print(f"[Download] Starting: {file_name} ({file_size_mb:.1f} MB)")

        path = await message.download_media(file=file_name)
        local_size = os.path.getsize(path)
        local_size_mb = local_size / (1024 * 1024)
        print(f"[Download] Finished: {local_size_mb:.1f} MB")

        if local_size <= MAX_SIZE:
            # Single file, no splitting
            send_message(f"📤 Uploading *{file_name}* directly to Bale…")
            if upload_file(path, file_name):
                # Use the original file extension in the success message
                ext = os.path.splitext(file_name)[1] or ".file"
                send_message(
                    f"✅ *File forwarded successfully!*\n\n"
                    f"📄 *{file_name}*\n"
                    f"📏 Size: {local_size_mb:.1f} MB\n"
                    f"🔽 Check the file above."
                )
            else:
                send_message("❌ Failed to upload the file to Bale. Please try again later.")
        else:
            # Large file – split into multi-part zip
            send_message(f"📦 File is large ({local_size_mb:.1f} MB) — splitting into parts…")
            base = os.path.splitext(file_name)[0]
            print(f"[Split] Creating multi-part zip for {file_name}")
            subprocess.run(["zip", "-s", "15m", f"{base}.zip", file_name], check=True)
            parts = sorted(
                [f for f in os.listdir('.') if f.startswith(base) and (f.endswith('.zip') or '.z' in f)],
                key=lambda x: (not x.endswith('.zip'), x)
            )
            total_parts = len(parts)
            print(f"[Split] Created {total_parts} parts")
            send_message(f"📤 Uploading {total_parts} parts to Bale…")

            for idx, part in enumerate(parts, 1):
                print(f"[Upload] Part {idx}/{total_parts}: {part}")
                send_message(f"⬆️ Uploading part {idx} of {total_parts} ({part})…")
                if not upload_file(part, part):
                    send_message(f"❌ Failed to upload part {idx}. Aborting.")
                    return
                time.sleep(1)

            ext = os.path.splitext(file_name)[1] or ".file"
            send_message(
                f"✅ *File forwarded successfully!*\n\n"
                f"*How to open your file:*\n"
                f"1. Download all the parts (`.z01`, `.z02`... and `.zip`) into the *same folder*.\n"
                f"2. Open/Extract ONLY the final `.zip` file.\n"
                f"3. Your system will automatically pull the pieces together to rebuild the full `{ext}` file."
            )
        os.remove(path)
    except Exception as e:
        print(f"[Error] {e}")
        send_message(f"❌ An error occurred: {str(e)[:200]}")
    finally:
        await client.disconnect()

import asyncio
asyncio.run(main())
