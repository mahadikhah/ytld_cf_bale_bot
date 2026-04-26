// worker/src/search.ts
// ---------------------------------
//  YOUTUBE & WEB SEARCH UTILITIES
// ---------------------------------

const YT_MAX_RESULTS = 10;   // videos per page
const YT_USER_AGENT = "Mozilla/5.0 (compatible; BaleYouTubeBot/1.0)";

// ------------------ Markdown escaping ------------------
function escapeMarkdown(text: string): string {
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

// ------------------ YouTube result types ------------------
export interface YtResult {
  title: string;
  videoId: string;
  duration: string;
  published: string;
  thumb: string;
}

export interface YtPage {
  results: YtResult[];
  nextToken: string | null;
}

// ------------------------------------------------------------
//  fetchYtPage – initial search & continuation
// ------------------------------------------------------------
export async function fetchYtPage(
  query: string,
  filter: "relevance" | "date",
  continuationToken?: string
): Promise<YtPage> {
  let url: string;

  if (continuationToken) {
    // Continuation endpoint (browse_ajax) – returns raw JSON
    url = `https://www.youtube.com/browse_ajax?ctoken=${encodeURIComponent(
      continuationToken
    )}`;
  } else {
    // Initial search
    const params = new URLSearchParams({ search_query: query });
    if (filter === "date") {
      // sp=CAI%253D sorts by upload date
      params.set("sp", "CAI%253D");
    }
    url = `https://www.youtube.com/results?${params.toString()}`;
  }

  const resp = await fetch(url, {
    headers: { "User-Agent": YT_USER_AGENT },
  });
  const text = await resp.text();

  let data: any;
  if (continuationToken) {
    // browse_ajax returns JSON wrapped in <script>? Actually plain JSON.
    // Try to parse directly; sometimes it's padded with a character.
    try {
      data = JSON.parse(text);
    } catch {
      // fallback: try to extract JSON from the page (in case it's inside <script>)
      const jsonMatch = text.match(/\{.*\}/s);
      if (!jsonMatch) {
        console.log("YT continuation: no JSON");
        return { results: [], nextToken: null };
      }
      data = JSON.parse(jsonMatch[0]);
    }
  } else {
    // Initial – extract ytInitialData from script
    const match = text.match(
      /var ytInitialData\s*=\s*(\{.*?\});\s*<\/script>/s
    );
    if (!match) {
      console.log("YT search: ytInitialData missing");
      return { results: [], nextToken: null };
    }
    data = JSON.parse(match[1]);
  }

  // Navigate to the list of items (handles both initial & continuation structures)
  let items: any[] = [];
  let nextToken: string | null = null;

  if (continuationToken) {
    // Response from browse_ajax: { ... continuationContents: { ... } }
    const cont = data?.continuationContents?.itemSectionContinuation;
    if (cont) {
      items = cont.contents ?? [];
      nextToken = cont.continuations?.[0]?.nextContinuationData?.continuation ?? null;
    } else {
      // sometimes in data directly
      items = data?.contents ?? [];
      if (!nextToken) {
        nextToken =
          data?.continuations?.[0]?.nextContinuationData?.continuation ?? null;
      }
    }
  } else {
    const primary =
      data?.contents?.twoColumnSearchResultsRenderer?.primaryContents;
    const sectionList = primary?.sectionListRenderer?.contents?.[0];
    if (sectionList?.itemSectionRenderer) {
      items = sectionList.itemSectionRenderer.contents ?? [];
    }
    // continuation token is usually at the end of the itemSectionRenderer after the videos
    if (!nextToken) {
      const last = items[items.length - 1];
      if (last?.continuationItemRenderer) {
        nextToken =
          last.continuationItemRenderer.continuationEndpoint
            ?.continuationCommand?.token;
      }
    }
  }

  const results: YtResult[] = [];
  for (const item of items) {
    const vr = item.videoRenderer;
    if (!vr) continue;
    const videoId = vr.videoId;
    if (!videoId) continue;

    // Title
    const titleRaw = vr.title?.runs?.[0]?.text || "Untitled";

    // Duration
    let duration = "";
    if (vr.lengthText?.simpleText) {
      duration = vr.lengthText.simpleText;
    } else if (vr.lengthText?.accessibility?.accessibilityData?.label) {
      duration = vr.lengthText.accessibility.accessibilityData.label
        .replace(/^.*?: /, "")
        .trim();
    }

    // Published
    let published = "";
    if (vr.publishedTimeText?.simpleText) {
      published = vr.publishedTimeText.simpleText;
    }

    // Thumbnail – highest quality, fallback to hqdefault
    let thumb = "";
    if (vr.thumbnail?.thumbnails?.length) {
      thumb = vr.thumbnail.thumbnails[vr.thumbnail.thumbnails.length - 1].url;
    }
    if (!thumb) {
      thumb = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`; // fallback
    }

    results.push({ title: titleRaw, videoId, duration, published, thumb });

    if (results.length >= YT_MAX_RESULTS) break;
  }

  console.log(
    `YT search page (${filter}, cont: ${!!continuationToken}):`,
    results.map((r) => r.title).slice(0, 3),
    "nextToken exists:",
    !!nextToken
  );

  return { results, nextToken };
}

// ------------------------------------------------------------
//  buildYtMessage – Markdown + inline keyboard for results
// ------------------------------------------------------------
export function buildYtMessage(page: YtPage): {
  text: string;
  keyboard: any[][];
} {
  let text = "🎬 *YouTube results:*\n\n";
  const keyboard: any[][] = [];

  if (page.results.length === 0) {
    text = "No more video results.";
    return { text, keyboard };
  }

  page.results.forEach((r, i) => {
    const idx = i + 1;
    const title = escapeMarkdown(r.title);
    const details: string[] = [];
    if (r.published) details.push(`📅 ${r.published}`);
    if (r.duration) details.push(`⏱ ${r.duration}`);

    text += `${idx}\\. *${title}*\n`;
    if (details.length) text += `_${details.join(" | ")}_\n`;
    text += "\n";

    keyboard.push([
      {
        text: `▶️ ${idx}. Download`,
        callback_data: `ytdl|${r.videoId}`,
      },
      {
        text: `🖼️ Thumb`,
        callback_data: `thumb|${r.videoId}`,
      },
    ]);
  });

  if (page.nextToken) {
    keyboard.push([
      {
        text: "Next ➡️",
        callback_data: `yt_next|${page.nextToken}`,
      },
    ]);
  }

  return { text, keyboard };
}

// Convenience export for the main worker
export async function searchYouTube(
  query: string,
  filter: "relevance" | "date" = "relevance",
  nextToken?: string
): Promise<YtPage> {
  return fetchYtPage(query, filter, nextToken);
}

// ------------------------------------------------------------
//  Web search (DuckDuckGo Lite + fallback)
// ------------------------------------------------------------
export async function searchWeb(query: string): Promise<string> {
  // Strategy 1 – DuckDuckGo Lite
  const liteUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  let resp: Response;
  try {
    resp = await fetch(liteUrl, {
      headers: { "User-Agent": YT_USER_AGENT },
    });
    const liteHtml = await resp.text();

    // Regex for lite results: <a class="result-link" href="...">Title</a>
    const liteRegex =
      /<a[^>]*class="result-link"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi;
    const liteMatches = [...liteHtml.matchAll(liteRegex)];

    if (liteMatches.length > 0) {
      console.log("Web search (lite) found", liteMatches.length, "results");
      let output = "*Web results:*\n\n";
      let count = 0;
      for (const m of liteMatches) {
        const rawLink = m[1];
        const rawTitle = m[2].replace(/<[^>]+>/g, "").trim();
        const link = rawLink.startsWith("http") ? rawLink : "https:" + rawLink;
        output += `🌐 [${escapeMarkdown(rawTitle)}](${link})\n\n`;
        count++;
        if (count >= 5) break;
      }
      return output;
    }
    console.log("Web search (lite) returned 0 results, trying HTML fallback...");
  } catch (e) {
    console.log("Web search (lite) fetch error:", e);
  }

  // Strategy 2 – DuckDuckGo HTML (non-JS)
  const htmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    resp = await fetch(htmlUrl, {
      headers: { "User-Agent": YT_USER_AGENT },
    });
    const html = await resp.text();

    // Regex for old HTML: <a class="result__a" href="...">Title</a>
    const htmlRegex =
      /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi;
    const htmlMatches = [...html.matchAll(htmlRegex)];

    if (htmlMatches.length > 0) {
      console.log("Web search (HTML) found", htmlMatches.length, "results");
      let output = "*Web results:*\n\n";
      let count = 0;
      for (const m of htmlMatches) {
        const rawLink = m[1];
        const rawTitle = m[2].replace(/<[^>]+>/g, "").trim();
        const link = rawLink.startsWith("http") ? rawLink : "https:" + rawLink;
        output += `🌐 [${escapeMarkdown(rawTitle)}](${link})\n\n`;
        count++;
        if (count >= 5) break;
      }
      return output;
    }
    console.log("Web search (HTML) returned 0 results.");
  } catch (e) {
    console.log("Web search (HTML) fetch error:", e);
  }

  // Strategy 3 – SearXNG public instance (no API key, may be slow/unstable)
  try {
    const searxUrl = `https://search.sapti.me/search?q=${encodeURIComponent(query)}&format=json`;
    resp = await fetch(searxUrl, {
      headers: { "User-Agent": YT_USER_AGENT },
    });
    const json = await resp.json();
    const results = json.results ?? [];
    if (results.length > 0) {
      console.log("Web search (searx) found", results.length, "results");
      let output = "*Web results:*\n\n";
      let count = 0;
      for (const r of results) {
        if (!r.url || !r.title) continue;
        output += `🌐 [${escapeMarkdown(r.title)}](${r.url})\n\n`;
        count++;
        if (count >= 5) break;
      }
      return output;
    }
  } catch (e) {
    console.log("Web search (searx) error:", e);
  }

  return "No web results found.";
}
