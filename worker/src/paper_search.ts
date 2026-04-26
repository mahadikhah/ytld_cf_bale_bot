// worker/src/paper_search.ts
// ======================================
//  Scholarly paper search – arXiv API
//  with pagination
// ======================================

const ARXIV_API = "https://export.arxiv.org/api/query";
const MAX_RESULTS_PER_PAGE = 10;
const USER_AGENT = "Mozilla/5.0 (compatible; BaleYouTubeBot/1.0)";

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

export interface PaperResult {
  title: string;
  year: number | null;
  authors: string[];
  url: string;           // abstract page
  openAccessPdf: string | null;  // direct PDF
}

export interface SearchResponse {
  papers: PaperResult[];
  totalResults: number;
  startIndex: number;
}

// ---------- Regex helpers ----------
function extractText(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, "s");
  const match = xml.match(regex);
  return match ? match[1].trim().replace(/\n\s+/g, " ") : "";
}

function extractAuthorNames(entryXml: string): string[] {
  const authorRegex = /<author>([\s\S]*?)<\/author>/g;
  const names: string[] = [];
  let match;
  while ((match = authorRegex.exec(entryXml)) !== null) {
    const name = extractText(match[1], "name");
    if (name) names.push(name);
  }
  return names;
}

function extractYear(published: string): number | null {
  const match = published.match(/(\d{4})/);
  return match ? parseInt(match[1], 10) : null;
}

export async function searchPapers(
  query: string,
  start = 0
): Promise<SearchResponse> {
  const params = new URLSearchParams({
    search_query: query,
    start: start.toString(),
    max_results: MAX_RESULTS_PER_PAGE.toString(),
    sortBy: "relevance",
    sortOrder: "descending",
  });
  const url = `${ARXIV_API}?${params.toString()}`;

  try {
    const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    const xml = await resp.text();

    // Total results
    const totalResultsStr = extractText(xml, "opensearch:totalResults");
    const totalResults = parseInt(totalResultsStr, 10) || 0;

    // Extract entries
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    const papers: PaperResult[] = [];
    let entryMatch;

    while ((entryMatch = entryRegex.exec(xml)) !== null) {
      const entryXml = entryMatch[1];

      const title = extractText(entryXml, "title");
      const id = extractText(entryXml, "id");
      const published = extractText(entryXml, "published");
      const authors = extractAuthorNames(entryXml);
      const year = extractYear(published);
      const pdfUrl = id ? id.replace("/abs/", "/pdf/") + ".pdf" : null;

      papers.push({
        title: title || "Untitled",
        year,
        authors,
        url: id,
        openAccessPdf: pdfUrl,
      });

      if (papers.length >= MAX_RESULTS_PER_PAGE) break;
    }

    return { papers, totalResults, startIndex: start };
  } catch (e) {
    console.error("arXiv search error:", e);
    return { papers: [], totalResults: 0, startIndex: start };
  }
}

export function buildPaperMessage(
  response: SearchResponse,
  originalQuery: string
): { text: string; keyboard: any[][] } {
  const { papers, totalResults, startIndex } = response;

  if (papers.length === 0) {
    return {
      text: "No scholarly articles found. Try a broader query.",
      keyboard: [],
    };
  }

  let text = "🎓 *arXiv Results:*\n\n";
  const keyboard: any[][] = [];

  papers.forEach((p, i) => {
    const idx = startIndex + i + 1; // global index
    const title = escapeMarkdown(p.title);
    const yearStr = p.year ? ` (${p.year})` : "";
    const authorsStr = p.authors.join(", ");
    const hasPdf = !!p.openAccessPdf;

    text += `${idx}\\. *${title}*${yearStr}\n`;
    text += `👤 ${escapeMarkdown(authorsStr)}\n`;
    text += `🔗 [Abstract](${p.url})\n`;
    if (!hasPdf) text += `_(No PDF available)_\n`;
    text += "\n";

    if (p.openAccessPdf) {
      keyboard.push([
        {
          text: `📥 ${idx}. Download PDF`,
          callback_data: `paper|${encodeURIComponent(p.openAccessPdf)}|${encodeURIComponent(p.title)}`,
        },
      ]);
    }
  });

  // Pagination – "Next" button if more results remain
  const nextStart = startIndex + papers.length;
  if (nextStart < totalResults) {
    keyboard.push([
      {
        text: "Next ➡️",
        callback_data: `paper_next|${encodeURIComponent(originalQuery)}|${nextStart}`,
      },
    ]);
  }

  // Show progress info
  text += `_Showing ${startIndex + 1}–${nextStart} of ${totalResults} results_`;

  return { text, keyboard };
}
