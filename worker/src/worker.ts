// worker/src/worker.ts
import { Hono } from 'hono';

export interface Env {
  BOT_STATE: KVNamespace;
  USER_PLANS: KVNamespace;
  BALE_BOT_TOKEN: string;
  GITHUB_TOKEN: string;
  GITHUB_REPO: string;
  BALE_PAYMENT_TOKEN: string;
  ADMIN_CHAT_ID: string;
  WORKER_SECRET: string; // Secret password for GitHub to unlock the queue
}

const app = new Hono<{ Bindings: Env }>();

async function answerCallbackSafe(env: Env, callbackId: string, text?: string, showAlert = false) {
  try {
    await callBaleApi(env, 'answerCallbackQuery', {
      callback_query_id: callbackId,
      text,
      show_alert: showAlert
    });
  } catch (e) {
    console.error('answerCallbackQuery exception:', e);
  }
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

async function triggerWorkflow(env: Env, inputs: Record<string, string>) {
  if (!env.GITHUB_REPO) throw new Error('GITHUB_REPO not defined');
  const [owner, repo] = env.GITHUB_REPO.split('/');
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/bot.yml/dispatches`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'BaleYouTubeBot/1.0'
    },
    body: JSON.stringify({ ref: 'main', inputs })
  });
  if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);
  return true;
}

function extractYouTubeId(text: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1];
  }
  return null;
}

// Authentication Check
async function hasAccess(env: Env, chatId: string | number): Promise<boolean> {
  if (env.ADMIN_CHAT_ID && chatId.toString() === env.ADMIN_CHAT_ID) return true;
  const isPremium = await env.USER_PLANS.get(`premium:${chatId}`);
  return isPremium === 'true';
}

async function processUpdate(env: Env, update: any) {
  if (update.callback_query) {
    const cb = update.callback_query;
    const cbData = cb.data;
    const chatId = cb.message?.chat?.id;
    const callbackId = cb.id;

    if (!chatId || !callbackId) return;

    if (cbData.startsWith('format|')) {
      if (!(await hasAccess(env, chatId))) {
         await answerCallbackSafe(env, callbackId, '🔒 Only premium members can download.', true);
         return;
      }

      // Check Queue Lock
      const isQueued = await env.USER_PLANS.get(`dl_queue:${chatId}`);
      if (isQueued === 'true') {
        await answerCallbackSafe(env, callbackId, '⚠️ You already have a download in progress. Please wait!', true);
        return;
      }

      const parts = cbData.split('|');
      if (parts.length < 3) return;
      
      try {
        const [, encodedUrl, encodedFormat] = parts;
        
        // Lock the queue for this user
        await env.USER_PLANS.put(`dl_queue:${chatId}`, 'true');

        await answerCallbackSafe(env, callbackId, 'Download started...');
        await callBaleApi(env, 'sendMessage', {
          chat_id: chatId,
          text: '⏳ Download queued. You will receive the file shortly.'
        });

        await triggerWorkflow(env, {
          action: 'download',
          chat_id: chatId.toString(),
          video_url: decodeURIComponent(encodedUrl),
          format_id: decodeURIComponent(encodedFormat)
        });
      } catch (e) {
        // Unlock if GitHub trigger fails
        await env.USER_PLANS.delete(`dl_queue:${chatId}`);
        await answerCallbackSafe(env, callbackId, 'Error processing request.', true);
      }
    } else if (cbData === 'check_premium') {
      const access = await hasAccess(env, chatId);
      const msg = access ? '✅ You have premium/admin access.' : '❌ No premium subscription found.';
      await answerCallbackSafe(env, callbackId, msg, true);
    }
    return;
  }

  const message = update.message;
  if (!message?.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text === '/start') {
    const welcome = `🎬 *YouTube Downloader Bot*\n\nSend me a YouTube link and I'll fetch available qualities.\n\n💎 Premium users get higher priority.\nUse /buy to upgrade.`;
    await callBaleApi(env, 'sendMessage', {
      chat_id: chatId,
      text: welcome,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '🔍 Check Premium Status', callback_data: 'check_premium' }]] }
    });
    return;
  }

  if (text === '/buy') {
    if (await hasAccess(env, chatId)) {
      await callBaleApi(env, 'sendMessage', { chat_id: chatId, text: 'You already have access!' });
      return;
    }
    const invoiceData = {
      chat_id: chatId,
      title: 'YouTube Bot Premium',
      description: '30-day premium subscription',
      payload: `premium_${chatId}`,
      provider_token: env.BALE_PAYMENT_TOKEN,
      currency: 'IRR',
      prices: [{ label: 'Premium 30 days', amount: 1500000 }],
    };
    await callBaleApi(env, 'sendInvoice', invoiceData);
    return;
  }

  // Restored /status command
  if (text === '/status') {
    const isPremium = await env.USER_PLANS.get(`premium:${chatId}`) === 'true';
    const expiry = await env.USER_PLANS.get(`expiry:${chatId}`);
    let msg = isPremium ? '✅ You have premium access.' : '❌ No premium subscription.';
    
    if (expiry) {
      msg += `\nExpires: ${new Date(parseInt(expiry) * 1000).toLocaleString()}`;
    }
    
    await callBaleApi(env, 'sendMessage', { chat_id: chatId, text: msg });
    return;
  }

  const videoId = extractYouTubeId(text);
  if (videoId) {
    if (!(await hasAccess(env, chatId))) {
        await callBaleApi(env, 'sendMessage', { chat_id: chatId, text: '🔒 Only premium members can fetch videos. Use /buy to upgrade.' });
        return;
    }
    await callBaleApi(env, 'sendMessage', { chat_id: chatId, text: '🔍 Fetching available qualities...' });
    await triggerWorkflow(env, {
      action: 'formats',
      chat_id: chatId.toString(),
      video_url: `https://youtu.be/${videoId}`
    });
    return;
  }
}

// Payment Handler with Expiry logic restored
async function handlePaymentUpdate(env: Env, update: any) {
  if (update.pre_checkout_query) {
    await callBaleApi(env, 'answerPreCheckoutQuery', { pre_checkout_query_id: update.pre_checkout_query.id, ok: true });
  }
  
  if (update.message?.successful_payment) {
    const payload = update.message.successful_payment.invoice_payload;
    if (payload?.startsWith('premium_')) {
      const userId = payload.replace('premium_', '');
      
      // Calculate 30 days from now in seconds
      const expiry = Math.floor(Date.now() / 1000) + 30 * 86400; 
      
      await env.USER_PLANS.put(`premium:${userId}`, 'true');
      await env.USER_PLANS.put(`expiry:${userId}`, expiry.toString());
      
      await callBaleApi(env, 'sendMessage', { chat_id: parseInt(userId), text: '✅ Payment successful! Your premium subscription is now active for 30 days.' });
    }
  }
}

const originalProcessUpdate = processUpdate;
processUpdate = async (env: Env, update: any) => {
  await handlePaymentUpdate(env, update);
  await originalProcessUpdate(env, update);
};

// Polling loop tightly bound to 50 seconds with a KV Lock
async function pollUpdates(env: Env) {
  const LOCK_KEY = 'POLL_LOCK';
  const now = Date.now();
  
  // 1. Check if another instance is already running
  const activeLock = await env.BOT_STATE.get(LOCK_KEY);
  if (activeLock && parseInt(activeLock) > now) {
    console.log('Another instance is polling. Aborting.');
    return;
  }
  
  // 2. Lock for 55 seconds
  await env.BOT_STATE.put(LOCK_KEY, (now + 55000).toString());

  const OFFSET_KEY = 'last_update_id';
  let offset = parseInt(await env.BOT_STATE.get(OFFSET_KEY) || '0', 10);
  const startTime = Date.now();
  const MAX_DURATION = 50000; // Run loop for exactly 50 seconds

  while (Date.now() - startTime < MAX_DURATION) {
    try {
      const url = `https://tapi.bale.ai/bot${env.BALE_BOT_TOKEN}/getUpdates`;
      const params = new URLSearchParams({ offset: offset.toString(), timeout: '3' });
      const resp = await fetch(`${url}?${params}`);
      const data = await resp.json() as any;

      if (data.ok && data.result) {
        for (const update of data.result) {
          offset = Math.max(offset, update.update_id + 1);
          await processUpdate(env, update);
        }
        await env.BOT_STATE.put(OFFSET_KEY, offset.toString());
      }
    } catch (err) {
      console.error('Polling error:', err);
    }
  }
  
  // 3. Remove lock when 50 seconds are up
  await env.BOT_STATE.delete(LOCK_KEY);
}

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(pollUpdates(env));
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    
    // Webhook for GitHub to unlock user queue
    if (url.pathname === '/github/done' && request.method === 'POST') {
      const body = await request.json() as any;
      if (body.secret === env.WORKER_SECRET && body.chat_id) {
        await env.USER_PLANS.delete(`dl_queue:${body.chat_id}`);
        return Response.json({ success: true, message: "Queue unlocked" });
      }
      return new Response('Unauthorized', { status: 401 });
    }

    if (url.pathname === '/poll' && request.method === 'GET') {
      ctx.waitUntil(pollUpdates(env));
      return Response.json({ ok: true, status: "Polling started" });
    }
    
    return new Response('Not found', { status: 404 });
  }
};
