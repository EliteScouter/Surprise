# Cosmonym roadmap

Listed in build order. Each step depends on the ones above it.

## 1. MariaDB support
- [ ] Create a `cosmonym` database and user on the Galera cluster (10.10.20.120)
- [ ] Tables: `worlds`, `stars` (one row per user per world), `users`, `sessions`, `reports`, `audit_log`
- [ ] Swap the JSON-file storage in `server.js` for MariaDB queries (claims, stars and edits write one row each)
- [ ] One-time import of existing claimed worlds from `/data/worlds.json`
- [ ] DB credentials go in the Portainer stack environment, never in the repo
- [ ] Compressed, cached galaxy map endpoint so visitors don't download every world uncompressed
- [ ] Faster marker hover-picking in the galaxy so it stays smooth with 100k+ worlds

## 2. Rate limiting
- [ ] Stop trusting a client-supplied `X-Forwarded-For`. Take the visitor's IP from Cloudflare's `CF-Connecting-IP`, and only when the request arrives from the reverse proxy's address
- [ ] Lock port 8089 so only the reverse proxy can reach it (otherwise people can skip Cloudflare and the limits)
- [ ] Limits per account as well as per IP (claims, stars, edits, logins, sign-ups)
- [ ] Store counters in the DB so they survive restarts
- [ ] Brute-force protection on login and 2FA (lockout + backoff)
- [ ] Rebuild the bad-word filter: proper number/lookalike-character handling, a much larger list, allow innocent words (Hancock, Grape, Scunthorpe)
- [ ] "Report this world" button for visitors

## 3. Accounts and profiles
- [ ] Sign-in required to claim (anyone can still browse and grow worlds without an account)
- [ ] Email + password (strong hashing, email verification, password reset)
- [ ] Single sign-on: Google, Discord, Apple, Microsoft, GitHub
- [ ] Optional 2FA for regular users
- [ ] Public profile page `/u/<name>`: avatar, worlds discovered, rarest find, stars received
- [ ] On first sign-in, offer to attach worlds claimed in this browser before accounts existed
- [ ] Secure session cookies, sign out everywhere, delete my account

## 4. Admin panel
- [ ] Hidden URL set by an environment variable, not in the code or repo
- [ ] Admin login: password + **mandatory authenticator-app 2FA**, no exceptions
- [ ] Optional IP allowlist (e.g. home/VPN only), short sessions, re-prompt 2FA for destructive actions
- [ ] Browse/search all claimed worlds: name, discoverer, message, rarity, type, stars, views, date, account
- [ ] View and manage users: ban, unban, rename
- [ ] Review queue for reported worlds
- [ ] Remove or rename a world, edit its message
- [ ] Stats dashboard: claims per day, sign-ups, active users, rarity breakdown
- [ ] Every admin action written to the audit log

## 5. Leaderboards
- [ ] Rarest worlds (all time / this week)
- [ ] Most-starred worlds (all time / this week)
- [ ] Top discoverers (most worlds, most stars, most Mythics)
- [ ] "Firsts" hall of fame: first Mythic ever, first megastructure, etc.
- [ ] Live counters: "Only N anomaly worlds have ever been claimed"

## 6. Visible civilisations
Make worlds with life feel inhabited from orbit. Detail should grow with the civilisation level:
- [ ] **Early:** sparse firelight specks along rivers and coasts on the night side
- [ ] **Industrial:** city clusters, faint smog haze, patchwork farmland tint on the day side
- [ ] **Planetary:** glowing road/rail networks linking cities, lit shipping lanes across oceans, grey urban sprawl on the day side
- [ ] **Spacefaring:** tiny satellites and stations orbiting as moving points of light, launch flares, a space elevator
- [ ] **Advanced:** orbital ring megastructure, Dyson-swarm glints around the sun
- [ ] Cities sit on coastlines, rivers and temperate land, and avoid ice, deserts and peaks
- [ ] Species-specific light colour (warm amber, cool blue, alien green)
- [ ] Dossier shows the civilisation stage and a line of lore about it

## 7. Share window
- [ ] Share dialog with buttons: X, Facebook, Reddit, WhatsApp, Telegram, Bluesky, Threads, LinkedIn, email, copy link
- [ ] Native phone share sheet where available
- [ ] Per-world preview image (the planet itself) so links show the world in previews
- [ ] Download postcard from the same dialog
- [ ] Pre-written share text that includes the world's rarity

## Security

### Already fixed (live)
Found by attacking the running app, then verified blocked:
- [x] Spoofed `X-Forwarded-For` let anyone bypass every rate limit → forwarding headers are now only trusted from configured proxies (`TRUSTED_PROXIES`)
- [x] Clients could choose their own rarity ("Mythic" on any rock) → rarity is computed server-side from the name
- [x] The Forge could stack rare phenomena to fake a Mythic → rarity is locked to the name's original DNA, not the forged one
- [x] Cross-site forgery: any website could make visitors star or claim worlds → JSON-only + Origin check on every write
- [x] Names like `constructor` crashed lookups (JS prototype collision) → null-prototype storage
- [x] Partial/hostile DNA payloads crashed claims → every field validated, missing ones filled from the name
- [x] Right-to-left override and zero-width characters could disguise names → stripped
- [x] Look-alike letters from other scripts (Cyrillic "а" as Latin "a") → names limited to Latin script, digits, simple punctuation
- [x] IP hashes used a fixed salt (reversible for all IPv4) → keyed HMAC with a per-install secret
- [x] Unlimited live-stream connections (connection exhaustion) → 6 per IP, 5,000 total
- [x] Slow-drip requests (slowloris) → header/request timeouts
- [x] Galaxy-wide claim ceiling (3,000/hour) as a flood safety valve
- [x] Security headers: strict Content-Security-Policy, HSTS (preload-ready), X-Frame-Options DENY, Permissions-Policy, COOP/CORP, nosniff
- [x] Only the needed parts of three.js are served; dotfiles and path traversal return 404
- [x] Malformed JSON and unknown methods return 400/405 instead of 500
- [x] Container: non-root user, read-only filesystem, all Linux capabilities dropped, no-new-privileges, memory/CPU/process limits, npm removed from the image, OS packages upgraded at build

### 1. SQL injection (do with the MariaDB step)
- [ ] Parameterized queries only (`mysql2` `execute()` with `?` placeholders); never build SQL from strings
- [ ] Sort columns and directions picked from a fixed allowlist, never passed through
- [ ] Escape `%` and `_` in user search terms used with `LIKE`
- [ ] App DB user gets only `SELECT, INSERT, UPDATE, DELETE` on `cosmonym.*`. No `FILE`, `GRANT`, `SUPER`, DDL or access to other schemas
- [ ] Separate migration user for schema changes, not used at runtime
- [ ] `sql_mode` strict (`STRICT_ALL_TABLES`), `utf8mb4` everywhere
- [ ] TLS between app and DB, verify the server certificate
- [ ] CI check that fails the build on string-built SQL (grep/lint rule)
- [ ] Automated injection tests (sqlmap-style payloads) against every endpoint before launch

### 2. Keep attackers out of the infrastructure
- [x] Bypassing Cloudflare (hitting the public IP with `Host: cosmonym.app`) can't fake an IP: the gate only believes `CF-Connecting-IP` when NPM received the request from a Cloudflare edge (checked via NPM's `X-Real-IP`)
- [ ] Refresh the Cloudflare ranges in `gate/default.conf.template` if https://www.cloudflare.com/ips/ ever changes (rare)
- [x] Gate container (nginx) is the only exposed piece; it believes `CF-Connecting-IP` only from NPM (10.0.101.1) and overwrites it for everyone else
- [x] App trusts forwarded IPs only from the gate's private subnet; `PUBLIC_ORIGINS` defaults to https://cosmonym.app
- [ ] Flip the gate to NPM-only (`GATE_ALLOW=10.0.101.1` in the stack env) once cosmonym.app is live in NPM
- [x] App container has no network route out at all (internal-only Docker network); verified it can't reach Portainer, the Docker agent, NPM, the LAN or the internet
- [ ] When MariaDB arrives: a relay that allows exactly one destination (the DB on 3306)
- [x] Dedicated Docker networks for Cosmonym, not shared with other stacks
- [ ] Portainer and the Docker API never reachable from the internet; Portainer admin behind VPN + 2FA
- [ ] Portainer agent on E-Docker01 (:9001) listens on every interface; restrict it to the Portainer host (10.10.20.26) with a host firewall rule
- [ ] Other stacks on E-Docker01 publish ports on 0.0.0.0; give them the same gate/internal-network treatment
- [ ] No Docker socket mounted into the app container (already true; keep it that way)
- [ ] Rotate the Portainer API token used for deploys; store it outside shell profiles
- [ ] Host patching schedule for E-Docker01 and the DB nodes; rebuild the image monthly for base-image patches
- [ ] Container image vulnerability scan on every build (Trivy or Docker Scout)
- [ ] `npm audit` + Dependabot on the GitHub repo
- [ ] Cloudflare WAF managed rules on, bot fight mode, rate-limit rules at the edge for `/api/*`
- [ ] Off-host, encrypted, versioned backups of the DB and `secret.key`; test a restore
- [ ] Centralised logs with alerts on spikes in 4xx/5xx, 429s and admin logins

### 3. Standards and encryption
- [ ] Cloudflare SSL mode **Full (strict)**, minimum TLS 1.2, TLS 1.3 on, HSTS + preload (`.app` already enforces HTTPS)
- [ ] Origin certificate: Let's Encrypt on the reverse proxy, auto-renew, OCSP stapling
- [ ] Passwords hashed with Argon2id (or scrypt), per-user salt, never logged
- [ ] Sessions: random 256-bit IDs in `__Host-` cookies, `Secure`, `HttpOnly`, `SameSite=Lax`, rotated on login, server-side revocation
- [ ] TOTP 2FA per RFC 6238, secrets encrypted at rest, single-use backup codes, replay protection
- [ ] OAuth/OIDC sign-in with PKCE + `state` + `nonce`; verify ID-token signatures and audience
- [ ] Secrets (DB password, session key, OAuth secrets, TOTP encryption key) only in the stack env / secret store, never in git
- [ ] Encrypt sensitive columns at rest (emails, TOTP secrets) with an app-held key
- [ ] Check new passwords against known-breached lists (HaveIBeenPwned k-anonymity API)
- [ ] Measure against **OWASP ASVS Level 2** and the **OWASP Top 10** before launch
- [ ] GDPR/CCPA: privacy policy, cookie notice (only essential cookies), data export and account deletion, data-retention limits
- [ ] `security.txt` with a contact for responsible disclosure
- [ ] External penetration test (or a paid bug bounty) before a big public launch

## Also discussed (not yet scheduled)
- [ ] Domain: buy cosmonym.app, route Cloudflare proxy → your reverse proxy (Let's Encrypt) → host :8089, update share links to the new domain
- [ ] Rarity rebalance: Legendary ~1 in 2,000, Mythic ~1 in 25,000
- [ ] One-in-a-million anomaly worlds (black hole companion, Dyson swarm, shattered planet, crystal world, glitch world)
- [ ] Gift a world: claim a planet for someone and send it as a card
