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

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebPage {
  results: WebResult[];
  hasNext: boolean;
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
  console.log(`[YouTube] Fetching query: '${query}', token: ${!!continuationToken}`);
  
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

  if (continuationToken) {
    body.continuation = continuationToken;
  } else {
    body.query = query;
    if (filter === "date") {
      body.params = "CAI%3D"; 
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
        console.error(`[YouTube] API failed with status: ${resp.status}`);
        return { results: [], nextToken: null };
    }

    const data = await resp.json() as any;
    let items: any[] = [];
    let nextToken: string | null = null;

    if (continuationToken) {
      const actions = data.onResponseReceivedCommands || [];
      for (const action of actions) {
        const contItems = action.appendContinuationItemsAction?.continuationItems || [];
        for (const item of contItems) {
            if (item.itemSectionRenderer?.contents) {
                items.push(...item.itemSectionRenderer.contents);
                const token = item.itemSectionRenderer.continuations?.[0]?.nextContinuationData?.continuation;
                if (token) nextToken = token;
            } else if (item.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
                nextToken = item.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
            }
        }
      }
    } else {
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
    
    console.log(`[YouTube] Found ${results.length} results. Has Next: ${!!nextToken}`);
    return { results, nextToken };
  } catch (error) {
    console.error("[YouTube] fetchYtPage error:", error);
    return { results: [], nextToken: null };
  }
}

// ============================================
//  buildYtMessage
// ============================================
export function buildYtMessage(page: YtPage, pageId: string): { text: string; keyboard: any[][] } {
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

  if (pageId && page.nextToken) {
    keyboard.push([{ text: "Next Page ➡️", callback_data: `yt_next|${pageId}` }]);
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
//  WEB SEARCH – Details, Pagination & Logs
// ============================================

export function buildWebMessage(pageData: WebPage, currentPage: number): { text: string, keyboard: any[][] } {
  let text = `🔍 *Web Search Results (Page ${currentPage})*\n\n`;
  const keyboard: any[][] = [];

  if (pageData.results.length === 0) {
      text += "⚠️ No results found. Check worker logs if this persists.";
      return { text, keyboard };
  }

  pageData.results.forEach((r, i) => {
      const idx = (currentPage - 1) * 10 + i + 1;
      text += `${idx}\\. 🌐 *[${escapeMarkdown(r.title)}](${r.url})*\n`;
      if (r.snippet) {
          const snippetStr = r.snippet.length > 200 ? r.snippet.substring(0, 200) + "..." : r.snippet;
          text += `_${escapeMarkdown(snippetStr)}_\n`;
      }
      text += "\n";
  });

  const navRow = [];
  if (currentPage > 1) {
      navRow.push({ text: "⬅️ Prev", callback_data: `web_next|${currentPage - 1}` });
  }
  if (pageData.hasNext) {
      navRow.push({ text: "Next ➡️", callback_data: `web_next|${currentPage + 1}` });
  }
  if (navRow.length > 0) keyboard.push(navRow);

  return { text, keyboard };
}

// Strategy 1: DuckDuckGo HTML POST (Extremely reliable for Page 1, hard to block)
async function tryDuckDuckGoHTMLPost(query: string): Promise<WebPage | null> {
    console.log(`[WebSearch: DDG] Attempting HTML POST for: ${query}`);
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
      console.log(`[WebSearch: DDG] Response length: ${html.length} bytes`);
      
      const results: WebResult[] = [];
      const resultRegex = /<div class="result__body">.*?<h2 class="result__title">.*?<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>.*?<a class="result__snippet[^>]*>(.*?)<\/a>/gis;
      
      let match;
      while ((match = resultRegex.exec(html)) !== null) {
        let link = match[1];
        if (link.includes("uddg=")) {
          const urlMatch = link.match(/uddg=([^&]+)/);
          if (urlMatch) link = decodeURIComponent(urlMatch[1]);
        } else if (link.startsWith("//")) {
           link = "https:" + link;
        }
        
        const title = match[2].replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "").trim();
        const snippet = match[3].replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "").trim();
        
        results.push({ title, url: link, snippet });
        if (results.length >= 10) break;
      }
      
      console.log(`[WebSearch: DDG] Found ${results.length} results.`);
      if (results.length > 0) {
        return { results, hasNext: true }; // Assume true for DDG fallback to engine 2 for page 2
      }
    } catch(e) {
      console.error("[WebSearch: DDG] HTML POST error:", e);
    }
    return null;
}

// Strategy 2: SearXNG instances
const SEARX_INSTANCES = [
  "https://searx.be",
  "https://search.sapti.me",
  "https://searx.work",
  "https://paulgo.io",
  "https://search.mdosch.de",
];

async function trySearXNG(query: string, page: number): Promise<WebPage | null> {
  console.log(`[WebSearch: SearXNG] Starting search for page ${page}`);
  for (const base of SEARX_INSTANCES) {
    try {
      const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&pageno=${page}`;
      console.log(`[WebSearch: SearXNG] Trying instance: ${base}`);
      
      const resp = await fetch(url, { headers: { "User-Agent": BROWSER_USER_AGENT } });
      if (!resp.ok) {
          console.log(`[WebSearch: SearXNG] ${base} returned status ${resp.status}`);
          continue;
      }

      const contentType = resp.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
          console.log(`[WebSearch: SearXNG] ${base} returned non-JSON (likely Captcha or block)`);
          continue;
      }
      
      const json: any = await resp.json();
      const items = json.results ?? [];
      console.log(`[WebSearch: SearXNG] ${base} returned ${items.length} items`);
      
      if (items.length > 0) {
        const results: WebResult[] = [];
        for (const r of items) {
          if (!r.url || !r.title) continue;
          results.push({
              title: r.title,
              url: r.url,
              snippet: r.content || r.snippet || ""
          });
          if (results.length >= 10) break;
        }
        return { results, hasNext: items.length >= 8 };
      }
    } catch (e: any) {
      console.error(`[WebSearch: SearXNG] Instance ${base} threw error:`, e.message);
    }
  }
  return null;
}

// Strategy 3: Bing Scraper 
async function tryBingSearch(query: string, page: number): Promise<WebPage | null> {
  console.log(`[WebSearch: Bing] Starting search for page ${page}`);
  try {
    const first = (page - 1) * 10 + 1;
    const resp = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&first=${first}`, {
      headers: { "User-Agent": BROWSER_USER_AGENT, "Accept-Language": "en-US,en;q=0.9" }
    });
    const html = await resp.text();
    console.log(`[WebSearch: Bing] HTML response size: ${html.length} bytes`);
    
    const results: WebResult[] = [];
    const liRegex = /<li class="b_algo"(.*?)<\/li>/gis;
    let liMatch;
    
    while ((liMatch = liRegex.exec(html)) !== null) {
      const liHtml = liMatch[1];
      const titleMatch = liHtml.match(/<h2><a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a><\/h2>/i);
      if (!titleMatch) continue;
      
      const link = titleMatch[1];
      const title = titleMatch[2].replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "").trim();
      
      let snippet = "";
      const snipMatch = liHtml.match(/<div class="b_caption">(.*?)<\/div>/is) || liHtml.match(/<p[^>]*>(.*?)<\/p>/is);
      if (snipMatch) {
         snippet = snipMatch[1].replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "").trim();
      }

      if (link.startsWith("http") && !link.includes("microsoft.com")) {
        results.push({ title, url: link, snippet });
      }
      if (results.length >= 10) break;
    }
    
    console.log(`[WebSearch: Bing] Parsed ${results.length} valid results`);
    if (results.length > 0) {
       return { results, hasNext: results.length >= 8 };
    } else {
        console.log("[WebSearch: Bing] Found 0 results. Bing might be serving a captcha.");
    }
  } catch (e: any) {
    console.error("[WebSearch: Bing] Scraper threw error:", e.message);
  }
  return null;
}

export async function searchWeb(query: string, page: number = 1): Promise<WebPage> {
  console.log(`\n--- NEW WEB SEARCH REQUEST: '${query}' | PAGE: ${page} ---`);

  // Try DuckDuckGo first for initial queries (highest reliability on CF Workers)
  if (page === 1) {
      const ddgResult = await tryDuckDuckGoHTMLPost(query);
      if (ddgResult && ddgResult.results.length > 0) {
          console.log("[WebSearch] Fulfilled by DuckDuckGo HTML");
          return ddgResult;
      }
  }

  // Fallback 1: SearXNG Instances (Better for pages > 1 because they handle JSON pagination cleanly)
  const searxResult = await trySearXNG(query, page);
  if (searxResult && searxResult.results.length > 0) {
      console.log("[WebSearch] Fulfilled by SearXNG");
      return searxResult;
  }

  // Fallback 2: Bing Scraper
  const bingResult = await tryBingSearch(query, page);
  if (bingResult && bingResult.results.length > 0) {
      console.log("[WebSearch] Fulfilled by Bing");
      return bingResult;
  }

  console.warn(`[WebSearch] All engines failed for query '${query}' on page ${page}`);
  return { results: [], hasNext: false };
}
