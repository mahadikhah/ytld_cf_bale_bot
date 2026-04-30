// worker/src/github.ts
// ======================================
//  GitHub API – no authentication needed
// ======================================

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "BaleYouTubeBot/1.0";

// ------------------ helpers ------------------
function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_\[\]()~`]/g, '\\$&');
}

// ------------------ search repos ------------------
export interface GhRepo {
  full_name: string;
  description: string | null;
  stars: number;
  language: string | null;
  url: string;
}

export async function searchRepos(query: string, page = 1): Promise<{ repos: GhRepo[]; totalCount: number }> {
  const params = new URLSearchParams({
    q: query,
    per_page: '5',
    page: page.toString(),
  });
  const url = `${GITHUB_API}/search/repositories?${params.toString()}`;
  const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!resp.ok) return { repos: [], totalCount: 0 };
  const data: any = await resp.json();
  const repos: GhRepo[] = (data.items || []).map((r: any) => ({
    full_name: r.full_name,
    description: r.description,
    stars: r.stargazers_count,
    language: r.language,
    url: r.html_url,
  }));
  return { repos, totalCount: data.total_count || 0 };
}

// ------------------ repo details ------------------
export interface GhRepoDetails {
  full_name: string;
  description: string | null;
  stars: number;
  forks: number;
  open_issues: number;
  language: string | null;
  topics: string[];
  default_branch: string;
  license: string | null;
  html_url: string;
  size_kb: number;
  archive_url: string;  // direct zipball/codeload
}

export async function getRepoDetails(owner: string, repo: string): Promise<GhRepoDetails | null> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}`;
  const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!resp.ok) return null;
  const d: any = await resp.json();
  return {
    full_name: d.full_name,
    description: d.description,
    stars: d.stargazers_count,
    forks: d.forks_count,
    open_issues: d.open_issues_count,
    language: d.language,
    topics: d.topics || [],
    default_branch: d.default_branch,
    license: d.license?.spdx_id || null,
    html_url: d.html_url,
    size_kb: d.size,
    archive_url: `https://api.github.com/repos/${owner}/${repo}/zipball`,
  };
}

// ------------------ issues / PRs ------------------
export interface GhIssue {
  number: number;
  title: string;
  state: string;
  html_url: string;
  user: string;
  labels: string[];
  comments: number;
}

export async function getIssues(owner: string, repo: string, state: 'open'|'closed'|'all' = 'open', page = 1): Promise<GhIssue[]> {
  const params = new URLSearchParams({
    state,
    per_page: '5',
    page: page.toString(),
  });
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues?${params.toString()}`;
  const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!resp.ok) return [];
  const items: any[] = await resp.json();
  return items
    .filter(i => !i.pull_request)  // exclude PRs
    .map(i => ({
      number: i.number,
      title: i.title,
      state: i.state,
      html_url: i.html_url,
      user: i.user?.login || 'unknown',
      labels: (i.labels || []).map((l: any) => l.name),
      comments: i.comments,
    }));
}

export async function getPulls(owner: string, repo: string, state: 'open'|'closed'|'all' = 'open', page = 1): Promise<GhIssue[]> {
  const params = new URLSearchParams({
    state,
    per_page: '5',
    page: page.toString(),
  });
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls?${params.toString()}`;
  const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!resp.ok) return [];
  const items: any[] = await resp.json();
  return items.map(i => ({
    number: i.number,
    title: i.title,
    state: i.state,
    html_url: i.html_url,
    user: i.user?.login || 'unknown',
    labels: (i.labels || []).map((l: any) => l.name),
    comments: i.comments,   // not directly, we'll fetch later if needed
  }));
}

// ------------------ issue / PR comments ------------------
export async function getComments(owner: string, repo: string, issueNumber: number, page = 1): Promise<{ user: string; body: string; created: string }[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=5&page=${page}`;
  const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!resp.ok) return [];
  const items: any[] = await resp.json();
  return items.map(i => ({
    user: i.user?.login || 'unknown',
    body: i.body?.slice(0, 200) || '',
    created: i.created_at,
  }));
}

// ------------------ message builders ------------------
export function buildSearchMessage(result: { repos: GhRepo[]; totalCount: number }, query: string, page: number): { text: string; keyboard: any[][] } {
  const { repos, totalCount } = result;
  if (repos.length === 0) return { text: "No repositories found.", keyboard: [] };
  let text = `🐙 *GitHub Search:* \`${escapeMarkdown(query)}\`\n\n`;
  repos.forEach((r, i) => {
    const idx = (page - 1) * 5 + i + 1;
    const desc = r.description ? escapeMarkdown(r.description.slice(0, 80)) : 'No description';
    text += `${idx}\\. *${escapeMarkdown(r.full_name)}*\n⭐ ${r.stars}  🟡 ${r.language || '?'}\n_${desc}_\n[🔗 Open](${r.url})\n\n`;
  });
  const keyboard: any[][] = [];
  // repo buttons: detail + download
  repos.forEach((r, i) => {
    keyboard.push([{
      text: `📁 ${i+1}. View ${r.full_name}`,
      callback_data: `gh_repo|${encodeURIComponent(r.full_name)}`,
    }]);
  });
  // pagination
  const totalPages = Math.ceil(totalCount / 5);
  const navRow: any[] = [];
  if (page > 1) navRow.push({ text: '⬅️ Prev', callback_data: `gh_search|${encodeURIComponent(query)}|${page-1}` });
  if (page < totalPages) navRow.push({ text: 'Next ➡️', callback_data: `gh_search|${encodeURIComponent(query)}|${page+1}` });
  if (navRow.length) keyboard.push(navRow);
  text += `_Page ${page}/${totalPages} | Total: ${totalCount}_`;
  return { text, keyboard };
}

export function buildRepoMessage(details: GhRepoDetails): { text: string; keyboard: any[][] } {
  let text = `🐙 *${escapeMarkdown(details.full_name)}*\n\n`;
  text += `📝 ${details.description ? escapeMarkdown(details.description) : 'No description'}\n`;
  text += `⭐ Stars: ${details.stars}  🍴 Forks: ${details.forks}  ❗ Issues: ${details.open_issues}\n`;
  text += `🟡 Language: ${details.language || '?'}  📄 License: ${details.license || 'None'}\n`;
  text += `📏 Size: ${details.size_kb} KB  🌿 Default branch: ${details.default_branch}\n`;
  if (details.topics.length) text += `🏷️ Topics: ${details.topics.slice(0,5).join(', ')}\n`;
  text += `[🔗 Open on GitHub](${details.html_url})`;
  const keyboard: any[][] = [
    [{ text: '📋 Issues', callback_data: `gh_issues|${encodeURIComponent(details.full_name)}|open` },
     { text: '🔄 PRs', callback_data: `gh_pulls|${encodeURIComponent(details.full_name)}|open` }],
    [{ text: '📥 Download ZIP', callback_data: `gh_dl|${encodeURIComponent(details.full_name)}` }],
  ];
  return { text, keyboard };
}

export function buildIssueList(items: GhIssue[], type: 'issues'|'pulls', fullName: string, state: string, page: number): { text: string; keyboard: any[][] } {
  const label = type === 'issues' ? 'Issues' : 'Pull Requests';
  if (items.length === 0) return { text: `No ${label.toLowerCase()} found.`, keyboard: [] };
  let text = `🐙 *${escapeMarkdown(fullName)} – ${label} (${state})*\n\n`;
  items.forEach((i, idx) => {
    const icon = i.state === 'open' ? '🟢' : '🔴';
    text += `${idx+1}\\. ${icon} #${i.number} ${escapeMarkdown(i.title)}\n👤 ${i.user}  💬 ${i.comments}\n[🔗 Open](${i.html_url})\n\n`;
  });
  const keyboard: any[][] = [];
  // pagination
  const navRow: any[] = [];
  if (page > 1) navRow.push({ text: '⬅️ Prev', callback_data: `gh_${type}|${encodeURIComponent(fullName)}|${state}|${page-1}` });
  navRow.push({ text: 'Next ➡️', callback_data: `gh_${type}|${encodeURIComponent(fullName)}|${state}|${page+1}` });
  keyboard.push(navRow);
  return { text, keyboard };
}
