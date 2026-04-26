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

// ------------------------------------------------------------
//  Regex helpers for arXiv Atom XML
// ------------------------------------------------------------
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

export async function searchPapers(query: string): Promise<PaperResult[]> {
  // arXiv API – search all fields by default
  const params = new URLSearchParams({
    search_query: query,          // plain text; arXiv searches all fields
    start: "0",
    max_results: "5",
    sortBy: "relevance",
    sortOrder: "descending",
  });
  const url = `${ARXIV_API}?${params.toString()}`;

  try {
    const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    const xml = await resp.text();

    // Extract <entry> blocks with regex
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    const results: PaperResult[] = [];
    let entryMatch;

    while ((entryMatch = entryRegex.exec(xml)) !== null) {
      const entryXml = entryMatch[1];

      const title = extractText(entryXml, "title");
      const id = extractText(entryXml, "id");             // e.g., http://arxiv.org/abs/2301.1234
      const published = extractText(entryXml, "published"); // e.g., 2023-01-05T00:00:00Z
      const authors = extractAuthorNames(entryXml);
      const year = extractYear(published);

      // PDF link – replace /abs/ with /pdf/ (arXiv PDFs are always open)
      const pdfUrl = id ? id.replace("/abs/", "/pdf/") + ".pdf" : null;

      results.push({
        title: title || "Untitled",
        year,
        authors,
        url: id,                // abstract page
        openAccessPdf: pdfUrl,
      });

      if (results.length >= 5) break;
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
