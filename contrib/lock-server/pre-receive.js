#!/usr/bin/env node
/*
 Pessimistic lock pre-receive hook (Node >= 18)
 - Enforces locks under refs/mrtask/sem/<key>/<owner>@<expiry>/<nonce>
 - Reads policy from .mrtask/lock-policy.json in the NEW commit of the target ref
 - Denies pushes that modify protected paths unless pusher owns a valid token
 - Denies creating lock tokens when capacity is exceeded (unless admin)
*/
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

function git(args, input) {
  const res = spawnSync('git', args, { encoding: 'utf8', input });
  if (res.status !== 0) throw new Error(res.stderr || `git ${args.join(' ')} failed`);
  return res.stdout;
}

function getPusher() {
  // Best effort across common servers
  return (
    process.env.GITEA_PUSHER_NAME ||
    process.env.GL_USERNAME ||
    process.env.GL_ID ||
    process.env.GIT_PUSHER ||
    process.env.USER ||
    'unknown'
  );
}

function parsePolicyFromTree(sha) {
  try {
    const json = git(['show', `${sha}:.mrtask/lock-policy.json`]);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function listTokens(key) {
  const out = git(['for-each-ref', '--format=%(refname)', `refs/mrtask/sem/${key}/`]);
  const now = Math.floor(Date.now() / 1000);
  const tokens = out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((r) => {
      // refs/mrtask/sem/<key>/<owner>@<expiry>/<nonce>
      const parts = r.split('/');
      const keyIdx = parts.indexOf('sem') + 1; // .../sem/<key>/...
      const ownerExp = parts[keyIdx + 1] || '';
      const [owner, expStr] = ownerExp.split('@');
      const expiry = Number(expStr || '0');
      return { ref: r, owner, expiry, valid: expiry === 0 || expiry > now };
    });
  return tokens;
}

function changedFiles(oldSha, newSha) {
  const out = git(['diff', '--name-only', `${oldSha}..${newSha}`]);
  return out.trim().split('\n').filter(Boolean);
}

function globToRegex(glob) {
  let re = '^';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        while (glob[i + 1] === '*') i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '.') re += '\\.';
    else if ('+^$()[]{}|'.includes(c)) re += '\\' + c;
    else re += c;
    i++;
  }
  re += '$';
  return new RegExp(re);
}

function anyMatch(files, patterns) {
  const inc = [];
  const exc = [];
  for (const g of patterns) {
    if (g.startsWith('!')) exc.push(globToRegex(g.slice(1)));
    else inc.push(globToRegex(g));
  }
  return files.some((f) => inc.some((r) => r.test(f)) && !exc.some((r) => r.test(f)));
}

function deny(msg) {
  console.error(`pre-receive: ${msg}`);
  process.exit(1);
}

async function main() {
  const input = fs.readFileSync(0, 'utf8').trim();
  if (!input) return; // nothing
  const pusher = getPusher();
  const lines = input.split('\n');

  // Gather updates; enforce on heads and lock refs separately
  for (const line of lines) {
    const [oldSha, newSha, ref] = line.split(' ');

    if (ref.startsWith('refs/mrtask/sem/')) {
      // Lock namespace capacity/admin enforcement based on current policy in default branch if available
      const segs = ref.split('/');
      const key = segs[4];
      const pol = parsePolicyFromTree(newSha) || parsePolicyFromTree('HEAD') || { admins: [], keys: {} };
      const cfg = pol.keys?.[key] || { capacity: 1, ttlSeconds: 0 };
      const tokens = listTokens(key).filter((t) => t.valid);
      const creating = oldSha === '0000000000000000000000000000000000000000';
      const deleting = newSha === '0000000000000000000000000000000000000000';

      const isAdmin = pol.admins?.includes(pusher);
      if (creating && tokens.length >= (cfg.capacity || 1) && !isAdmin) {
        deny(`lock '${key}' at capacity (${tokens.length}); ask admin or wait.`);
      }
      if (deleting) {
        // Only owner/admin/expired can delete; owner is parsed from ref name
        const ownerExp = segs[5] || '';
        const owner = (ownerExp.split('@')[0] || '').toLowerCase();
        if (!isAdmin && owner !== String(pusher).toLowerCase()) {
          // allow delete if expired
          const expStr = ownerExp.split('@')[1] || '0';
          const expiry = Number(expStr);
          const now = Math.floor(Date.now() / 1000);
          if (!(expiry && expiry <= now)) deny(`not owner/admin to delete token '${ref}'`);
        }
      }
      continue;
    }

    if (!ref.startsWith('refs/heads/')) continue;

    const pol = parsePolicyFromTree(newSha) || { admins: [], keys: {} };
    const files = changedFiles(oldSha, newSha);
    const keys = Object.entries(pol.keys || {});
    for (const [key, cfg] of keys) {
      if (!cfg || !cfg.patterns || cfg.patterns.length === 0) continue;
      if (!anyMatch(files, cfg.patterns)) continue;
      const tokens = listTokens(key).filter((t) => t.valid);
      const ok = tokens.some((t) => t.owner.toLowerCase() === String(pusher).toLowerCase());
      if (!ok) deny(`missing lock '${key}' for protected paths; acquire before pushing.`);
    }
  }
}

main().catch((e) => {
  console.error('pre-receive hook failed:', e);
  process.exit(1);
});

