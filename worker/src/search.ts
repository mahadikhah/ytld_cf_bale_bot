// worker/src/search.ts
// ======================================
//  YOUTUBE & WEB SEARCH – NO API KEYS
// ======================================

const YT_MAX_RESULTS = 10;
const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36";

// ---------------- Markdown escaping ----------------
function escapeMarkdown(text: string): string {
  if (!text) return "";
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/~/g, "\\~")
    .replace(/`/g, "\\`");
}

// ---------------- Types ----------------
export interface YtResult {
  title: string;
  videoId: string;
  duration: string;
  published: string;
  thumb: string;
  channel: string;
}

export interface YtPage {
  results: YtResult[];
  nextToken: string | null;
}

// ============================================
//  fetchYtPage – using Internal Innertube API
// ============================================
export async function fetchYtPage(
  query: string,
  filter: "relevance" | "date",
  continuationToken?: string
): Promise<YtPage> {
  const url = "https://www.youtube.com/youtubei/v1/search?prettyPrint=false";
  
  // YouTube Web Client Context
  const body: any = {
    context: {
      client: {
        clientName: "WEB",
        clientVersion: "2.20240105.01.00",
        hl: "en",
        gl: "US"
      }
    }
  };

  // Configure payload for Initial Query vs Pagination Continuation
  if (continuationToken) {
    body.continuation = continuationToken;
  } else {
    body.query = query;
    if (filter === "date") {
      body.params = "CAI%3D"; // Standard Innertube base64 filter param for "Upload Date"
    }
  }

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": BROWSER_USER_AGENT
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
        console.error("YouTube API failed with status:", resp.status);
        return { results: [], nextToken: null };
    }

    const data = await resp.json() as any;
    let items: any[] = [];
    let nextToken: string | null = null;

    // ----- Extract Continuation JSON properly -----
    if (continuationToken) {
      const actions = data.onResponseReceivedCommands || [];
      for (const action of actions) {
        const contItems = action.appendContinuationItemsAction?.continuationItems || [];
        for (const item of contItems) {
            // Find Video Results
            if (item.itemSectionRenderer?.contents) {
                items.push(...item.itemSectionRenderer.contents);
                const token = item.itemSectionRenderer.continuations?.[0]?.nextContinuationData?.continuation;
                if (token) nextToken = token;
            } 
            // Find Pagination Token
            else if (item.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
                nextToken = item.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
            }
        }
      }
    } else {
    // ----- Extract Initial Page JSON properly -----
      const primary = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer;
      if (primary) {
        for (const content of primary.contents || []) {
          if (content.itemSectionRenderer?.contents) {
            items.push(...content.itemSectionRenderer.contents);
          }
        }
        nextToken = primary.continuations?.[0]?.nextContinuationData?.continuation || null;
      }
    }

    // ----- Build Results -----
    const results: YtResult[] = [];
    for (const item of items) {
      const vr = item.videoRenderer;
      if (!vr || !vr.videoId) continue;

      const videoId = vr.videoId;
      const titleRaw = vr.title?.runs?.[0]?.text || "Untitled";

      let duration = "";
      if (vr.lengthText?.simpleText) {
        duration = vr.lengthText.simpleText;
      } else if (vr.lengthText?.accessibility?.accessibilityData?.label) {
        duration = vr.lengthText.accessibility.accessibilityData.label.replace(/^.*?: /, "").trim();
      }

      let published = vr.publishedTimeText?.simpleText || "";
      let channel = vr.ownerText?.runs?.[0]?.text || vr.shortBylineText?.runs?.[0]?.text || "";
      
      const thumbs = vr.thumbnail?.thumbnails;
      const thumb = (thumbs && thumbs.length > 0) ? thumbs[thumbs.length - 1].url : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

      results.push({
        title: titleRaw,
        videoId,
        duration,
        published,
        thumb,
        channel,
      });

      if (results.length >= YT_MAX_RESULTS) break;
    }

    return { results, nextToken };
  } catch (error) {
    console.error("fetchYtPage error:", error);
    return { results: [], nextToken: null };
  }
}

// ============================================
//  buildYtMessage
// ============================================
export function buildYtMessage(page: YtPage): { text: string; keyboard: any[][] } {
  let text = "🎬 *YouTube results:*\n\n";
  const keyboard: any[][] = [];

  if (page.results.length === 0) {
    text = "⚠️ No more video results found.";
    return { text, keyboard };
  }

  page.results.forEach((r, i) => {
    const idx = i + 1;
    const title = escapeMarkdown(r.title);
    const details: string[] = [];
    if (r.channel) details.push(`👤 ${escapeMarkdown(r.channel)}`);
    if (r.published) details.push(`📅 ${r.published}`);
    if (r.duration) details.push(`⏱ ${r.duration}`);

    text += `${idx}\\. *${title}*\n`;
    if (details.length) text += `_${details.join(" | ")}_\n`;
    text += "\n";

    keyboard.push([
      { text: `▶️ ${idx}. Download`, callback_data: `ytdl|${r.videoId}` },
      { text: `🖼️ Thumb`, callback_data: `thumb|${r.videoId}` },
    ]);
  });

  if (page.nextToken) {
    keyboard.push([{ text: "Next Page ➡️", callback_data: `yt_next|${page.nextToken}` }]);
  }

  return { text, keyboard };
}

export async function searchYouTube(
  query: string,
  filter: "relevance" | "date" = "relevance",
  nextToken?: string
): Promise<YtPage> {
  return fetchYtPage(query, filter, nextToken);
}

// ============================================
//  WEB SEARCH – Multi-Layered Fallback System
// ============================================

// Strategy 1: DuckDuckGo HTML POST (Bypasses Cloudflare block easily)
async function tryDuckDuckGoHTMLPost(query: string): Promise<string | null> {
    try {
      const resp = await fetch("https://html.duckduckgo.com/html/", {
        method: "POST",
        headers: {
          "User-Agent": BROWSER_USER_AGENT,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: `q=${encodeURIComponent(query)}&b=`
      });
      const html = await resp.text();
      
      const regex = /<h2 class="result__title">\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi;
      let match;
      const results: {title: string, url: string}[] = [];
      
      while ((match = regex.exec(html)) !== null) {
        let link = match[1];
        // Decode DDG secure redirects
        if (link.includes("uddg=")) {
          const urlMatch = link.match(/uddg=([^&]+)/);
          if (urlMatch) link = decodeURIComponent(urlMatch[1]);
        } else if (link.startsWith("//")) {
           link = "https:" + link;
        }
        
        const title = match[2].replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "").trim();
        results.push({ title, url: link });
        if (results.length >= 6) break;
      }
      
      if (results.length > 0) {
        let output = "*Web results (DuckDuckGo):*\n\n";
        results.forEach(r => { output += `🌐 [${escapeMarkdown(r.title)}](${r.url})\n\n`; });
        return output;
      }
    } catch(e) {
      console.log("DDG HTML POST error:", e);
    }
    return null;
}

// Strategy 2: Bing Scraper (Very lenient towards Workers)
async function tryBingSearch(query: string): Promise<string | null> {
    try {
      const resp = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, {
        headers: { "User-Agent": BROWSER_USER_AGENT }
      });
      const html = await resp.text();
      
      const regex = /<h2><a href="([^"]+)"[^>]*>(.*?)<\/a><\/h2>/gi;
      let match;
      const results: {title: string, url: string}[] = [];
      
      while ((match = regex.exec(html)) !== null) {
        const link = match[1];
        // Filter out internal Microsoft UI links
        if (link.startsWith("http") && !link.includes("microsoft.com")) {
          const title = match[2].replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "").trim();
          results.push({ title, url: link });
          if (results.length >= 6) break;
        }
      }
      
      if (results.length > 0) {
        let output = "*Web results (Bing):*\n\n";
        results.forEach(r => { output += `🌐 [${escapeMarkdown(r.title)}](${r.url})\n\n`; });
        return output;
      }
    } catch (e) {
      console.log("Bing Scraper error:", e);
    }
    return null;
}

// Strategy 3: SearXNG Array (Updated List)
const SEARX_INSTANCES = [
  "https://searx.be",
  "https://search.sapti.me",
  "https://searx.work",
  "https://paulgo.io",
  "https://search.mdosch.de",
];

async function trySearXNG(query: string): Promise<string | null> {
  for (const base of SEARX_INSTANCES) {
    try {
      const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
      const resp = await fetch(url, {
        headers: { "User-Agent": BROWSER_USER_AGENT },
      });
      if (!resp.ok) continue;

      const contentType = resp.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) continue;
      
      const json: any = await resp.json();
      const results = json.results ?? [];
      
      if (results.length > 0) {
        let output = "*Web results (SearXNG):*\n\n";
        let count = 0;
        for (const r of results) {
          if (!r.url || !r.title) continue;
          output += `🌐 [${escapeMarkdown(r.title)}](${r.url})\n\n`;
          count++;
          if (count >= 6) break;
        }
        return output;
      }
    } catch (e) {
      // Instance failed, move to next
    }
  }
  return null;
}

// ----------------------------------------------------
// Main Web Search Exporter
// ----------------------------------------------------
export async function searchWeb(query: string): Promise<string> {
    
  // 1. Try DuckDuckGo Post (High Success Rate)
  const ddgResult = await tryDuckDuckGoHTMLPost(query);
  if (ddgResult) return ddgResult;

  // 2. Try Bing (High Success Rate)
  const bingResult = await tryBingSearch(query);
  if (bingResult) return bingResult;

  // 3. Try SearXNG Public rotation
  const searxResult = await trySearXNG(query);
  if (searxResult) return searxResult;

  return "⚠️ No web results found. The search engines might be temporarily blocking our requests.";
}
