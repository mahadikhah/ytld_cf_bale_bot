// worker/src/github.ts
// ======================================
//  GitHub API – optional GITHUB_TOKEN for higher rate limit
// ======================================

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "BaleYouTubeBot/1.0";

function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_\[\]()~`]/g, '\\$&');
}

// ---------- types ----------
export interface GhRepo {
  full_name: string;
  description: string | null;
  stars: number;
  language: string | null;
  url: string;
}

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
  archive_url: string;
}

export interface GhFileItem {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
  download_url: string | null;
  html_url: string;
}

export interface GhIssue {
  number: number;
  title: string;
  state: string;
  html_url: string;
  user: string;
  labels: string[];
  comments: number;
}

export interface GhCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface GhPRFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

// ---------- helpers ----------
export function headers(token?: string): HeadersInit {
  const h: Record<string, string> = { 'User-Agent': USER_AGENT };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

// ---------- search repos ----------
export async function searchRepos(query: string, page = 1, token?: string) {
  const params = new URLSearchParams({ q: query, per_page: '5', page: page.toString() });
  const url = `${GITHUB_API}/search/repositories?${params}`;
  const resp = await fetch(url, { headers: headers(token) });
  if (!resp.ok) return { repos: [] as GhRepo[], totalCount: 0 };
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

// ---------- repo details ----------
export async function getRepoDetails(owner: string, repo: string, token?: string): Promise<GhRepoDetails | null> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}`;
  const resp = await fetch(url, { headers: headers(token) });
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

// ---------- repo contents (file tree) ----------
export async function getRepoContents(owner: string, repo: string, path = '', token?: string): Promise<GhFileItem[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`;
  const resp = await fetch(url, { headers: headers(token) });
  if (!resp.ok) return [];
  const data: any = await resp.json();
  if (Array.isArray(data)) {
    return data.map((item: any) => ({
      name: item.name,
      path: item.path,
      type: item.type,
      size: item.size,
      download_url: item.download_url,
      html_url: item.html_url,
    }));
  }
  // Single file
  return [{
    name: data.name,
    path: data.path,
    type: data.type,
    size: data.size,
    download_url: data.download_url,
    html_url: data.html_url,
  }];
}

export async function getFileRawUrl(owner: string, repo: string, path: string, token?: string): Promise<string | null> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`;
  const resp = await fetch(url, { headers: headers(token) });
  if (!resp.ok) return null;
  const data: any = await resp.json();
  return data.download_url || null;
}

// ---------- issues ----------
export async function getIssues(owner: string, repo: string, state = 'open', page = 1, token?: string): Promise<GhIssue[]> {
  const params = new URLSearchParams({ state, per_page: '5', page: page.toString() });
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues?${params}`;
  const resp = await fetch(url, { headers: headers(token) });
  if (!resp.ok) return [];
  const items: any[] = await resp.json();
  return items
    .filter(i => !i.pull_request)
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

export async function getIssueComments(owner: string, repo: string, issueNumber: number, page = 1, token?: string) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=5&page=${page}`;
  const resp = await fetch(url, { headers: headers(token) });
  if (!resp.ok) return [];
  const items: any[] = await resp.json();
  return items.map(i => ({
    user: i.user?.login || 'unknown',
    body: i.body?.slice(0, 300) || '',
    created: i.created_at,
  }));
}

// ---------- pull requests ----------
export async function getPulls(owner: string, repo: string, state = 'open', page = 1, token?: string): Promise<GhIssue[]> {
  const params = new URLSearchParams({ state, per_page: '5', page: page.toString() });
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls?${params}`;
  const resp = await fetch(url, { headers: headers(token) });
  if (!resp.ok) return [];
  const items: any[] = await resp.json();
  return items.map(i => ({
    number: i.number,
    title: i.title,
    state: i.state,
    html_url: i.html_url,
    user: i.user?.login || 'unknown',
    labels: (i.labels || []).map((l: any) => l.name),
    comments: i.comments || 0,
  }));
}

export async function getPrCommits(owner: string, repo: string, prNumber: number, token?: string): Promise<GhCommit[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/commits`;
  const resp = await fetch(url, { headers: headers(token) });
  if (!resp.ok) return [];
  const data: any[] = await resp.json();
  return data.slice(0, 5).map((c: any) => ({
    sha: c.sha.substring(0, 7),
    message: c.commit.message.split('\n')[0],
    author: c.commit.author?.name || c.author?.login || 'unknown',
    date: c.commit.author?.date?.split('T')[0] || '',
  }));
}

export async function getIssueDetail(owner: string, repo: string, issueNumber: number, token?: string) {
  const resp = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}`, { headers: headers(token) });
  if (!resp.ok) return null;
  const data = await resp.json();
  return {
    number: data.number,
    title: data.title,
    state: data.state,
    html_url: data.html_url,
    user: data.user?.login || '',
    labels: (data.labels || []).map((l: any) => l.name),
    comments: data.comments,
  };
}

export async function getPrDetail(owner: string, repo: string, prNumber: number, token?: string) {
  const resp = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}`, { headers: headers(token) });
  if (!resp.ok) return null;
  const data = await resp.json();
  return {
    number: data.number,
    title: data.title,
    state: data.state,
    html_url: data.html_url,
    user: data.user?.login || '',
    labels: (data.labels || []).map((l: any) => l.name),
    comments: data.comments || 0,
  };
}


export async function getPrFiles(owner: string, repo: string, prNumber: number, token?: string): Promise<GhPRFile[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=10`;
  const resp = await fetch(url, { headers: headers(token) });
  if (!resp.ok) return [];
  const data: any[] = await resp.json();
  return data.map((f: any) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
  }));
}

export async function getPrComments(owner: string, repo: string, prNumber: number, token?: string): Promise<{ user: string; body: string; created: string }[]> {
  // PR comments are same endpoint as issue comments
  return getIssueComments(owner, repo, prNumber, 1, token);
}

// ---------- message builders ----------
export function buildSearchMessage(result: { repos: GhRepo[]; totalCount: number }, query: string, page: number) {
  const { repos, totalCount } = result;
  if (repos.length === 0) return { text: "No repositories found.", keyboard: [] };
  let text = `🐙 *GitHub Search:* \`${escapeMarkdown(query)}\`\n\n`;
  repos.forEach((r, i) => {
    const idx = (page - 1) * 5 + i + 1;
    const desc = r.description ? escapeMarkdown(r.description.slice(0, 80)) : 'No description';
    text += `${idx}\\. *${escapeMarkdown(r.full_name)}*\n⭐ ${r.stars}  🟡 ${r.language || '?'}\n_${desc}_\n[🔗 Open](${r.url})\n\n`;
  });
  const keyboard: any[][] = repos.map((r, i) => [{
    text: `📁 ${i+1}. ${r.full_name}`,
    callback_data: `gh_repo|${encodeURIComponent(r.full_name)}`,
  }]);
  const totalPages = Math.ceil(totalCount / 5);
  const navRow: any[] = [];
  if (page > 1) navRow.push({ text: '⬅️ Prev', callback_data: `gh_search|${encodeURIComponent(query)}|${page-1}` });
  if (page < totalPages) navRow.push({ text: 'Next ➡️', callback_data: `gh_search|${encodeURIComponent(query)}|${page+1}` });
  if (navRow.length) keyboard.push(navRow);
  text += `_Page ${page}/${totalPages} (${totalCount} repos)_`;
  return { text, keyboard };
}

export function buildRepoMessage(details: GhRepoDetails) {
  let text = `🐙 *${escapeMarkdown(details.full_name)}*\n\n`;
  text += `📝 ${details.description ? escapeMarkdown(details.description) : 'No description'}\n`;
  text += `⭐ ${details.stars}  🍴 ${details.forks}  ❗ ${details.open_issues}\n`;
  text += `🟡 ${details.language || '?'}  📄 ${details.license || 'None'}\n`;
  text += `📏 ${details.size_kb} KB  🌿 ${details.default_branch}\n`;
  if (details.topics.length) text += `🏷️ ${details.topics.slice(0,5).join(', ')}\n`;
  text += `[🔗 GitHub](${details.html_url})`;
  const keyboard: any[][] = [
    [
      { text: '📋 Issues', callback_data: `gh_issues|${encodeURIComponent(details.full_name)}|open` },
      { text: '🔄 PRs', callback_data: `gh_pulls|${encodeURIComponent(details.full_name)}|open` },
    ],
    [
      { text: '📂 Browse files', callback_data: `gh_tree|${encodeURIComponent(details.full_name)}|` },
      { text: '📥 Download ZIP', callback_data: `gh_dl|${encodeURIComponent(details.full_name)}` },
    ],
  ];
  return { text, keyboard };
}

export function buildTreeMessage(fullName: string, path: string, items: GhFileItem[]) {
  const displayPath = path || '/';
  let text = `📂 *${escapeMarkdown(fullName)}*\nPath: \`${displayPath}\`\n\n`;
  if (items.length === 0) {
    text += '_Empty directory._';
    return { text, keyboard: buildTreeBackKeyboard(fullName, path) };
  }
  // Sort dirs first
  items.sort((a, b) => (a.type === 'dir' ? -1 : 1) - (b.type === 'dir' ? -1 : 1) || a.name.localeCompare(b.name));
  items.forEach((item, i) => {
    const icon = item.type === 'dir' ? '📁' : '📄';
    text += `${i+1}\\. ${icon} ${escapeMarkdown(item.name)}`;
    if (item.type === 'file') text += ` (${(item.size/1024).toFixed(1)} KB)`;
    text += '\n';
  });
  const keyboard: any[][] = [];
  // one button per item
  items.forEach(item => {
    if (item.type === 'dir') {
      keyboard.push([{ text: `📁 ${item.name}`, callback_data: `gh_tree|${encodeURIComponent(fullName)}|${encodeURIComponent(item.path)}` }]);
    } else {
      keyboard.push([{ text: `📄 ${item.name}`, callback_data: `gh_file|${encodeURIComponent(fullName)}|${encodeURIComponent(item.path)}` }]);
    }
  });
  // back to parent or repo
  const backRow = buildTreeBackRow(fullName, path);
  if (backRow.length) keyboard.push(backRow);
  return { text, keyboard };
}

function buildTreeBackRow(fullName: string, path: string): any[] {
  const row: any[] = [];
  if (path) {
    const parentPath = path.split('/').slice(0, -1).join('/');
    row.push({ text: '⬅️ Back', callback_data: `gh_tree|${encodeURIComponent(fullName)}|${encodeURIComponent(parentPath)}` });
  } else {
    row.push({ text: '⬅️ Back to repo', callback_data: `gh_repo|${encodeURIComponent(fullName)}` });
  }
  return row;
}

function buildTreeBackKeyboard(fullName: string, path: string) {
  const row = buildTreeBackRow(fullName, path);
  return row.length ? [row] : [];
}

export function buildIssueList(items: GhIssue[], type: 'issues'|'pulls', fullName: string, state: string, page: number) {
  const label = type === 'issues' ? 'Issues' : 'Pull Requests';
  if (items.length === 0) return { text: `No ${label.toLowerCase()} found.`, keyboard: [[{ text: '⬅️ Back', callback_data: `gh_repo|${encodeURIComponent(fullName)}` }]] };
  let text = `🐙 *${escapeMarkdown(fullName)} – ${label} (${state})*\n\n`;
  items.forEach((i, idx) => {
    const icon = i.state === 'open' ? '🟢' : '🔴';
    text += `${idx+1}\\. ${icon} #${i.number} ${escapeMarkdown(i.title)}\n👤 ${i.user}  💬 ${i.comments}\n[🔗 Open](${i.html_url})\n\n`;
  });
  const keyboard: any[][] = [];
  // each item button
  items.forEach(i => {
    keyboard.push([{ text: `#${i.number} ${i.title.slice(0,40)}`, callback_data: `gh_item_detail|${type}|${encodeURIComponent(fullName)}|${i.number}` }]);
  });
  const navRow: any[] = [];
  if (page > 1) navRow.push({ text: '⬅️ Prev', callback_data: `gh_${type}|${encodeURIComponent(fullName)}|${state}|${page-1}` });
  navRow.push({ text: 'Next ➡️', callback_data: `gh_${type}|${encodeURIComponent(fullName)}|${state}|${page+1}` });
  keyboard.push(navRow);
  keyboard.push([{ text: '⬅️ Back to repo', callback_data: `gh_repo|${encodeURIComponent(fullName)}` }]);
  return { text, keyboard };
}

export function buildIssueDetail(issue: GhIssue, comments: { user: string; body: string; created: string }[], fullName: string) {
  let text = `🐙 *${escapeMarkdown(fullName)}* – Issue #${issue.number}\n\n`;
  text += `*Title:* ${escapeMarkdown(issue.title)}\n`;
  text += `*State:* ${issue.state}  *By:* ${issue.user}\n`;
  text += `*Labels:* ${issue.labels.length ? issue.labels.join(', ') : 'none'}\n\n`;
  text += `*Comments (${comments.length}):*\n`;
  comments.forEach(c => {
    text += `┃ 👤 ${c.user} (${c.created.split('T')[0]}):\n┃ _${escapeMarkdown(c.body.slice(0,150))}_\n\n`;
  });
  const keyboard: any[][] = [
    [{ text: '⬅️ Back to issues', callback_data: `gh_issues|${encodeURIComponent(fullName)}|open` }],
  ];
  return { text, keyboard };
}

export function buildPrDetail(pr: GhIssue, commits: GhCommit[], files: GhPRFile[], comments: { user: string; body: string; created: string }[], fullName: string) {
  let text = `🐙 *${escapeMarkdown(fullName)}* – PR #${pr.number}\n\n`;
  text += `*Title:* ${escapeMarkdown(pr.title)}\n`;
  text += `*State:* ${pr.state}  *By:* ${pr.user}\n\n`;
  
  text += `*Commits (${commits.length}):*\n`;
  commits.forEach(c => {
    text += `┃ \`${c.sha}\` ${escapeMarkdown(c.message.slice(0,60))} by ${c.author} on ${c.date}\n`;
  });
  text += `\n*Changed Files (${files.length}):*\n`;
  files.forEach(f => {
    text += `┃ ${escapeMarkdown(f.filename)} (${f.status}, +${f.additions}/-${f.deletions})\n`;
  });
  text += `\n*Comments:*\n`;
  comments.forEach(c => {
    text += `┃ 👤 ${c.user}: _${escapeMarkdown(c.body.slice(0,150))}_\n`;
  });
  const keyboard: any[][] = [
    [{ text: '⬅️ Back to PR list', callback_data: `gh_pulls|${encodeURIComponent(fullName)}|open` }],
  ];
  return { text, keyboard };
}
