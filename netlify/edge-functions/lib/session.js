// Signed cookies for the sign-in session and the short-lived OAuth state.
// Values are base64url(JSON) plus an HMAC-SHA256 signature keyed by
// SESSION_SECRET. Nothing in them is secret, but nothing can be forged.

const encoder = new TextEncoder()

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

async function key(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export async function sign(value, secret) {
  const body = b64url(encoder.encode(JSON.stringify(value)))
  const sig = await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(body))
  return `${body}.${b64url(sig)}`
}

/** The signed value, or null if it is missing, tampered with or expired. */
export async function verify(token, secret) {
  if (!token || !secret) return null
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  try {
    const ok = await crypto.subtle.verify('HMAC', await key(secret), fromB64url(sig), encoder.encode(body))
    if (!ok) return null
    const value = JSON.parse(new TextDecoder().decode(fromB64url(body)))
    return value.exp && value.exp > Date.now() ? value : null
  } catch {
    return null
  }
}

export function readCookie(request, name) {
  const header = request.headers.get('cookie') || ''
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=')
  }
  return null
}

export function cookie(name, value, maxAgeSeconds) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`
}

export function randomToken(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

export async function sha256(text) {
  return b64url(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
}

export function decodeJwtPayload(jwt) {
  return JSON.parse(new TextDecoder().decode(fromB64url(jwt.split('.')[1])))
}

/** Same-site paths only, so ?next= can't send someone to another site. */
export function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/'
}

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
