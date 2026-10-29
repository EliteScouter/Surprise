# Cosmonym setup: sign-in providers, email, and the first admin

Every value below goes into **Portainer → Stacks → worldseed → Editor → Environment variables**.
Never commit them. After adding values, redeploy the stack (or ask Claude to).

Redirect URIs must match exactly, including `https://` and no trailing slash.

---

## 1. Google sign-in (do this first: it unlocks the admin panel)

1. Go to <https://console.cloud.google.com>, create a project called **Cosmonym**.
2. **APIs & Services → OAuth consent screen**
   - User type **External**, app name **Cosmonym**, your support email.
   - Authorized domain: `cosmonym.app`.
   - Scopes: `openid`, `email`, `profile` (all non-sensitive, so no Google review needed).
   - Publish the app (**In production**), otherwise only test users can sign in.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Type **Web application**, name **Cosmonym**.
   - Authorized redirect URI: `https://cosmonym.app/api/auth/oauth/google/callback`
4. Copy the values into the stack env:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`

## 2. Discord sign-in

1. Go to <https://discord.com/developers/applications> → **New Application** → **Cosmonym**.
2. **OAuth2 → Redirects → Add**: `https://cosmonym.app/api/auth/oauth/discord/callback`
3. Copy **Client ID**, then **Reset Secret** and copy it:
   - `DISCORD_CLIENT_ID`
   - `DISCORD_CLIENT_SECRET`

## 3. Microsoft sign-in (Outlook, Xbox, work and school accounts)

1. Go to <https://entra.microsoft.com> → **App registrations → New registration**.
   - Name **Cosmonym Sign-in**.
   - Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**.
   - Redirect URI: platform **Web**, `https://cosmonym.app/api/auth/oauth/microsoft/callback`
2. **Certificates & secrets → New client secret** (24 months). Copy the **Value** (not the Secret ID).
3. Stack env:
   - `MICROSOFT_CLIENT_ID` = Application (client) ID
   - `MICROSOFT_CLIENT_SECRET` = the secret value

Cosmonym never trusts Microsoft's email claim to merge accounts, because Microsoft
doesn't verify it. Microsoft sign-ins always get their own account.

## 4. Email from noreply@cosmonym.app (Microsoft 365)

### 4a. Domain and mailbox
1. **M365 admin center → Settings → Domains → Add domain** → `cosmonym.app`, and add the records it asks for in Cloudflare.
   Set them to **DNS only** (grey cloud). At minimum:
   - SPF (TXT on `cosmonym.app`): `v=spf1 include:spf.protection.outlook.com -all`
   - DKIM: the two `selector1._domainkey` / `selector2._domainkey` CNAMEs, then turn DKIM on in Microsoft Defender
   - DMARC (TXT on `_dmarc`): `v=DMARC1; p=quarantine; adkim=s; aspf=s`
2. **Exchange admin center → Recipients → Mailboxes → Add a shared mailbox** → `noreply@cosmonym.app`.
   Shared mailboxes need no license.

### 4b. An app that can send only as that mailbox
1. **Entra → App registrations → New registration** → **Cosmonym Mail**, single tenant, no redirect URI.
2. **Certificates & secrets → New client secret**, copy the value.
3. Note the **Application (client) ID**, the **Directory (tenant) ID**, and, under
   **Enterprise applications → Cosmonym Mail**, its **Object ID**.
4. **Do not** add Mail.Send under *API permissions* (that would allow sending as anyone).
   Instead, scope it to the one mailbox with Exchange Online PowerShell:

   ```powershell
   Connect-ExchangeOnline
   New-ServicePrincipal -AppId <Application ID> -ObjectId <Enterprise app Object ID> -DisplayName "Cosmonym Mail"
   New-ManagementScope -Name "Cosmonym noreply" -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'noreply@cosmonym.app'"
   New-ManagementRoleAssignment -App <Application ID> -Role "Application Mail.Send" -CustomResourceScope "Cosmonym noreply"
   Test-ServicePrincipalAuthorization -Identity <Application ID> -Resource noreply@cosmonym.app
   ```

   The last command should show `InScope: True`.
5. Stack env:
   - `MAIL_TENANT_ID` = Directory (tenant) ID
   - `MAIL_CLIENT_ID` = Application (client) ID
   - `MAIL_CLIENT_SECRET` = the secret value
   - `MAIL_FROM` = `noreply@cosmonym.app` (already the default)

## 5. Become the first admin

The admin panel lives at `https://cosmonym.app/<ADMIN_PATH>` (see the stack env).
Only verified addresses listed in `ADMIN_EMAILS` can enroll, so an impostor can't
register your email and take the panel.

1. On cosmonym.app, **Sign in with Google** using the address in `ADMIN_EMAILS`
   (Google proves you own it). Or, once email is set up, sign up with that address
   and click the confirmation link.
2. Open **Account** (top-right menu) and **set a password**. The admin panel always
   asks for a password plus a 2FA code.
3. Go to the admin URL, sign in with that email and password, and scan the QR code
   with an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password…).
4. Enter the 6-digit code. You're in.

Optional hardening: set `ADMIN_ALLOW_IPS` to your home/VPN IP so the panel is a plain
404 from anywhere else.

## Backups

The data volume holds `app.key`, which decrypts stored emails and 2FA secrets.
Back it up together with the database. Without it, those fields can't be read.
