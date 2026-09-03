const { app, BrowserWindow, Menu, dialog, ipcMain, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const simpleGit = require('simple-git');

// test isolation: drivers point userData at a scratch dir so they never touch the real config
if (process.env.AURORA_USER_DATA) app.setPath('userData', process.env.AURORA_USER_DATA);

const DEFAULT_REPO = 'C:/Users/Ondrej/Documents/triggerz/triggerz';
const configFile = () => path.join(app.getPath('userData'), 'repos.json');

const isGitRepo = (dir) => {
  try { return fs.existsSync(path.join(dir, '.git')); } catch { return false; }
};

const loadConfig = () => {
  try {
    const stored = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    if (Array.isArray(stored.repos)) return stored;
  } catch { /* first run or unreadable — reseed below */ }
  return null;
};

const saveConfig = () => {
  try {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(config, null, 2));
  } catch { /* config is a convenience — never take the app down over it */ }
};

let repoPath;
let git;
const setRepo = (dir) => {
  repoPath = dir;
  git = simpleGit(dir);
};

// seeded with the two repos Ondrej maintains; grows via the in-app "Add repository"
const config = loadConfig()
  || { repos: [DEFAULT_REPO, __dirname].filter(isGitRepo), current: null };

// `electron . <repoPath>` / `Aurora.exe <repoPath>` — a CLI repo wins for this session
// but is NOT saved to the config. Launchers inject extra arguments (Playwright adds
// --flags, electronmon adds `--require <hook.js>` whose VALUE looks positional), so
// positional slots are unreliable: take the last positional, require it to be a real
// git repo other than the app itself.
const positional = process.argv.slice(1).filter((arg) => !arg.startsWith('-'));
const argCandidate = positional.length > 0 ? path.resolve(positional[positional.length - 1]) : null;
if (argCandidate && argCandidate !== __dirname && isGitRepo(argCandidate)) {
  setRepo(argCandidate);
} else if (config.current && isGitRepo(config.current)) {
  setRepo(config.current);
} else {
  // no valid repo is not fatal — the renderer shows a picker-friendly error state
  const fallback = config.repos.find(isGitRepo) || (isGitRepo(DEFAULT_REPO) ? DEFAULT_REPO : null);
  if (fallback) setRepo(fallback);
}

let win;

// ---- accounts: personal access tokens for GitHub / GitLab remotes over HTTPS ----

const accountsFile = () => path.join(app.getPath('userData'), 'accounts.json');

let accounts = [];
try {
  const stored = JSON.parse(fs.readFileSync(accountsFile(), 'utf8'));
  if (Array.isArray(stored)) accounts = stored;
} catch { /* no accounts yet */ }

const saveAccounts = () => {
  try {
    fs.mkdirSync(path.dirname(accountsFile()), { recursive: true });
    fs.writeFileSync(accountsFile(), JSON.stringify(accounts, null, 2));
  } catch { /* losing accounts is recoverable — the user can re-add them */ }
};

const encryptToken = (token) => safeStorage.isEncryptionAvailable()
  ? { enc: safeStorage.encryptString(token).toString('base64') }
  : { plain: token };
const decryptToken = (stored) => stored.enc
  ? safeStorage.decryptString(Buffer.from(stored.enc, 'base64'))
  : stored.plain;

// git invokes GIT_ASKPASS once for the username prompt and once for the password;
// the script answers from env vars set per remote operation. Kept in userData —
// note git runs it through a shell, so a userData path with spaces would break it.
const askpassFile = () => path.join(app.getPath('userData'), 'askpass.cmd');
const ensureAskpass = () => {
  const script = [
    '@echo off',
    'echo.%~1| findstr /I /C:"Username" >nul',
    'if not errorlevel 1 (echo %AURORA_GIT_USERNAME%) else (echo %AURORA_GIT_PASSWORD%)',
    ''
  ].join('\r\n');
  fs.mkdirSync(path.dirname(askpassFile()), { recursive: true });
  fs.writeFileSync(askpassFile(), script);
};

const parseRemoteHost = (url) => {
  if (!url) return null;
  let match = url.match(/^https?:\/\/(?:[^@/]+@)?([^/:]+)/i);
  if (match) return { host: match[1].toLowerCase(), protocol: 'https' };
  match = url.match(/^(?:ssh:\/\/)?(?:[^@]+@)([^/:]+)/i);
  if (match) return { host: match[1].toLowerCase(), protocol: 'ssh' };
  return null;
};

const originInfo = async () => {
  try {
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((remote) => remote.name === 'origin') || remotes[0];
    return origin ? parseRemoteHost(origin.refs.fetch || origin.refs.push) : null;
  } catch { return null; }
};

// Wraps fetch/pull/push: injects the matching account's token via askpass, never
// lets git block on a terminal prompt, and maps auth failures to actionable text.
const remoteAction = async (run) => {
  if (!git) throw new Error('No repository selected — use the repo menu to add one.');
  const remote = await originInfo();
  const account = remote && remote.protocol === 'https'
    ? accounts.find((acc) => acc.host === remote.host) : null;
  // inherit the environment minus git behavior overrides (editor, askpass, ssh
  // command…): they make git unpredictable inside a GUI app, and simple-git's
  // unsafe scanner rejects them. Beyond GIT_*, the scanner's blocklist also
  // covers the unprefixed EDITOR, PAGER, SSH_ASKPASS and PREFIX.
  const env = { GIT_TERMINAL_PROMPT: '0' };
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^GIT_/i.test(key) && !/^(EDITOR|VISUAL|PAGER|SSH_ASKPASS|PREFIX)$/i.test(key)) {
      env[key] = value;
    }
  }
  if (account) {
    ensureAskpass();
    env.GIT_ASKPASS = askpassFile();
    env.AURORA_GIT_USERNAME = account.username;
    env.AURORA_GIT_PASSWORD = await freshToken(account);
  }
  // credential.helper= empties the helper list so the saved token wins over any
  // system credential manager; only done when we actually have a token to offer.
  // The unsafe opt-ins are fine: both values are app-controlled literals (our own
  // askpass script and the empty helper string), never user input.
  const runner = simpleGit({
    baseDir: repoPath,
    config: account ? ['credential.helper='] : [],
    unsafe: { allowUnsafeCredentialHelper: true, allowUnsafeAskPass: true }
  }).env(env);
  try {
    return await run(runner);
  } catch (error) {
    const message = String(error.message || '');
    if (/could not read (Username|Password)|Authentication failed|terminal prompts disabled|HTTP Basic: Access denied|invalid credentials/i.test(message)) {
      throw new Error(account
        ? `Authentication failed for ${remote.host} — the saved token may be expired or missing scopes. Update it under Accounts.`
        : `Authentication needed for ${remote ? remote.host : 'this remote'} — add an account with a personal access token (top right).`);
    }
    throw error;
  }
};

// Aurora's OAuth apps — client IDs are public identifiers, not secrets.
// GitHub: registered by bureson with "Enable Device Flow" ticked.
// GitLab: register at gitlab.com → User settings → Applications (see registerHint).
const GITHUB_CLIENT_ID = process.env.AURORA_GITHUB_CLIENT_ID || 'Ov23lism4qAfoo2PXyvc';
const GITLAB_CLIENT_ID = process.env.AURORA_GITLAB_CLIENT_ID
  || '32c3bbd30da6637144520521c4e468284c371ac83c4f3ecccde6c5873b336719';
// env overrides exist so tests can point the flows at a local mock server
const GH_OAUTH_BASE = process.env.AURORA_GH_OAUTH_BASE || 'https://github.com';
const GH_API_BASE = process.env.AURORA_GH_API_BASE || 'https://api.github.com';
const GL_OAUTH_BASE = process.env.AURORA_GL_OAUTH_BASE || 'https://gitlab.com';
const GL_API_BASE = process.env.AURORA_GL_API_BASE || 'https://gitlab.com/api/v4';

const validateAccount = async (flavor, host, token) => {
  const url = flavor === 'github'
    ? (host === 'github.com' ? `${GH_API_BASE}/user` : `https://${host}/api/v3/user`)
    : (host === 'gitlab.com' ? `${GL_API_BASE}/user` : `https://${host}/api/v4/user`);
  // Bearer works for GitLab PATs and OAuth tokens alike; PRIVATE-TOKEN is PAT-only
  const headers = flavor === 'github'
    ? { Authorization: `Bearer ${token}`, 'User-Agent': 'aurora-git-client' }
    : { Authorization: `Bearer ${token}` };
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!response.ok) return { verified: false, reason: `the ${flavor === 'github' ? 'GitHub' : 'GitLab'} API answered ${response.status}` };
    const user = await response.json();
    return { verified: true, name: user.login || user.username || user.name || '' };
  } catch {
    return { verified: false, reason: 'the API could not be reached' };
  }
};

ipcMain.handle('accounts:list', () => accounts.map(({ host, username, flavor, verifiedName }) =>
  ({ host, username, flavor, verifiedName: verifiedName || null })));

ipcMain.handle('accounts:add', async (_event, { flavor, host, username, token }) => {
  host = String(host || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  token = String(token || '').trim();
  username = String(username || '').trim();
  if (!host || !token) throw new Error('Host and token are both required');
  const check = await validateAccount(flavor, host, token);
  // any non-blank username works with a token on both providers; prefer the real one
  if (!username) username = (check.verified && check.name) || (flavor === 'gitlab' ? 'oauth2' : 'x-access-token');
  accounts = accounts.filter((acc) => acc.host !== host);
  accounts.push({ host, username, flavor, verifiedName: check.verified ? check.name : null, token: encryptToken(token) });
  saveAccounts();
  return check;
});

ipcMain.handle('accounts:remove', (_event, host) => {
  accounts = accounts.filter((acc) => acc.host !== host);
  saveAccounts();
});

// ---- Sign in with GitHub / GitLab via the OAuth device flow: browser opens, the
// user approves, we poll until the provider hands over a token. No client secret. ----

const OAUTH_PROVIDERS = {
  github: {
    label: 'GitHub',
    host: 'github.com',
    clientId: GITHUB_CLIENT_ID,
    // workflow: pushes touching .github/workflows are rejected without it
    scope: 'repo workflow',
    deviceUrl: () => `${GH_OAUTH_BASE}/login/device/code`,
    tokenUrl: () => `${GH_OAUTH_BASE}/login/oauth/access_token`,
    registerHint: 'Browser sign-in needs a GitHub OAuth client ID. Register one at '
      + 'github.com/settings/applications/new (enable "Device Flow"), then set '
      + 'AURORA_GITHUB_CLIENT_ID or fill GITHUB_CLIENT_ID in main.js. '
      + 'Until then, paste a personal access token instead.'
  },
  gitlab: {
    label: 'GitLab',
    host: 'gitlab.com',
    clientId: GITLAB_CLIENT_ID,
    // read_api: the CI pipeline display queries the REST API
    scope: 'read_user read_api read_repository write_repository',
    deviceUrl: () => `${GL_OAUTH_BASE}/oauth/authorize_device`,
    tokenUrl: () => `${GL_OAUTH_BASE}/oauth/token`,
    registerHint: 'Browser sign-in needs a GitLab application ID. Register one at '
      + 'gitlab.com → User settings → Applications: untick "Confidential", pick the '
      + 'read_user, read_api, read_repository and write_repository scopes (redirect '
      + 'URI can be http://localhost), then set AURORA_GITLAB_CLIENT_ID or fill '
      + 'GITLAB_CLIENT_ID in main.js. Until then, paste a personal access token instead.'
  }
};

// GitLab OAuth tokens expire (~2h) and come with a refresh token; GitHub's don't
const saveOauthAccount = async (flavor, tokenData) => {
  const { host } = OAUTH_PROVIDERS[flavor];
  const check = await validateAccount(flavor, host, tokenData.access_token);
  const username = flavor === 'gitlab' ? 'oauth2' : ((check.verified && check.name) || 'x-access-token');
  accounts = accounts.filter((acc) => acc.host !== host);
  accounts.push({
    host, username, flavor,
    verifiedName: check.verified ? check.name : null,
    token: encryptToken(tokenData.access_token),
    ...(tokenData.refresh_token ? {
      refreshToken: encryptToken(tokenData.refresh_token),
      expiresAt: Date.now() + (tokenData.expires_in || 7200) * 1000
    } : {})
  });
  saveAccounts();
  return check;
};

let deviceFlowSession = 0; // bumping this cancels any poll loop still running

ipcMain.handle('oauth:start', async (_event, flavor) => {
  const provider = OAUTH_PROVIDERS[flavor];
  if (!provider) throw new Error(`Unknown provider: ${flavor}`);
  if (!provider.clientId) throw new Error(provider.registerHint);
  const response = await fetch(provider.deviceUrl(), {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: new URLSearchParams({ client_id: provider.clientId, scope: provider.scope })
  });
  if (!response.ok) throw new Error(`${provider.label} answered ${response.status} when starting sign-in`);
  const data = await response.json();
  // GitLab includes verification_uri_complete (code pre-filled) — prefer it
  if (process.env.AURORA_NO_BROWSER !== '1') {
    shell.openExternal(data.verification_uri_complete || data.verification_uri);
  }
  return {
    flavor,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    codePrefilled: !!data.verification_uri_complete,
    deviceCode: data.device_code,
    interval: data.interval || 5,
    expiresIn: data.expires_in || 900
  };
});

ipcMain.handle('oauth:poll', async (_event, { flavor, deviceCode, interval, expiresIn }) => {
  const provider = OAUTH_PROVIDERS[flavor];
  const session = ++deviceFlowSession;
  const deadline = Date.now() + expiresIn * 1000;
  let delay = Math.max(interval, 1) * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (session !== deviceFlowSession) return null; // cancelled or superseded
    const response = await fetch(provider.tokenUrl(), {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: provider.clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      })
    });
    const data = await response.json().catch(() => ({}));
    if (data.access_token) return saveOauthAccount(flavor, data);
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') { delay += 5000; continue; }
    if (data.error === 'expired_token') break;
    if (data.error) throw new Error(`${provider.label} sign-in failed: ${data.error_description || data.error}`);
  }
  throw new Error(`${provider.label} sign-in timed out — the code expired before it was approved in the browser.`);
});

ipcMain.handle('oauth:cancel', () => { deviceFlowSession++; });

// hand back a live access token: refresh expiring OAuth tokens transparently
const freshToken = async (account) => {
  if (!account.expiresAt || Date.now() < account.expiresAt - 60000) return decryptToken(account.token);
  const provider = OAUTH_PROVIDERS[account.flavor];
  const response = await fetch(provider.tokenUrl(), {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: provider.clientId,
      grant_type: 'refresh_token',
      refresh_token: decryptToken(account.refreshToken)
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!data.access_token) {
    throw new Error(`The ${account.host} session has expired and could not be refreshed — sign in again under Accounts.`);
  }
  account.token = encryptToken(data.access_token);
  if (data.refresh_token) account.refreshToken = encryptToken(data.refresh_token); // GitLab rotates it
  account.expiresAt = Date.now() + (data.expires_in || 7200) * 1000;
  saveAccounts();
  return data.access_token;
};

// ---- GitLab CI: pipeline statuses for the commits on screen ----

// origin URL → project path ("group/sub/project") for the API, https or ssh form
const parseProjectPath = (url) => {
  if (!url) return null;
  let match = url.match(/^https?:\/\/(?:[^@/]+@)?[^/:]+\/(.+?)(?:\.git)?\/?$/i);
  if (!match) match = url.match(/^(?:ssh:\/\/)?(?:[^@]+@)?[^/:]+[:/](.+?)(?:\.git)?\/?$/i);
  return match ? match[1] : null;
};

// the renderer polls with its refresh loop (4s) — cache so GitLab sees a request
// only every ~15s, and cache failures too so a broken API isn't hammered
let ciCache = { key: null, at: 0, data: null };
ipcMain.handle('ci:pipelines', async () => {
  if (!git) return null;
  try {
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((remote) => remote.name === 'origin') || remotes[0];
    const url = origin && (origin.refs.fetch || origin.refs.push);
    const remote = parseRemoteHost(url);
    const project = parseProjectPath(url);
    const account = remote && project
      ? accounts.find((acc) => acc.host === remote.host && acc.flavor === 'gitlab') : null;
    if (!account) return null;
    const key = `${remote.host}/${project}`;
    if (ciCache.key === key && Date.now() - ciCache.at < 15000) return ciCache.data;
    ciCache = { key, at: Date.now(), data: null };
    const apiBase = remote.host === 'gitlab.com' ? GL_API_BASE : `https://${remote.host}/api/v4`;
    const headers = { Authorization: `Bearer ${await freshToken(account)}` };
    const response = await fetch(
      `${apiBase}/projects/${encodeURIComponent(project)}/pipelines?per_page=60`,
      { headers, signal: AbortSignal.timeout(8000) }
    );
    if (!response.ok) return null;
    const list = await response.json();
    const data = list.map(({ id, sha, status, ref, web_url }) => ({ id, sha, status, ref, webUrl: web_url }));
    // job-level progress for pipelines still moving — top few only, one extra call each
    await Promise.all(data.filter((pipeline) => pipeline.status === 'running').slice(0, 3).map(async (pipeline) => {
      try {
        const jobsResponse = await fetch(
          `${apiBase}/projects/${encodeURIComponent(project)}/pipelines/${pipeline.id}/jobs?per_page=100`,
          { headers, signal: AbortSignal.timeout(8000) }
        );
        if (!jobsResponse.ok) return;
        const jobs = await jobsResponse.json();
        const active = jobs.find((job) => job.status === 'running');
        pipeline.progress = {
          done: jobs.filter((job) => ['success', 'failed', 'canceled', 'skipped'].includes(job.status)).length,
          total: jobs.length,
          job: active ? active.name : null,
          stage: active ? active.stage : null
        };
      } catch { /* progress is a bonus — the plain dot still renders */ }
    }));
    ciCache.data = data;
    return ciCache.data;
  } catch { return null; } // CI display is best-effort — never surface as an app error
});

ipcMain.handle('repos:list', () => ({ repos: config.repos, current: repoPath || null }));

// re-checked on every call so "Try again" reflects a fix without restarting
ipcMain.handle('app:checkGit', () => new Promise((resolve) => {
  execFile('git', ['--version'], (error, stdout) => {
    resolve(error ? { ok: false } : { ok: true, version: String(stdout).trim() });
  });
}));

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('app:openExternal', (_event, url) => {
  if (typeof url === 'string' && url.startsWith('https://')) return shell.openExternal(url);
});

ipcMain.handle('repos:select', (_event, dir) => {
  if (!isGitRepo(dir)) throw new Error(`Not a git repository: ${dir}`);
  setRepo(dir);
  config.current = dir;
  saveConfig();
});

ipcMain.handle('repos:add', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose a git repository',
    properties: ['openDirectory']
  });
  const chosen = result.filePaths[0];
  if (result.canceled || !chosen) return null;
  if (!isGitRepo(chosen)) throw new Error('That folder is not a git repository');
  if (!config.repos.includes(chosen)) config.repos.push(chosen);
  setRepo(chosen);
  config.current = chosen;
  saveConfig();
  return chosen;
});

ipcMain.handle('repos:remove', (_event, dir) => {
  config.repos = config.repos.filter((repo) => repo !== dir);
  if (config.current === dir) config.current = config.repos[0] || null;
  if (repoPath === dir && config.repos.length > 0) setRepo(config.repos[0]);
  saveConfig();
});

ipcMain.handle('git:overview', async () => {
  if (!git) throw new Error('No repository selected — use the repo menu to add one.');
  const [graphRaw, status, branch, remote, tags, stashes, incoming] = await Promise.all([
    // one interleaved DAG across all branches (NOT --all: that would pull in
    // refs/stash); %P carries parent hashes for the renderer's lane layout
    git.raw(['log', '--branches', '--remotes', '--tags', '--date-order', '--max-count=60',
      '--format=%H%x1f%P%x1f%aI%x1f%an%x1f%D%x1f%s']).catch(() => ''),
    git.status(),
    git.branchLocal(),
    git.branch(['-r']).catch(() => ({ all: [] })),
    git.tags().catch(() => ({ all: [] })),
    git.stashList().catch(() => ({ all: [] })),
    // fetched but not yet pulled; no upstream configured is not an error
    git.log(['HEAD..@{upstream}']).catch(() => ({ all: [] }))
  ]);
  // simple-git results carry methods, which structured clone rejects — return plain data
  const log = String(graphRaw).split('\n').filter(Boolean).map((line) => {
    const [hash, parents, date, author_name, refs, message] = line.split('\x1f');
    return { hash, parents: (parents || '').split(' ').filter(Boolean), date, author_name, refs: refs || '', message };
  });
  return {
    repoPath,
    log,
    incoming: incoming.all.map(({ hash }) => hash),
    status: {
      ahead: status.ahead,
      behind: status.behind,
      tracking: status.tracking,
      files: status.files.map(({ path: filePath, index, working_dir }) => ({ path: filePath, index, working_dir }))
    },
    branch: { current: branch.current, all: branch.all },
    remoteBranches: remote.all.filter((name) => !name.includes('->')),
    tags: tags.all,
    stashes: (stashes.all || []).map(({ message, date }) => ({ message, date }))
  };
});

ipcMain.handle('git:fetch', () => remoteAction((remote) => remote.fetch()));
ipcMain.handle('git:pull', () => remoteAction((remote) => remote.pull()));
ipcMain.handle('git:push', () => remoteAction((remote) => remote.push()));
ipcMain.handle('git:createBranch', (_event, name) => git.checkoutLocalBranch(name));
// checking out a name that only exists as origin/<name> makes git create the
// local tracking branch automatically
ipcMain.handle('git:checkout', (_event, name) => git.checkout(name));
ipcMain.handle('git:deleteBranch', (_event, name, force) => git.branch([force ? '-D' : '-d', name]));
// tags a specific commit when hash is given, else HEAD
ipcMain.handle('git:createTag', (_event, name, hash) => git.tag(hash ? [name, hash] : [name]));
ipcMain.handle('git:deleteTag', (_event, name) => git.tag(['-d', name]));
// tags don't ride along with branch pushes — they get their own, auth-aware push
ipcMain.handle('git:pushTag', (_event, name) => remoteAction((remote) => remote.push(['origin', name])));
ipcMain.handle('git:stash', () => git.stash(['push', '-u']));
// index = position in the overview's stash list, which mirrors stash@{n} order
ipcMain.handle('git:stashPop', (_event, index) => git.stash(['pop', `stash@{${index}}`]));
ipcMain.handle('git:stashDrop', (_event, index) => git.stash(['drop', `stash@{${index}}`]));
// --include-untracked because the stash button runs `stash push -u`; plain
// `stash show -p` would silently omit those files (flag needs git >= 2.32)
ipcMain.handle('git:stashDiff', (_event, index) =>
  git.raw(['stash', 'show', '-p', '--include-untracked', `stash@{${index}}`]));

ipcMain.handle('git:commitDetail', async (_event, hash) => {
  // \x1f (unit separator) can't appear in author names or messages
  const meta = (await git.show([hash, '--no-patch', '--format=%an%x1f%ae%x1f%aI%x1f%B']))
    .split('\x1f');
  const numstat = await git.show([hash, '--numstat', '--format=']);
  const files = numstat.split('\n').filter(Boolean).map((line) => {
    const [added, removed, filePath] = line.split('\t');
    return { path: filePath, added, removed }; // "-" for binary files
  });
  return { author: meta[0], email: meta[1], date: meta[2], body: (meta[3] || '').trim(), files };
});

ipcMain.handle('git:fileDiff', (_event, hash, filePath) =>
  git.show([hash, '--format=', '--patch', '--', filePath]));

// diff of a working-tree file: staged compares index→HEAD, unstaged worktree→index.
// Untracked files have nothing in the index to diff against, so synthesize one.
ipcMain.handle('git:workingDiff', async (_event, filePath, staged, untracked) => {
  if (untracked) {
    let content;
    try { content = fs.readFileSync(path.join(repoPath, filePath)); } catch { return ''; }
    if (content.includes(0)) return `diff --git a/${filePath} b/${filePath}\nnew file (binary)\n`;
    const lines = content.toString('utf8').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return [
      `diff --git a/${filePath} b/${filePath}`,
      'new file (not yet tracked)',
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
      ''
    ].join('\n');
  }
  return git.diff([...(staged ? ['--cached'] : []), '--', filePath]);
});

ipcMain.handle('git:stage', (_event, paths) => git.add(paths));
// discard unstaged changes: tracked files revert to the index; untracked files
// have nothing to revert to — they are deleted from disk
ipcMain.handle('git:discard', (_event, filePath, untracked) => {
  if (untracked) return fs.promises.rm(path.join(repoPath, filePath), { force: true });
  return git.raw(['restore', '--', filePath]);
});
// discard every unstaged change at once: one restore for the tracked files,
// then the untracked ones are removed from disk
ipcMain.handle('git:discardAll', async (_event, tracked, untracked) => {
  if (tracked.length) await git.raw(['restore', '--', ...tracked]);
  for (const filePath of untracked) {
    await fs.promises.rm(path.join(repoPath, filePath), { recursive: true, force: true });
  }
});
// `restore --staged` unstages both modified and newly-added files without touching the worktree
ipcMain.handle('git:unstage', (_event, paths) => git.raw(['restore', '--staged', '--', ...paths]));
ipcMain.handle('git:commit', (_event, message) => git.commit(message));

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // no File/Edit/View/Window — the app doesn't use it
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#10131b',
    // dev-mode window/taskbar icon; packaged builds use the icon embedded in the exe
    icon: path.join(__dirname, 'build', 'icon.ico'),
    show: false, // shown once maximized, so the small default frame never flashes
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  win.maximize();
  win.show();
  // the default menu carried these accelerators — keep the useful ones alive
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') win.webContents.toggleDevTools();
    if (input.key.toLowerCase() === 'r' && input.control && !input.alt) win.webContents.reload();
  });
  win.loadFile('renderer/index.html');
});

app.on('window-all-closed', () => app.quit());
