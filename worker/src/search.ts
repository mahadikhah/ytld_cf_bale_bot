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
        console.error("YouTube API failed with status:", resp.status);
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

    return { results, nextToken };
  } catch (error) {
    console.error("fetchYtPage error:", error);
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
//  WEB SEARCH – Details & Pagination
// ============================================

export function buildWebMessage(pageData: WebPage, currentPage: number): { text: string, keyboard: any[][] } {
  let text = `🔍 *Web Search Results (Page ${currentPage})*\n\n`;
  const keyboard: any[][] = [];

  if (pageData.results.length === 0) {
      text += "⚠️ No results found.";
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

const SEARX_INSTANCES = [
  "https://searx.be",
  "https://search.sapti.me",
  "https://searx.work",
  "https://paulgo.io",
  "https://search.mdosch.de",
];

async function trySearXNG(query: string, page: number): Promise<WebPage | null> {
  for (const base of SEARX_INSTANCES) {
    try {
      const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&pageno=${page}`;
      const resp = await fetch(url, { headers: { "User-Agent": BROWSER_USER_AGENT } });
      if (!resp.ok) continue;

      const contentType = resp.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) continue;
      
      const json: any = await resp.json();
      const items = json.results ?? [];
      
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
    } catch (e) {
      // Move to next instance
    }
  }
  return null;
}

async function tryBingSearch(query: string, page: number): Promise<WebPage | null> {
  try {
    const first = (page - 1) * 10 + 1;
    const resp = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&first=${first}`, {
      headers: { "User-Agent": BROWSER_USER_AGENT, "Accept-Language": "en-US,en;q=0.9" }
    });
    const html = await resp.text();
    
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
    
    if (results.length > 0) {
       return { results, hasNext: results.length >= 8 };
    }
  } catch (e) {
    console.log("Bing Scraper error:", e);
  }
  return null;
}

export async function searchWeb(query: string, page: number = 1): Promise<WebPage> {
  // Try SearXNG Public rotation first for easiest JSON & snippets
  const searxResult = await trySearXNG(query, page);
  if (searxResult && searxResult.results.length > 0) return searxResult;

  // Fallback to Bing scraper
  const bingResult = await tryBingSearch(query, page);
  if (bingResult && bingResult.results.length > 0) return bingResult;

  return { results: [], hasNext: false };
}
