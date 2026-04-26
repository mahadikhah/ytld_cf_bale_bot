// worker/src/search.ts

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Search YouTube and return formatted HTML text.
 * Up to 5 results with watch link and thumbnail link.
 */
export async function searchYouTube(query: string): Promise<string> {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Bot/1.0)' },
  });
  const html = await res.text();

  // Extract ytInitialData JSON
  const match = html.match(/var ytInitialData\s*=\s*({.*?});\s*<\/script>/s);
  if (!match) return '❌ Could not read YouTube response.';

  let data: any;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return '❌ Failed to parse YouTube search results.';
  }

  const contents =
    data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
      ?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents;
  if (!contents) return 'No video results found.';

  let output = '';
  let count = 0;
  for (const item of contents) {
    const vr = item.videoRenderer;
    if (!vr) continue;

    const title = vr.title?.runs?.[0]?.text || 'Untitled';
    const videoId = vr.videoId;
    const thumb = vr.thumbnail?.thumbnails?.[0]?.url;

    if (!videoId) continue;

    output += `<b>${escapeHtml(title)}</b>\n<a href="https://youtu.be/${videoId}">▶️ Watch</a>`;
    if (thumb) {
      output += ` | <a href="${thumb}">🖼️ Thumb</a>`;
    }
    output += '\n\n';

    count++;
    if (count >= 5) break;
  }

  if (!output) return 'No video results found.';
  return '🎬 <b>YouTube results:</b>\n\n' + output;
}

/**
 * Search the web via DuckDuckGo (no API key).
 * Up to 5 results with page title and link.
 */
export async function searchWeb(query: string): Promise<string> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Bot/1.0)' },
  });
  const html = await res.text();

  // Extract results from DuckDuckGo’s HTML version
  const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi;
  let match;
  let count = 0;
  let output = '';

  while ((match = resultRegex.exec(html)) !== null) {
    let rawLink = match[1];
    const rawTitle = match[2];

    // Clean title
    const title = rawTitle.replace(/<[^>]+>/g, '').trim();
    // Sometimes links are relative
    if (!rawLink.startsWith('http')) {
      rawLink = 'https:' + rawLink;
    }

    output += `<b>${escapeHtml(title)}</b>\n<a href="${rawLink}">${rawLink}</a>\n\n`;
    count++;
    if (count >= 5) break;
  }

  if (!output) return '🌐 No web results found.';
  return '<b>Web results:</b>\n\n' + output;
}
