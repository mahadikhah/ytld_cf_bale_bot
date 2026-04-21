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
  const [owner, repo] = env.GITHUB_REPO.split('/');
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/bot.yml/dispatches`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
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

// ---------- Webhook Handler ----------
app.post('/webhook', async (c) => {
  const env = c.env;
  const body = await c.req.json();

  // Callback queries (inline button presses)
  if (body.callback_query) {
    const cb = body.callback_query;
    const cbData = cb.data;
    const chatId = cb.message.chat.id;
    const callbackId = cb.id;

    if (cbData.startsWith('format|')) {
      const [, videoUrl, formatId] = cbData.split('|');
      await callBaleApi(env, 'answerCallbackQuery', {
        callback_query_id: callbackId,
        text: 'Download started...'
      });
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
    } else if (cbData === 'check_premium') {
      const hasPremium = await env.USER_PLANS.get(`premium:${chatId}`) === 'true';
      await callBaleApi(env, 'answerCallbackQuery', {
        callback_query_id: callbackId,
        text: hasPremium ? '✅ You have premium access.' : '❌ No premium subscription found.',
        show_alert: true
      });
    }
    return c.json({ ok: true });
  }

  // Regular messages
  const message = body.message;
  if (!message?.text) return c.json({ ok: true });

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
    return c.json({ ok: true });
  }

  if (text === '/buy') {
    const isPremium = await env.USER_PLANS.get(`premium:${chatId}`) === 'true';
    if (isPremium) {
      await callBaleApi(env, 'sendMessage', {
        chat_id: chatId,
        text: 'You already have an active premium subscription!'
      });
      return c.json({ ok: true });
    }

    const invoiceResp = await fetch('https://api.bale.ai/payment/v1/invoice', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.BALE_PAYMENT_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        amount: 1500000, // Rials
        description: 'YouTube Bot Premium (30 days)',
        callback_url: `https://${c.req.header('host')}/payment/callback?user_id=${chatId}`,
        payer_name: `TelegramUser${chatId}`,
      })
    });
    if (!invoiceResp.ok) {
      await callBaleApi(env, 'sendMessage', {
        chat_id: chatId,
        text: '❌ Payment service unavailable. Please try later.'
      });
      return c.json({ ok: true });
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
    return c.json({ ok: true });
  }

  if (text === '/status') {
    const isPremium = await env.USER_PLANS.get(`premium:${chatId}`) === 'true';
    const expiry = await env.USER_PLANS.get(`expiry:${chatId}`);
    let msg = isPremium ? '✅ You have premium access.' : '❌ No premium subscription.';
    if (expiry) {
      msg += `\nExpires: ${new Date(parseInt(expiry) * 1000).toLocaleString()}`;
    }
    await callBaleApi(env, 'sendMessage', { chat_id: chatId, text: msg });
    return c.json({ ok: true });
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
    return c.json({ ok: true });
  }

  await callBaleApi(env, 'sendMessage', {
    chat_id: chatId,
    text: 'Please send a valid YouTube URL.'
  });
  return c.json({ ok: true });
});

// ---------- Payment Callback ----------
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

export default app;
