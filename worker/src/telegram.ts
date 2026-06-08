// worker/src/telegram.ts
import { Env } from './worker';
import { triggerWorkflow } from './utils';

export async function processTelegramUpdate(env: Env, update: any) {
  const msg = update.message || update.channel_post;
  if (!msg) return;

  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  // Handle linking code from Bale
  if (text && text.startsWith('/start ')) {
    const code = text.split(' ')[1];
    if (code) {
      const baleChatId = await env.USER_PLANS.get(`link_code:${code}`);
      if (baleChatId) {
        await env.USER_PLANS.put(`tg_to_bale:${chatId}`, baleChatId);
        await env.USER_PLANS.delete(`link_code:${code}`);
        await sendTelegramMessage(env, chatId, '✅ Your Telegram account has been linked to Bale! You can now forward messages.');
      } else {
        await sendTelegramMessage(env, chatId, '❌ Invalid or expired link code. Use /link in your Bale bot to get a new one.');
      }
    }
    return;
  }

  // Check if user is linked
  const baleChatId = await env.USER_PLANS.get(`tg_to_bale:${chatId}`);
  if (!baleChatId) {
    await sendTelegramMessage(env, chatId, '⚠️ You are not linked to Bale yet. Get a link code from the Bale bot using /link and then send it here as: /start <code>');
    return;
  }

  // Forward text messages
  if (text && !text.startsWith('/')) {
    const sender = msg.from?.first_name || msg.from?.username || 'Telegram';
    const forwarded = `📩 *${sender}* (from Telegram):\n${escapeMarkdown(text)}`;
    await callBaleApi(env, 'sendMessage', {
      chat_id: baleChatId,
      text: forwarded,
      parse_mode: 'Markdown',
    });
    return;
  }

  // Process files
  const fileId = msg.document?.file_id || msg.video?.file_id || msg.audio?.file_id || msg.voice?.file_id || msg.photo?.slice(-1)[0]?.file_id;
  if (!fileId) return;

  const fileType = msg.document ? 'document' : msg.video ? 'video' : msg.audio ? 'audio' : msg.voice ? 'voice' : 'photo';
  const fileName = msg.document?.file_name || msg.video?.file_name || msg.audio?.file_name || `${fileType}_${msg.message_id}.jpg`;
  const fileSize = msg.document?.file_size || msg.video?.file_size || msg.audio?.file_size || msg.voice?.file_size || msg.photo?.slice(-1)[0]?.file_size || 0;

  // Get file path from Telegram
  const fileInfo = await getTelegramFile(env, fileId);
  if (!fileInfo || !fileInfo.file_path) {
    await sendTelegramMessage(env, chatId, '❌ Failed to fetch file info.');
    return;
  }

  const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
  const caption = msg.caption ? `📩 *${msg.from?.first_name || 'Telegram'}*:\n${escapeMarkdown(msg.caption)}` : undefined;

  if (fileSize > 0 && fileSize <= 15 * 1024 * 1024) {
    // Download and send directly to Bale
    try {
      const fileResp = await fetch(fileUrl);
      if (!fileResp.ok) throw new Error('Download failed');
      const arrayBuf = await fileResp.arrayBuffer();
      const form = new FormData();
      form.append('chat_id', baleChatId);
      if (caption) form.append('caption', caption);
      form.append(fileType, new File([arrayBuf], fileName));
      
      const method = fileType === 'photo' ? 'sendPhoto' : fileType === 'voice' ? 'sendVoice' : 'sendDocument';
      const baleResp = await fetch(`https://tapi.bale.ai/bot${env.BALE_BOT_TOKEN}/${method}`, {
        method: 'POST',
        body: form,
      });
      if (baleResp.ok) {
        await sendTelegramMessage(env, chatId, '✅ Forwarded to Bale.');
      } else {
        throw new Error(await baleResp.text());
      }
    } catch (e) {
      console.error('Direct send failed:', e);
      await sendTelegramMessage(env, chatId, '❌ Failed to send file. Trying alternative method...');
      await triggerTelegramTransfer(env, baleChatId, fileUrl, fileName);
    }
  } else {
    // Large file – dispatch workflow
    await sendTelegramMessage(env, chatId, '📦 File is large, processing via workflow...');
    await triggerTelegramTransfer(env, baleChatId, fileUrl, fileName);
  }
}

async function getTelegramFile(env: Env, fileId: string): Promise<{ file_path?: string } | null> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const data: any = await resp.json();
  return data?.result;
}

async function sendTelegramMessage(env: Env, chatId: number | string, text: string) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function triggerTelegramTransfer(env: Env, baleChatId: string, fileUrl: string, fileName: string) {
  await triggerWorkflow(env, {
    action: 'telegram_transfer',
    bale_chat_id: baleChatId,
    file_url: fileUrl,
    file_name: fileName,
  }, 'telegram_transfer.yml');
}

async function callBaleApi(env: Env, method: string, body: any) {
  const url = `https://tapi.bale.ai/bot${env.BALE_BOT_TOKEN}/${method}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await resp.json();
  if (!resp.ok) console.error(`Bale API error (${method}):`, resp.status, data);
  return data;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_\[\]()~`>#+\-=|{}.!]/g, '\\$&');
}
