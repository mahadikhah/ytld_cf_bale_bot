// worker/src/paper_search.ts
// ======================================
//  Scholarly paper search – arXiv API
// ======================================

const ARXIV_API = "https://export.arxiv.org/api/query";
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

// ---------- arXiv XML helpers ----------
function extractTag(parent: Element, tag: string): string {
  const el = parent.getElementsByTagName(tag)[0];
  return el?.textContent?.trim() ?? "";
}

function extractAuthors(entry: Element): string[] {
  const authorNodes = entry.getElementsByTagName("author");
  const authors: string[] = [];
  for (let i = 0; i < authorNodes.length; i++) {
    const name = extractTag(authorNodes[i], "name");
    if (name) authors.push(name);
  }
  return authors;
}

function extractYear(publishedDate: string): number | null {
  const match = publishedDate.match(/(\d{4})/);
  return match ? parseInt(match[1], 10) : null;
}

export async function searchPapers(query: string): Promise<PaperResult[]> {
  // Build arXiv API search query
  const params = new URLSearchParams({
    search_query: `all:${encodeURIComponent(query)}`,
    start: "0",
    max_results: "5",
    sortBy: "relevance",
    sortOrder: "descending",
  });
  const url = `${ARXIV_API}?${params.toString()}`;

  try {
    const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    const text = await resp.text();

    // Parse XML (Cloudflare Workers have DOMParser)
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(text, "text/xml");
    const entries = xmlDoc.getElementsByTagName("entry");

    const results: PaperResult[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const title = extractTag(entry, "title").replace(/\n\s*/g, " ");
      const id = extractTag(entry, "id"); // e.g., "http://arxiv.org/abs/2301.0001v1"
      const paperUrl = id; // abstract page
      const pdfUrl = id.replace("/abs/", "/pdf/") + ".pdf"; // direct PDF
      const authors = extractAuthors(entry);
      const published = extractTag(entry, "published"); // e.g., "2024-05-10T00:00:00Z"
      const year = extractYear(published);

      results.push({
        title: title || "Untitled",
        year,
        authors,
        url: paperUrl,
        openAccessPdf: pdfUrl,  // arXiv PDFs are always open access
      });
    }
    return results;
  } catch (e) {
    console.error("arXiv search error:", e);
    return [];
  }
}

export function buildPaperMessage(papers: PaperResult[]): {
  text: string;
  keyboard: any[][];
} {
  if (papers.length === 0) {
    return {
      text: "No scholarly articles found. Try a broader query.",
      keyboard: [],
    };
  }

  let text = "🎓 *arXiv Results:*\n\n";
  const keyboard: any[][] = [];

  papers.forEach((p, i) => {
    const idx = i + 1;
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

  return { text, keyboard };
}
