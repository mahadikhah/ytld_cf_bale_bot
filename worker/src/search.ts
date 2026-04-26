// worker/src/search.ts

/**
 * Minimal Markdown escaping – prevents breaking link syntax
 * and unintentional bold/italic.
 */
function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/~/g, '\\~')
    .replace(/`/g, '\\`');
}

export async function searchYouTube(query: string): Promise<string> {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Bot/1.0)' },
  });
  const html = await res.text();

  const match = html.match(/var ytInitialData\s*=\s*({.*?});\s*<\/script>/s);
  if (!match) {
    console.log('YT search: could not find ytInitialData');
    return '❌ Could not read YouTube response.';
  }

  let data: any;
  try {
    data = JSON.parse(match[1]);
  } catch (e) {
    console.log('YT search: failed to parse JSON', e);
    return '❌ Failed to parse YouTube search results.';
  }

  const contents =
    data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
      ?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents;
  if (!contents) {
    console.log('YT search: no contents array');
    return 'No video results found.';
  }

  let output = '';
  let count = 0;
  const results = [];

  for (const item of contents) {
    const vr = item.videoRenderer;
    if (!vr) continue;

    const titleRaw = vr.title?.runs?.[0]?.text || 'Untitled';
    const videoId = vr.videoId;
    const thumb = vr.thumbnail?.thumbnails?.[0]?.url;

    if (!videoId) continue;

    const title = escapeMarkdown(titleRaw);
    const watchLink = `https://youtu.be/${videoId}`;
    const thumbLink = thumb ? `[🖼️ Thumb](${thumb})` : '';

    output += `🎵 *${title}*\n[▶️ Watch](${watchLink})`;
    if (thumbLink) output += ` | ${thumbLink}`;
    output += '\n\n';

    results.push({ title: titleRaw, videoId, thumb });
    count++;
    if (count >= 5) break;
  }

  console.log('YSearch results:', JSON.stringify(results.slice(0, 3)));
  if (!output) return 'No video results found.';
  return '🎬 *YouTube results:*\n\n' + output;
}

export async function searchWeb(query: string): Promise<string> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Bot/1.0)' },
  });
  const html = await res.text();

  const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi;
  let match;
  let count = 0;
  let output = '';
  const results = [];

  while ((match = resultRegex.exec(html)) !== null) {
    let rawLink = match[1];
    const rawTitle = match[2].replace(/<[^>]+>/g, '').trim();

    if (!rawLink.startsWith('http')) {
      rawLink = 'https:' + rawLink;
    }

    const title = escapeMarkdown(rawTitle);
    output += `🌐 [${title}](${rawLink})\n\n`;
    results.push({ title: rawTitle, url: rawLink });
    count++;
    if (count >= 5) break;
  }

  console.log('Web search results:', JSON.stringify(results.slice(0, 3)));
  if (!output) return 'No web results found.';
  return '*Web results:*\n\n' + output;
}
