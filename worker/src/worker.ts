// worker/src/worker.ts - Polling version with User-Agent and premium debug
import { Hono } from 'hono';

export interface Env {
  BOT_STATE: KVNamespace;
  USER_PLANS: KVNamespace;
  BALE_BOT_TOKEN: string;
  GITHUB_TOKEN: string;
  GITHUB_REPO: string;
  BALE_PAYMENT_TOKEN: string;
}

const app = new Hono<{ Bindings: Env }>();

async function answerCallbackSafe(env: Env, callbackId: string, text?: string, showAlert = false) {
  try {
    const result = await callBaleApi(env, 'answerCallbackQuery', {
      callback_query_id: callbackId,
      text,
      show_alert: showAlert
    });
    console.log('answerCallbackQuery response:', result);
  } catch (e) {
    console.warn('answerCallbackQuery failed:', e);
  }
}

// ---------- Helpers ----------
async function callBaleApi(env: Env, method: string, body: any) {
  const url = `https://tapi.bale.ai/bot${env.BALE_BOT_TOKEN}/${method}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return resp.json();
}

async function triggerWorkflow(env: Env, inputs: Record<string, string>) {
  if (!env.GITHUB_REPO || typeof env.GITHUB_REPO !== 'string') {
    throw new Error('GITHUB_REPO is not defined');
  }
  const [owner, repo] = env.GITHUB_REPO.split('/');
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/bot.yml/dispatches`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'BaleYouTubeBot/1.0'   // <-- Required to avoid 403
    },
    body: JSON.stringify({ ref: 'main', inputs })
  });
  if (!resp.ok) {
    const err = await resp.text();
    console.error('Failed to trigger workflow:', resp.status, err);
    throw new Error(`GitHub API error: ${resp.status}`);
  }
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

// ---------- Core Update Processor ----------
async function processUpdate(env: Env, update: any) {
  console.log('Processing update:', JSON.stringify(update, null, 2));

  if (update.callback_query) {
    const cb = update.callback_query;
    const cbData = cb.data;
    const chatId = cb.message?.chat?.id;
    const callbackId = cb.id;

    console.log(`Callback data type: ${typeof cbData}, value: ${cbData}`);

    if (!chatId || !callbackId) {
      console.error('Invalid callback_query: missing chatId or callbackId', cb);
      return;
    }

    if (!cbData || typeof cbData !== 'string') {
      console.warn('Callback query missing "data" field or not a string');
      await answerCallbackSafe(env, callbackId, 'This button has no action.');
      return;
    }

    if (cbData.startsWith('format|')) {
      const parts = cbData.split('|');
      if (parts.length < 3) {
        await answerCallbackSafe(env, callbackId, 'Invalid format selection.', true);
        return;
      }
      try {
        const [, encodedUrl, encodedFormat] = parts;
        const videoUrl = decodeURIComponent(encodedUrl);
        const formatId = decodeURIComponent(encodedFormat);

        await answerCallbackSafe(env, callbackId, 'Download started...');
        await triggerWorkflow(env, {
          action: 'download',
          chat_id: chatId.toString(),
          video_url: videoUrl,
          format_id: formatId
        });
        await callBaleApi(env, 'sendMessage', {
          chat_id: chatId,
          text: '⏳ Download queued. You will receive the file shortly.'
        });
      } catch (e) {
        console.error('Callback processing error:', e);
        await answerCallbackSafe(env, callbackId, 'Error processing request.', true);
      }
    } else if (cbData === 'check_premium') {
      // --- Premium check with logging ---
      console.log(`Checking premium for chat ${chatId}`);
      if (!env.USER_PLANS) {
        console.error('USER_PLANS KV binding is undefined!');
        await answerCallbackSafe(env, callbackId, 'Service temporarily unavailable.', true);
        return;
      }
      const hasPremium = await env.USER_PLANS.get(`premium:${chatId}`);
      console.log(`Premium status for ${chatId}: ${hasPremium}`);
      await answerCallbackSafe(env, callbackId,
        hasPremium === 'true' ? '✅ You have premium access.' : '❌ No premium subscription found.',
        true
      );
    } else {
      await answerCallbackSafe(env, callbackId, 'Unknown action.');
    }
    return;
  }

  // Handle messages
  const message = update.message;
  if (!message?.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text === '/start') {
    const welcome = `🎬 *YouTube Downloader Bot*\n\nSend me a YouTube link and I'll fetch available qualities.\n\n💎 Premium users get higher priority.\nUse /buy to upgrade.`;
    const keyboard = {
      inline_keyboard: [[{ text: '🔍 Check Premium Status', callback_data: 'check_premium' }]]
    };
    await callBaleApi(env, 'sendMessage', {
      chat_id: chatId,
      text: welcome,
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
    return;
  }

  if (text === '/buy') {
    const isPremium = await env.USER_PLANS.get(`premium:${chatId}`) === 'true';
    if (isPremium) {
      await callBaleApi(env, 'sendMessage', {
        chat_id: chatId,
        text: 'You already have an active premium subscription!'
      });
      return;
    }

    const invoiceResp = await fetch('https://api.bale.ai/payment/v1/invoice', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.BALE_PAYMENT_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        amount: 1500000,
        description: 'YouTube Bot Premium (30 days)',
        callback_url: `https://${env.GITHUB_REPO.split('/')[0]}.workers.dev/payment/callback?user_id=${chatId}`,
        payer_name: `TelegramUser${chatId}`,
      })
    });
    if (!invoiceResp.ok) {
      await callBaleApi(env, 'sendMessage', {
        chat_id: chatId,
        text: '❌ Payment service unavailable. Please try later.'
      });
      return;
    }
    const invoiceData = await invoiceResp.json() as any;
    const paymentUrl = invoiceData.payment_url;
    const trackId = invoiceData.track_id;

    await env.BOT_STATE.put(`payment:${trackId}`, chatId.toString(), { expirationTtl: 3600 });

    const payKeyboard = {
      inline_keyboard: [[{ text: '💳 Pay 150,000 Toman', url: paymentUrl }]]
    };
    await callBaleApi(env, 'sendMessage', {
      chat_id: chatId,
      text: 'Click below to complete payment. After payment, use /status to check activation.',
      reply_markup: payKeyboard
    });
    return;
  }

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
    const videoUrl = `https://youtu.be/${videoId}`;
    await triggerWorkflow(env, {
      action: 'formats',
      chat_id: chatId.toString(),
      video_url: videoUrl
    });
    await callBaleApi(env, 'sendMessage', {
      chat_id: chatId,
      text: '🔍 Fetching available qualities...'
    });
    return;
  }

  await callBaleApi(env, 'sendMessage', {
    chat_id: chatId,
    text: 'Please send a valid YouTube URL.'
  });
}

// ---------- Polling Function (Cron Trigger) ----------
async function pollUpdates(env: Env) {
  if (!env.BOT_STATE) {
    console.error('pollUpdates: BOT_STATE is undefined');
    return;
  }
  const OFFSET_KEY = 'last_update_id';
  let offset = parseInt(await env.BOT_STATE.get(OFFSET_KEY) || '0', 10);

  const url = `https://tapi.bale.ai/bot${env.BALE_BOT_TOKEN}/getUpdates`;
  const params = new URLSearchParams({
    offset: offset.toString(),
    timeout: '30'
  });

  try {
    const resp = await fetch(`${url}?${params}`, {
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await resp.json() as any;

    if (!data.ok) {
      console.error('getUpdates error:', data);
      return;
    }

    const updates = data.result || [];
    console.log(`Received ${updates.length} updates`);
    for (const update of updates) {
      offset = Math.max(offset, update.update_id + 1);
      try {
        await processUpdate(env, update);
      } catch (err) {
        console.error('Error processing update:', err, 'Update:', JSON.stringify(update));
      }
    }

    if (updates.length > 0) {
      await env.BOT_STATE.put(OFFSET_KEY, offset.toString());
    }
  } catch (err) {
    console.error('Polling error:', err);
  }
}

// ---------- Payment Callback (HTTP) ----------
app.get('/payment/callback', async (c) => {
  const env = c.env;
  const userId = c.req.query('user_id');
  const trackId = c.req.query('track_id');
  if (!userId || !trackId) return c.text('Missing parameters', 400);

  const verifyResp = await fetch(`https://api.bale.ai/payment/v1/verify/${trackId}`, {
    headers: { 'Authorization': `Bearer ${env.BALE_PAYMENT_TOKEN}` }
  });
  if (!verifyResp.ok) return c.text('Verification failed', 400);
  const paymentData = await verifyResp.json() as any;
  if (paymentData.status !== 'PAID') {
    return c.text('Payment not completed', 200);
  }

  const expiry = Math.floor(Date.now() / 1000) + 30 * 86400;
  await env.USER_PLANS.put(`premium:${userId}`, 'true');
  await env.USER_PLANS.put(`expiry:${userId}`, expiry.toString());

  await callBaleApi(env, 'sendMessage', {
    chat_id: parseInt(userId),
    text: '✅ Payment successful! Your premium subscription is now active for 30 days.'
  });

  return c.text('OK');
});

// ---------- Export Handlers ----------
export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await pollUpdates(env);
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/payment/callback') {
      return app.fetch(request, env, ctx);
    }
    if (url.pathname === '/poll' && request.method === 'GET') {
      await pollUpdates(env);
      return Response.json({ ok: true });
    }
    return new Response('Not found', { status: 404 });
  }
};
