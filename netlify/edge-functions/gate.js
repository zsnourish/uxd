// Sign-in gate for the site visits area of the UX and Design noticeboard.
// Visits carry customer names and addresses, so non-Nourish people must never
// see them. The rest of the noticeboard (Updates, Team dates) stays open.
//
// People sign in with GitHub (nourishcare members), Microsoft (if MS_* is set)
// or the shared team password (SITE_PASSWORD). See lib/auth.js. The gate fails
// closed: with no sign-in method set up, the visits area is refused.
//
// The visits API (netlify/functions/visits.mjs) checks the same session
// cookie itself, so it can't be reached around this gate.
import { currentUser, handleAuth, passwordMatches, providers, signInPage } from './lib/auth.js'

export default async (request, context) => {
  const url = new URL(request.url)
  const local = context.deploy?.context === 'dev' // `netlify dev` on this machine
  const available = providers()

  if (!local && !available.github && !available.microsoft && !available.password) {
    return new Response('Site visits are locked until a sign-in method is set up.', { status: 503 })
  }

  if (url.pathname.startsWith('/auth/')) {
    const response = await handleAuth(request, url)
    if (response) return response
    return new Response('Not found', { status: 404 })
  }

  const user = (await currentUser(request)) ?? (local ? { sub: 'local:dev', name: 'Local preview', provider: 'local' } : null)

  if (url.pathname.startsWith('/api/')) {
    if (!user) return Response.json({ error: 'Sign in to see site visits.' }, { status: 401, headers: { 'Cache-Control': 'no-store' } })
    return context.next()
  }

  if (user || passwordMatches(request)) {
    const response = await context.next()
    response.headers.set('Cache-Control', 'no-store')
    return response
  }
  return signInPage(url)
}

export const config = { path: ['/visits', '/visits.html', '/visits/*', '/auth/*', '/api/visits'] }
