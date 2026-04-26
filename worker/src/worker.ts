// worker/src/worker.ts
import { Hono } from 'hono';
import { searchYouTube, searchWeb, buildYtMessage } from "./search";
import { searchPapers, buildPaperMessage } from "./paper_search";

export interface Env {
  BOT_STATE: KVNamespace;
  USER_PLANS: KVNamespace;
  BALE_BOT_TOKEN: string;
  GITHUB_TOKEN: string;
  GITHUB_REPO: string;
  BALE_PAYMENT_TOKEN: string;
  ADMIN_CHAT_ID: string;
  WORKER_SECRET: string;
}

const app = new Hono<{ Bindings: Env }>();

// ------------------ HELPERS ------------------
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

async function triggerWorkflow(
  env: Env, 
  inputs: Record<string, string>
  workflowFile = "bot.yml"   // <-- new parameter with default
) {
  if (!env.GITHUB_REPO) throw new Error('GITHUB_REPO not defined');
  const [owner, repo] = env.GITHUB_REPO.split('/');
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`;
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

async function hasAccess(env: Env, chatId: string | number): Promise<boolean> {
  if (env.ADMIN_CHAT_ID && chatId.toString() === env.ADMIN_CHAT_ID) return true;
  const isPremium = await env.USER_PLANS.get(`premium:${chatId}`);
  return isPremium === 'true';
}

// ------------------ MAIN UPDATE PROCESSOR ------------------
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

      const isQueued = await env.USER_PLANS.get(`dl_queue:${chatId}`);
      if (isQueued === 'true') {
        await answerCallbackSafe(env, callbackId, '⚠️ You already have a download in progress. Please wait!', true);
        return;
      }

      const parts = cbData.split('|');
      if (parts.length < 3) return;
      
      try {
        const [, encodedUrl, encodedFormat] = parts;
        
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
        await env.USER_PLANS.delete(`dl_queue:${chatId}`);
        await answerCallbackSafe(env, callbackId, 'Error processing request.', true);
      }
      return;
    } 
    
    // ---------- Handle "Download" button ----------
    if (cbData.startsWith("ytdl|")) {
        const videoId = cbData.split("|")[1];
        await callBaleApi(env, "sendMessage", {
          chat_id: chatId,
          text: `https://youtu.be/${videoId}`,
        });
        await answerCallbackSafe(env, callbackId, "✅ Link sent for download.");
        return;
    }

    // ---------- Handle "Thumbnail" button ----------
    if (cbData.startsWith("thumb|")) {
        const videoId = cbData.split("|")[1];
        const thumbUrl = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
        await callBaleApi(env, "sendPhoto", {
          chat_id: chatId,
          photo: thumbUrl,
          caption: `Thumbnail for ${videoId}`,
        });
        await answerCallbackSafe(env, callbackId, "🖼️ Thumbnail sent.");
        return;
    }

    // ---------- Handle "Next page" button ----------
    if (cbData.startsWith("yt_next|")) {
        const nextToken = cbData.substring(8);
        const queryKey = `yt_query:${chatId}`;
        const filterKey = `yt_filter:${chatId}`;
        const originalQuery = await env.BOT_STATE.get(queryKey);
        const originalFilter = (await env.BOT_STATE.get(filterKey)) as "relevance" | "date" | null;

        if (!originalQuery) {
          await answerCallbackSafe(env, callbackId, "Search session expired.", true);
          return;
        }

        const page = await searchYouTube(
          originalQuery,
          originalFilter || "relevance",
          nextToken
        );
        const { text: messageText, keyboard } = buildYtMessage(page);

        await callBaleApi(env, "editMessageText", {
          chat_id: chatId,
          message_id: cb.message.message_id,
          text: messageText,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: keyboard },
        });
        await answerCallbackSafe(env, callbackId);
        return;
    }
      // ---------- Hybrid paper download ----------
    if (cbData.startsWith("paper|")) {
        const parts = cbData.split("|");
        if (parts.length < 3) return;
        const pdfUrl = decodeURIComponent(parts[1]);
        const title = decodeURIComponent(parts[2]);

        // Attempt direct send
        let directSuccess = false;
        try {
          const resp = await fetch(
            `https://tapi.bale.ai/bot${env.BALE_BOT_TOKEN}/sendDocument`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: chatId,
                document: pdfUrl,
                caption: title,
              }),
            }
          );
          const json = await resp.json();
          directSuccess = resp.ok && json.ok;
          if (directSuccess) {
            await answerCallbackSafe(env, callbackId, "✅ Paper sent.");
            return;
          }
          console.log("Direct send failed:", resp.status, json);
        } catch (e) {
          console.log("Direct send error:", e);
        }

        // Fallback: GitHub Actions (check queue first)
        if (!directSuccess) {
          const isQueued = await env.USER_PLANS.get(`dl_queue:${chatId}`);
          if (isQueued === "true") {
            await answerCallbackSafe(env, callbackId, "⚠️ You already have a download in progress.", true);
            return;
          }
          await env.USER_PLANS.put(`dl_queue:${chatId}`, "true");
          await answerCallbackSafe(env, callbackId, "⏳ Downloading via workflow…");
          await callBaleApi(env, "sendMessage", {
            chat_id: chatId,
            text: `📥 Large paper – processing. You'll receive the file shortly.`,
          });
          await triggerWorkflow(
            env,
            {
              chat_id: chatId.toString(),
              paper_url: pdfUrl,
              title,
            },
            "paper_download.yml"
          );
        }
        return;
    }
        
    else if (cbData === 'check_premium') {
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
    const welcome = `🎬 *Welcome to your Search & Media Bot*\n\nHere is what I can do:\n\n` +
      `📥 *YouTube Downloader*\nSend me any YouTube link directly and I'll fetch the available download qualities.\n\n` +
      `🔍 *YouTube Search*\nUse \`/ysearch <query>\` to search for videos, or \`/ysearch_latest <query>\` to find the most recently uploaded content.\n\n` +
      `🌐 *Web Search*\nUse \`/search <query>\` to perform a secure, paginated web search.\n\n` +
      `💎 *Premium Access*\nPremium users receive priority queue access. Use /buy to check options.`;

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

  // ---------- Web Search ----------
  if (text.startsWith("/search ")) {
    const query = text.slice(8).trim();
    if (query) {
      const result = await searchWeb(query);
      await callBaleApi(env, "sendMessage", {
        chat_id: chatId,
        text: result,
        parse_mode: "Markdown",
        disable_web_page_preview: true
      });
    }
    return;
  }

  // ---------- YouTube Search ----------
  if (text.startsWith("/ysearch ") || text.startsWith("/ysearch_latest ")) {
    const args = text.split(" ");
    let filter: "relevance" | "date" = "relevance";
    let queryStartIndex = 1;

    if (args[0] === "/ysearch_latest") {
      filter = "date";
      queryStartIndex = 1;
    } else if (args[1] === "latest") {
      filter = "date";
      queryStartIndex = 2;
    }

    const query = args.slice(queryStartIndex).join(" ").trim();
    if (!query) return;

    const page = await searchYouTube(query, filter);
    const { text: messageText, keyboard } = buildYtMessage(page);

    await env.BOT_STATE.put(`yt_query:${chatId}`, query, { expirationTtl: 300 });
    await env.BOT_STATE.put(`yt_filter:${chatId}`, filter, { expirationTtl: 300 });
    
    await callBaleApi(env, "sendMessage", {
      chat_id: chatId,
      text: messageText,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard },
    });
    return;
  }

  if (text.startsWith("/paper ")) {
    const query = text.slice(7).trim();
    if (!query) return;
    const papers = await searchPapers(query);
    const { text: msgText, keyboard } = buildPaperMessage(papers);
    await callBaleApi(env, "sendMessage", {
      chat_id: chatId,
      text: msgText,
      parse_mode: "Markdown",
      reply_markup: keyboard.length ? { inline_keyboard: keyboard } : undefined,
    });
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

// ------------------ PAYMENT HANDLER ------------------
async function handlePaymentUpdate(env: Env, update: any) {
  if (update.pre_checkout_query) {
    await callBaleApi(env, 'answerPreCheckoutQuery', { pre_checkout_query_id: update.pre_checkout_query.id, ok: true });
  }
  
  if (update.message?.successful_payment) {
    const payload = update.message.successful_payment.invoice_payload;
    if (payload?.startsWith('premium_')) {
      const userId = payload.replace('premium_', '');
      const expiry = Math.floor(Date.now() / 1000) + 30 * 86400; 
      
      await env.USER_PLANS.put(`premium:${userId}`, 'true');
      await env.USER_PLANS.put(`expiry:${userId}`, expiry.toString());
      
      await callBaleApi(env, 'sendMessage', { chat_id: parseInt(userId), text: '✅ Payment successful! Your premium subscription is now active for 30 days.' });
    }
  }
}

let wrappedProcessUpdate = async (env: Env, update: any) => {
  await handlePaymentUpdate(env, update);
  await processUpdate(env, update);
};

// -------------------------------------------------------
//  OPTIMIZED POLLING 
// -------------------------------------------------------
async function pollUpdates(env: Env) {
  const OFFSET_KEY = 'last_update_id';
  let offset = parseInt(await env.BOT_STATE.get(OFFSET_KEY) || '0', 10);
  
  const MAX_DURATION = 170_000;
  const startTime = Date.now();

  while (Date.now() - startTime < MAX_DURATION) {
    try {
      const url = `https://tapi.bale.ai/bot${env.BALE_BOT_TOKEN}/getUpdates`;
      const params = new URLSearchParams({ offset: offset.toString(), timeout: '6' });
      const resp = await fetch(`${url}?${params}`);
      const data = await resp.json() as any;

      if (data.ok && data.result) {
        for (const update of data.result) {
          offset = Math.max(offset, update.update_id + 1);
          await wrappedProcessUpdate(env, update);
        }
      }
    } catch (err) {
      console.error('Polling error:', err);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  await env.BOT_STATE.put(OFFSET_KEY, offset.toString());
}

// -------------------------------------------------------
//  WORKER EXPORT
// -------------------------------------------------------
export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(pollUpdates(env));
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/github/done' && request.method === 'POST') {
      const body = await request.json() as any;
      if (body.secret === env.WORKER_SECRET && body.chat_id) {
        await env.USER_PLANS.delete(`dl_queue:${body.chat_id}`);
        return Response.json({ success: true, message: "Queue unlocked" });
      }
      return new Response('Unauthorized', { status: 401 });
    }
    return new Response('Not found', { status: 404 });
  }
};
