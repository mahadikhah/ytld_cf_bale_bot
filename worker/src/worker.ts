// worker/src/worker.ts - Polling with loop, immediate callback answers, and correct payment API
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
    console.log('answerCallbackQuery response:', JSON.stringify(result));
  } catch (e) {
    console.error('answerCallbackQuery exception:', e);
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
  const data = await resp.json();
  if (!resp.ok) {
    console.error(`Bale API error (${method}):`, resp.status, data);
  }
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
  if (!resp.ok) {
    const err = await resp.text();
    console.error('GitHub workflow trigger failed:', resp.status, err);
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

    if (!chatId || !callbackId) {
      console.error('Invalid callback_query: missing chatId or callbackId', cb);
      return;
    }

    if (!cbData || typeof cbData !== 'string') {
      console.warn('Callback data missing or not string');
      await answerCallbackSafe(env, callbackId, 'Invalid button.');
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

        // Answer immediately to avoid timeout
        await answerCallbackSafe(env, callbackId, 'Download started...');
        await callBaleApi(env, 'sendMessage', {
          chat_id: chatId,
          text: '⏳ Download queued. You will receive the file shortly.'
        });

        // Trigger workflow (this can take a bit)
        await triggerWorkflow(env, {
          action: 'download',
          chat_id: chatId.toString(),
          video_url: videoUrl,
          format_id: formatId
        });
      } catch (e) {
        console.error('Callback processing error:', e);
        await answerCallbackSafe(env, callbackId, 'Error processing request.', true);
      }
    } else if (cbData === 'check_premium') {
      console.log(`Premium check for chat ${chatId}`);
      if (!env.USER_PLANS) {
        console.error('USER_PLANS binding missing');
        await answerCallbackSafe(env, callbackId, 'Service temporarily unavailable.', true);
        return;
      }
      const hasPremium = await env.USER_PLANS.get(`premium:${chatId}`);
      const msg = hasPremium === 'true' ? '✅ You have premium access.' : '❌ No premium subscription found.';
      await answerCallbackSafe(env, callbackId, msg, true);
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

    if (!env.BALE_PAYMENT_TOKEN) {
      console.error('BALE_PAYMENT_TOKEN missing');
      await callBaleApi(env, 'sendMessage', {
        chat_id: chatId,
        text: '❌ Payment service not configured.'
      });
      return;
    }

    // Use the correct sendInvoice endpoint (bot API, not separate payment API)
    const invoiceData = {
      chat_id: chatId,
      title: 'YouTube Bot Premium',
      description: '30-day premium subscription',
      payload: `premium_${chatId}`,
      provider_token: env.BALE_PAYMENT_TOKEN,
      currency: 'IRR',
      prices: [{ label: 'Premium 30 days', amount: 1500000 }], // amount in Rials
    };

    const invoiceResp = await callBaleApi(env, 'sendInvoice', invoiceData);

    if (!invoiceResp.ok) {
      console.error('Bale invoice creation failed:', invoiceResp);
      await callBaleApi(env, 'sendMessage', {
        chat_id: chatId,
        text: `❌ Payment service temporarily unavailable. Please try later.`
      });
      return;
    }
    // sendInvoice returns the sent message on success, no need to send another message
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

// ---------- Polling Function with Fast Loop ----------
async function pollUpdates(env: Env) {
  if (!env.BOT_STATE) {
    console.error('BOT_STATE undefined');
    return;
  }
  const OFFSET_KEY = 'last_update_id';
  let offset = parseInt(await env.BOT_STATE.get(OFFSET_KEY) || '0', 10);

  // Loop up to 5 times to process pending updates quickly
  for (let i = 0; i < 20; i++) {
    const url = `https://tapi.bale.ai/bot${env.BALE_BOT_TOKEN}/getUpdates`;
    const params = new URLSearchParams({
      offset: offset.toString(),
      timeout: '2' // shorter timeout for faster loops
    });

    try {
      const resp = await fetch(`${url}?${params}`, { headers: { 'Content-Type': 'application/json' } });
      const data = await resp.json() as any;

      if (!data.ok) {
        console.error('getUpdates error:', data);
        break;
      }

      const updates = data.result || [];
      console.log(`Loop ${i+1}: Received ${updates.length} updates`);
      if (updates.length === 0) break; // no more updates

      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        try {
          await processUpdate(env, update);
        } catch (err) {
          console.error('Error processing update:', err, JSON.stringify(update));
        }
      }

      await env.BOT_STATE.put(OFFSET_KEY, offset.toString());

      // Short delay between loops
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (err) {
      console.error('Polling error:', err);
      break;
    }
  }
}

// ---------- Payment Callback (Handles successful payment updates) ----------
// This handler processes the 'pre_checkout_query' and 'successful_payment' updates.
// It's integrated into the main polling loop, so no separate HTTP endpoint is needed for verification.
async function handlePaymentUpdate(env: Env, update: any) {
  if (update.pre_checkout_query) {
    const query = update.pre_checkout_query;
    // Always answer true to proceed with payment
    await callBaleApi(env, 'answerPreCheckoutQuery', {
      pre_checkout_query_id: query.id,
      ok: true
    });
    console.log(`Answered pre_checkout_query for user ${query.from.id}`);
  }

  if (update.message?.successful_payment) {
    const payment = update.message.successful_payment;
    const chatId = update.message.chat.id;
    const payload = payment.invoice_payload; // e.g., "premium_123456"

    if (payload && payload.startsWith('premium_')) {
      const userId = payload.replace('premium_', '');
      const expiry = Math.floor(Date.now() / 1000) + 30 * 86400;
      await env.USER_PLANS.put(`premium:${userId}`, 'true');
      await env.USER_PLANS.put(`expiry:${userId}`, expiry.toString());

      await callBaleApi(env, 'sendMessage', {
        chat_id: parseInt(userId),
        text: '✅ Payment successful! Your premium subscription is now active for 30 days.'
      });
    }
  }
}

// Modify the main processUpdate to call handlePaymentUpdate
const originalProcessUpdate = processUpdate;
processUpdate = async (env: Env, update: any) => {
  await handlePaymentUpdate(env, update);
  await originalProcessUpdate(env, update);
};

// ---------- Export Handlers ----------
export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await pollUpdates(env);
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/poll' && request.method === 'GET') {
      await pollUpdates(env);
      return Response.json({ ok: true });
    }
    return new Response('Not found', { status: 404 });
  }
};
