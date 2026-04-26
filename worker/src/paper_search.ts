// worker/src/paper_search.ts
// ======================================
//  Scholarly paper search – Semantic Scholar
// ======================================

const SS_API = "https://api.semanticscholar.org/graph/v1/paper/search";
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
  url: string;           // semantic scholar page
  openAccessPdf: string | null;  // direct PDF if available
}

export async function searchPapers(query: string): Promise<PaperResult[]> {
  const params = new URLSearchParams({
    query,
    limit: "5",
    fields: "title,year,authors,url,openAccessPdf",
  });
  const url = `${SS_API}?${params}`;
  const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!resp.ok) {
    console.error("Semantic Scholar error:", resp.status);
    return [];
  }
  const json: any = await resp.json();
  return (json.data || []).map((p: any) => ({
    title: p.title || "Untitled",
    year: p.year || null,
    authors: (p.authors || []).map((a: any) => a.name),
    url: p.url || `https://www.semanticscholar.org/paper/${p.paperId}`,
    openAccessPdf: p.openAccessPdf?.url || null,
  }));
}

export function buildPaperMessage(papers: PaperResult[]): {
  text: string;
  keyboard: any[][];
} {
  if (papers.length === 0) {
    return {
      text: "No scholarly articles found.",
      keyboard: [],
    };
  }

  let text = "🎓 *Scholarly Results:*\n\n";
  const keyboard: any[][] = [];

  papers.forEach((p, i) => {
    const idx = i + 1;
    const title = escapeMarkdown(p.title);
    const yearStr = p.year ? ` (${p.year})` : "";
    const authorsStr = p.authors.join(", ");
    const hasPdf = !!p.openAccessPdf;

    text += `${idx}\\. *${title}*${yearStr}\n`;
    text += `👤 ${escapeMarkdown(authorsStr)}\n`;
    text += `🔗 [View on Semantic Scholar](${p.url})\n`;
    if (!hasPdf) text += `_(No direct PDF available)_\n`;
    text += "\n";

    // Only add a download button if there is an open-access PDF
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
