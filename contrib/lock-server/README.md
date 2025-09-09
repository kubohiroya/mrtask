# Pessimistic Lock via Git Refs (Server-side)

This folder contains a pre-receive hook that enforces pessimistic locks using Git refs.

- Lock namespace: `refs/mrtask/sem/<key>/<owner>@<expiryEpoch>/<nonce>`
- Policy: `.mrtask/lock-policy.json` inside the repository describes which paths require which lock key(s).
- Enforcement: pushes that modify protected paths are allowed only if the pusher holds a valid (non-expired) lock token for the key. Capacity and admin override are supported.

## Install (bare repository on server)

1) Copy `pre-receive.js` into `~/repositories/<repo>.git/hooks/pre-receive` and make it executable:

```bash
scp contrib/lock-server/pre-receive.js user@server:/path/to/repo.git/hooks/pre-receive
ssh user@server 'chmod +x /path/to/repo.git/hooks/pre-receive'
```

2) Ensure Node.js ≥ 18 is available on the server.

3) Commit a `.mrtask/lock-policy.json` to your repo (example below).

## Policy format (.mrtask/lock-policy.json)

```json
{
  "version": 1,
  "admins": ["admin", "ci"],
  "keys": {
    "pnpm-lock": {
      "patterns": ["pnpm-lock.yaml"],
      "capacity": 1,
      "ttlSeconds": 7200
    },
    "shared": {
      "patterns": ["packages/shared/**"],
      "capacity": 1,
      "ttlSeconds": 3600
    }
  }
}
```

- `patterns`: glob rules (simple `**`, `*`, `?`, leading `!` excludes)
- `capacity`: max simultaneous holders
- `ttlSeconds`: lock expiry (server treats expired tokens as invalid)
- `admins`: server usernames allowed to bypass capacity and delete others' tokens

## Client: acquire / release (no extra tooling required)

- Acquire (create token):

```bash
OWNER="$USER"  # or your Git server username
KEY="pnpm-lock"
EXP="$(($(date +%s)+3600))"  # 1h
NONCE="$(uuidgen | tr 'A-Z' 'a-z' | tr -d '-')"
REF="refs/mrtask/sem/$KEY/$OWNER@$EXP/$NONCE"
# Point the ref to current HEAD (any reachable object is fine)
git push origin HEAD:$REF
```

- Release (delete your tokens for a key):

```bash
for r in $(git ls-remote --refs origin "refs/mrtask/sem/$KEY/$OWNER@*/"); do
  ref=${r#*\t}
  git push origin ":$ref"
done
```

If capacity is exceeded or you try to delete someone else's token, the hook will reject unless you are an admin or the token expired.

## Behavior

- For each pushed update to `refs/heads/*`, the hook computes the changed files. If any file matches a policy key's patterns, the pusher must have a valid token for that key.
- For updates under `refs/mrtask/sem/*` (lock namespace):
  - Creation is rejected if active tokens for the key already reached `capacity` and pusher is not admin.
  - Deletion is allowed by owner or admin, or if token already expired.
- Pusher identity is taken from common env vars (Gitea/GitLab/Gitolite). See script for details.

Limitations
- GitHub.com does not allow custom server hooks; use optimistic guards instead. GitHub Enterprise Server supports pre-receive hooks.
- Exact pusher env var names depend on your host (Gitea: `GITEA_PUSHER_NAME`, GitLab: `GL_USERNAME`).

