// Sign-in for the gated parts of the UX and Design noticeboard (site visits),
// ported from the Pulse docs gate. GitHub (members of the nourishcare
// organisation), Microsoft (Nourish's Entra ID tenant) or the shared password. Each provider turns on when its
// environment variables are set in Netlify:
//
//   SESSION_SECRET                       signs session cookies (required for either)
//   GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_ORG (default nourishcare)
//   MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET
//
// The OAuth redirect URIs to register are <site>/auth/github/callback and
// <site>/auth/microsoft/callback. SITE_PASSWORD, if set, stays as a fallback.
import { cookie, decodeJwtPayload, randomToken, readCookie, safeNext, sha256, sign, timingSafeEqual, verify } from './session.js'

export const SESSION_COOKIE = 'uxd_session'
const STATE_COOKIE = 'uxd_oauth'
const SESSION_DAYS = 14
const env = (name) => Netlify.env.get(name) || ''

export function providers() {
  return {
    github: Boolean(env('GITHUB_CLIENT_ID') && env('GITHUB_CLIENT_SECRET') && env('SESSION_SECRET')),
    microsoft: Boolean(env('MS_TENANT_ID') && env('MS_CLIENT_ID') && env('MS_CLIENT_SECRET') && env('SESSION_SECRET')),
    password: Boolean(env('SITE_PASSWORD')),
  }
}

export async function currentUser(request) {
  return verify(readCookie(request, SESSION_COOKIE), env('SESSION_SECRET'))
}

export function passwordMatches(request) {
  const password = env('SITE_PASSWORD')
  const header = request.headers.get('authorization') || ''
  if (!password || !header.startsWith('Basic ')) return false
  try {
    return timingSafeEqual(atob(header.slice(6)).split(':').slice(1).join(':'), password)
  } catch {
    return false
  }
}

async function startSession(user, next) {
  const exp = Date.now() + SESSION_DAYS * 86400_000
  const token = await sign({ ...user, exp }, env('SESSION_SECRET'))
  const headers = new Headers({ Location: safeNext(next), 'Cache-Control': 'no-store' })
  headers.append('Set-Cookie', cookie(SESSION_COOKIE, token, SESSION_DAYS * 86400))
  headers.append('Set-Cookie', cookie(STATE_COOKIE, '', 0))
  return new Response(null, { status: 302, headers })
}

const redirectUri = (url, provider) => `${url.origin}/auth/${provider}/callback`

/** Handles /auth/*. Returns a Response, or null if the path isn't an auth route. */
export async function handleAuth(request, url) {
  const [, , provider, step] = url.pathname.split('/') // /auth/<provider>/<step>
  const available = providers()

  if (provider === 'signout') {
    const headers = new Headers({ Location: safeNext(url.searchParams.get('next')), 'Cache-Control': 'no-store' })
    headers.append('Set-Cookie', cookie(SESSION_COOKIE, '', 0))
    return new Response(null, { status: 302, headers })
  }

  if (provider === 'password') {
    if (!available.password) return signInPage(url, 'Password sign-in is turned off.')
    if (!passwordMatches(request)) {
      return new Response('Password required.', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="UX and Design site visits", charset="UTF-8"', 'Cache-Control': 'no-store' },
      })
    }
    if (!env('SESSION_SECRET')) return new Response(null, { status: 302, headers: { Location: safeNext(url.searchParams.get('next')) } })
    return startSession({ sub: 'password', name: 'Shared password', provider: 'password' }, url.searchParams.get('next'))
  }

  if (!['github', 'microsoft'].includes(provider) || !available[provider]) return null

  if (step === 'start') {
    const state = randomToken()
    const verifier = randomToken(48)
    const nonce = randomToken()
    const next = safeNext(url.searchParams.get('next'))
    const signed = await sign({ state, verifier, nonce, next, provider, exp: Date.now() + 10 * 60_000 }, env('SESSION_SECRET'))
    let location
    if (provider === 'github') {
      location = new URL('https://github.com/login/oauth/authorize')
      location.search = new URLSearchParams({
        client_id: env('GITHUB_CLIENT_ID'),
        redirect_uri: redirectUri(url, 'github'),
        scope: 'read:org user:email',
        state,
        allow_signup: 'false',
      })
    } else {
      location = new URL(`https://login.microsoftonline.com/${env('MS_TENANT_ID')}/oauth2/v2.0/authorize`)
      location.search = new URLSearchParams({
        client_id: env('MS_CLIENT_ID'),
        response_type: 'code',
        redirect_uri: redirectUri(url, 'microsoft'),
        response_mode: 'query',
        scope: 'openid profile email',
        state,
        nonce,
        code_challenge: await sha256(verifier),
        code_challenge_method: 'S256',
      })
    }
    return new Response(null, {
      status: 302,
      headers: { Location: location.toString(), 'Set-Cookie': cookie(STATE_COOKIE, signed, 600), 'Cache-Control': 'no-store' },
    })
  }

  if (step === 'callback') {
    const saved = await verify(readCookie(request, STATE_COOKIE), env('SESSION_SECRET'))
    const code = url.searchParams.get('code')
    if (!saved || saved.provider !== provider || saved.state !== url.searchParams.get('state') || !code) {
      return signInPage(url, 'That sign-in link expired or was already used. Try again.')
    }
    try {
      const user = provider === 'github' ? await githubUser(code, url) : await microsoftUser(code, url, saved)
      return startSession(user, saved.next)
    } catch (error) {
      return signInPage(url, error.message || 'Sign-in failed. Try again.', saved.next)
    }
  }
  return null
}

function onTeamList(login, emails) {
  try {
    const team = JSON.parse(env('VISITS_TEAM') || '[]')
    const handle = String(login || '').toLowerCase()
    return team.some((m) => (m.github && m.github.toLowerCase() === handle) || (m.email && emails.includes(m.email.toLowerCase())))
  } catch {
    return false
  }
}

async function githubUser(code, url) {
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env('GITHUB_CLIENT_ID'),
      client_secret: env('GITHUB_CLIENT_SECRET'),
      code,
      redirect_uri: redirectUri(url, 'github'),
    }),
  })
  const { access_token } = await tokenRes.json()
  if (!access_token) throw new Error('GitHub didn’t confirm the sign-in. Try again.')
  const gh = (path) =>
    fetch(`https://api.github.com${path}`, {
      headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'uxd-noticeboard' },
    })
  const me = await (await gh('/user')).json()
  // Verified emails let the site visits page match people to the team list
  // when their GitHub handle isn't on it.
  const emailsRes = await gh('/user/emails')
  const emails = emailsRes.ok
    ? (await emailsRes.json()).filter((e) => e.verified).map((e) => String(e.email).toLowerCase()).slice(0, 10)
    : []

  // People on the team list (VISITS_TEAM) get in on that alone: it's a stricter
  // allow-list than organisation membership, and it doesn't need an organisation
  // owner to approve this app. Anyone else must be an active nourishcare member.
  if (!onTeamList(me.login, emails)) {
    const org = env('GITHUB_ORG') || 'nourishcare'
    const membership = await gh(`/user/memberships/orgs/${org}`)
    const state = membership.ok ? (await membership.json()).state : null
    if (state !== 'active') {
      throw new Error(`Site visits are for the UX and Design team. Your GitHub account (${me.login}) isn’t on the team list, so ask Zahra to add it, or use the shared password.`)
    }
  }
  return { sub: `github:${me.id}`, name: me.name || me.login, login: me.login, emails, provider: 'github' }
}

async function microsoftUser(code, url, saved) {
  const tenant = env('MS_TENANT_ID')
  const tokenRes = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env('MS_CLIENT_ID'),
      client_secret: env('MS_CLIENT_SECRET'),
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(url, 'microsoft'),
      code_verifier: saved.verifier,
    }),
  })
  const { id_token } = await tokenRes.json()
  if (!id_token) throw new Error('Microsoft didn’t confirm the sign-in. Try again.')
  // The token comes straight from Microsoft's token endpoint over TLS, in
  // exchange for our client secret, so its claims are checked rather than
  // its signature (OpenID Connect Core 3.1.3.7).
  const claims = decodeJwtPayload(id_token)
  if (claims.aud !== env('MS_CLIENT_ID') || claims.tid !== tenant || claims.nonce !== saved.nonce || claims.exp * 1000 < Date.now()) {
    throw new Error('Site visits are for Nourish Microsoft accounts only.')
  }
  return {
    sub: `microsoft:${claims.oid}`,
    name: claims.name || claims.preferred_username,
    login: claims.preferred_username || claims.email,
    provider: 'microsoft',
  }
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** The sign-in page. It is served by the gate itself, because the site's own assets are behind it. */
export function signInPage(url, message = '', next = url.pathname + url.search) {
  const p = providers()
  const n = encodeURIComponent(safeNext(next))
  const buttons = [
    p.microsoft && `<a class="btn" href="/auth/microsoft/start?next=${n}">${MS_ICON}Sign in with Microsoft</a>`,
    p.github && `<a class="btn" href="/auth/github/start?next=${n}">${GH_ICON}Sign in with GitHub</a>`,
  ].filter(Boolean)
  const notes = [
    p.microsoft && 'Microsoft: Nourish accounts only.',
    p.github && `GitHub: members of the ${escapeHtml(env('GITHUB_ORG') || 'nourishcare')} organisation only.`,
  ].filter(Boolean)
  const body = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Sign in · Nourish UX and Design</title><link rel="icon" type="image/png" href="/assets/nourish-mark.png"><style>${CSS}</style></head><body><main class="card">
<p class="brand">UX and Design</p>
<h1>Sign in to site visits</h1>
<p class="lede">Site visits include customer names and addresses, so they're for the Nourish UX and Design team only.</p>
${message ? `<p class="error" role="alert">${escapeHtml(message)}</p>` : ''}
${buttons.length ? `<div class="buttons">${buttons.join('')}</div>` : ''}
${notes.length ? `<p class="note">${notes.join(' ')}</p>` : ''}
${p.password && buttons.length ? `<p class="fallback"><a href="/auth/password?next=${n}">Use the shared password instead</a></p>` : ''}
${p.password && !buttons.length ? `<div class="buttons"><a class="btn" href="/auth/password?next=${n}">Enter the team password</a></div>` : ''}
</main></body></html>`
  return new Response(body, { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
}

const GH_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>'
const MS_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="#f25022" d="M0 0h7.5v7.5H0z"/><path fill="#7fba00" d="M8.5 0H16v7.5H8.5z"/><path fill="#00a4ef" d="M0 8.5h7.5V16H0z"/><path fill="#ffb900" d="M8.5 8.5H16V16H8.5z"/></svg>'
const CSS = `*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f4f8f5;color:#33423a;font:16px/1.6 'Plus Jakarta Sans',system-ui,-apple-system,sans-serif}
.card{width:100%;max-width:400px;background:#fff;border-radius:12px;box-shadow:0 0 0 1px #cfe2d6,0 8px 24px -12px rgb(20 38 29/.18);padding:32px;text-align:center}
.brand{margin:0 0 8px;color:#2e5a45;font-weight:700;letter-spacing:.02em}h1{margin:0 0 6px;font-size:22px;color:#14261d}
.lede{margin:0 0 20px;color:#5f6f66;font-size:15px}.buttons{display:grid;gap:10px}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;padding:11px 16px;border-radius:8px;border:1px solid #e2ebe5;color:#14261d;text-decoration:none;font-weight:600;font-size:15px}
.btn:hover{background:#e4efe8;border-color:#cfe2d6}.btn:focus-visible,a:focus-visible{outline:none;box-shadow:0 0 0 2px #fff,0 0 0 4px #4d7d64}
.btn svg{width:18px;height:18px}.note{margin:16px 0 0;font-size:13px;color:#8a9890}
.error{margin:0 0 16px;padding:10px 12px;border-radius:8px;background:#fceceb;color:#b4342a;font-size:14px;text-align:left}
.fallback{margin:16px 0 0;font-size:13px}.fallback a{color:#2e5a45}`
