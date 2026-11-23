// Site visits API: care home and agency visits the UX and Design team can join.
//
//   GET  /api/visits                  the team list and every visit
//   POST /api/visits { action, as }   create | update | delete | join | withdraw | seen
//
// Visits live in Netlify Blobs (store "site-visits", one JSON document), written
// with an etag check so two people opting in at once can't both take the last place.
//
// No customer details are stored here. A visit holds a customer code (for example
// CH-014), the town or area (never the full address: an address identifies the care
// home on CQC), date, time, purpose and who's going, plus a link to the customer
// details in SharePoint, which needs a Nourish Microsoft sign-in to open. Caitlin
// keeps the code-to-customer list there. The default link comes from the
// VISITS_CUSTOMER_LIST_URL environment variable; a visit can carry its own link.
//
// The team list comes from the VISITS_TEAM environment variable, because this repo
// is public and names with emails don't belong in it:
//   [{ "id": "caitlin", "name": "Caitlin Ballingall", "email": "...", "organiser": true },
//    { "id": "zahra", "name": "Zahra Siddiquia", "email": "...", "admin": true }, ...]
// Organisers are attending by default and can add, edit and delete visits; admins
// can too. Who you are comes from your GitHub sign-in: a team member matches on
// "github" (their handle) or on a verified email on their GitHub account. People
// on the shared team password can see visits but can't opt in or change anything.
// Team entries can carry "github": "handle".
import { getStore } from '@netlify/blobs'

const MAX_PEOPLE = 2 // the organiser plus one other
const KEY = 'visits'
const SESSION_COOKIE = 'uxd_session'
const KINDS = ['Care home', 'Home care agency', 'Other']

const env = (name) => Netlify.env.get(name) || ''
const json = (body, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
const fail = (message, status = 400) => json({ error: message }, status)

export default async (request, context) => {
  const local = context.deploy?.context === 'dev'
  const session = await readSession(request)
  if (!local && !session) return fail('Sign in to see site visits.', 401)

  const team = readTeam()
  if (!team.length) return fail('The team list (VISITS_TEAM) isn’t set up yet.', 503)
  const store = getStore({ name: 'site-visits', consistency: 'strong' })

  let body = {}
  if (request.method === 'POST') {
    try {
      body = await request.json()
    } catch {
      return fail('That request wasn’t readable.')
    }
  }
  // On `netlify dev` there's no sign-in, so the page says who to act as.
  const devAs = local ? body.as || new URL(request.url).searchParams.get('as') : null
  const me = devAs ? team.find((m) => m.id === devAs) || null : whoIs(session, team)

  if (request.method === 'GET') {
    const { data } = await load(store)
    return json({
      team: publicTeam(team),
      me: me?.id || null,
      viewer: session ? { name: session.name, login: session.login || '', provider: session.provider } : { name: 'Local preview', provider: 'local' },
      local,
      maxPeople: MAX_PEOPLE,
      customerListUrl: safeLink(env('VISITS_CUSTOMER_LIST_URL')),
      visits: data.visits,
    })
  }
  if (request.method !== 'POST') return fail('Method not allowed', 405)
  if (!me) {
    return fail(
      session?.provider === 'github'
        ? 'Your GitHub account isn’t on the team list yet. Ask Zahra to add it.'
        : 'Sign in with GitHub to opt in or change visits.',
    )
  }
  const canManage = Boolean(me.organiser || me.admin)

  // Read, change, write only if nobody else wrote in between; retry if they did.
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data, etag, exists } = await load(store)
    let result
    try {
      result = apply(data, body, me, canManage, team)
    } catch (error) {
      return fail(error.message, error.status || 400)
    }
    // Live Blobs always returns an ETag; the local `netlify dev` sandbox doesn't,
    // so there the write is unconditional.
    const write = etag
      ? await store.setJSON(KEY, data, { onlyIfMatch: etag })
      : await store.setJSON(KEY, data, exists ? {} : { onlyIfNew: true })
    if (write.modified) return json({ visits: data.visits, ...result })
  }
  return fail('Someone else changed the visits at the same time. Try again.', 409)
}

export const config = { path: '/api/visits' }

function apply(data, body, me, canManage, team) {
  const now = new Date().toISOString()
  const find = () => {
    const visit = data.visits.find((v) => v.id === body.id)
    if (!visit) throw error('That visit no longer exists. It may have been deleted.', 410)
    return visit
  }
  const people = (visit) => [visit.organiser, ...visit.attendees]

  switch (body.action) {
    case 'create': {
      if (!canManage) throw error('Only organisers can add visits.', 400)
      const fields = clean(body.visit)
      const organiser = team.find((m) => m.id === body.visit?.organiser && m.organiser) || team.find((m) => m.organiser) || me
      const visit = {
        id: crypto.randomUUID(),
        ...fields,
        organiser: organiser.id,
        attendees: [],
        sequence: 0,
        status: 'scheduled',
        seen: {},
        createdAt: now,
        createdBy: me.id,
        updatedAt: now,
        updatedBy: me.id,
      }
      data.visits.push(visit)
      return { id: visit.id }
    }
    case 'update': {
      if (!canManage) throw error('Only organisers can edit visits.', 400)
      const visit = find()
      if (visit.status === 'cancelled') throw error('That visit has been deleted.')
      const fields = clean(body.visit)
      const timeChanged = ['date', 'start', 'end'].some((k) => fields[k] !== visit[k])
      const placeChanged = fields.town !== visit.town || fields.code !== visit.code
      Object.assign(visit, fields)
      visit.sequence += 1
      visit.updatedAt = now
      visit.updatedBy = me.id
      visit.lastChange = timeChanged ? 'rescheduled' : placeChanged ? 'moved' : 'updated'
      return { id: visit.id }
    }
    case 'delete': {
      if (!canManage) throw error('Only organisers can delete visits.', 400)
      const visit = find()
      if (visit.attendees.length) {
        // Keep it as cancelled so the people who opted in see the cancellation
        // and can take it out of their calendar.
        visit.status = 'cancelled'
        visit.sequence += 1
        visit.updatedAt = now
        visit.updatedBy = me.id
        visit.lastChange = 'cancelled'
      } else {
        data.visits = data.visits.filter((v) => v.id !== visit.id)
      }
      return { id: visit.id }
    }
    case 'join': {
      const visit = find()
      if (visit.status === 'cancelled') throw error('That visit has been cancelled.')
      if (people(visit).includes(me.id)) throw error('You’re already going to this visit.')
      if (isPast(visit)) throw error('That visit has already happened.')
      if (people(visit).length >= MAX_PEOPLE) throw error('That visit is full. Someone else opted in first.', 409)
      visit.attendees.push(me.id)
      visit.seen[me.id] = visit.sequence
      visit.joinedAt = { ...(visit.joinedAt || {}), [me.id]: now }
      return { id: visit.id }
    }
    case 'withdraw': {
      const visit = find()
      if (!visit.attendees.includes(me.id)) throw error('You’re not on this visit.')
      visit.attendees = visit.attendees.filter((id) => id !== me.id)
      delete visit.seen[me.id]
      if (visit.status === 'cancelled' && !visit.attendees.length) {
        data.visits = data.visits.filter((v) => v.id !== visit.id)
      }
      return { id: visit.id }
    }
    case 'seen': {
      // The attendee has dealt with a change (downloaded the update or cancellation).
      const visit = find()
      if (!visit.attendees.includes(me.id)) throw error('You’re not on this visit.')
      visit.seen[me.id] = visit.sequence
      if (visit.status === 'cancelled' && visit.attendees.every((id) => visit.seen[id] >= visit.sequence)) {
        data.visits = data.visits.filter((v) => v.id !== visit.id)
      }
      return { id: visit.id }
    }
    default:
      throw error('Unknown action.')
  }
}

function clean(input = {}) {
  const text = (value, max) => String(value ?? '').trim().slice(0, max)
  const visit = {
    code: text(input.code, 20).toUpperCase(),
    kind: KINDS.includes(input.kind) ? input.kind : 'Care home',
    town: text(input.town, 60),
    link: text(input.link, 500),
    date: text(input.date, 10),
    start: text(input.start, 5),
    end: text(input.end, 5),
    purpose: text(input.purpose, 1500),
  }
  if (!/^[A-Z]{1,6}-\d{1,6}$/.test(visit.code)) throw error('Add the customer code: letters, a hyphen, then numbers, for example CH-014. Not the customer’s name.')
  if (!visit.town) throw error('Add the town or area.')
  if (/\d/.test(visit.town) || visit.town.includes(',')) throw error('Add the town or area only, for example Leeds. Don’t add a street address or postcode.')
  if (visit.link && !safeLink(visit.link)) throw error('The customer details link must be a Nourish SharePoint link (https://…sharepoint.com/…).')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(visit.date) || Number.isNaN(Date.parse(visit.date))) throw error('Add a date.')
  if (!/^\d{2}:\d{2}$/.test(visit.start) || !/^\d{2}:\d{2}$/.test(visit.end)) throw error('Add a start and end time.')
  if (visit.end <= visit.start) throw error('The end time must be after the start time.')
  return visit
}

// Only Nourish SharePoint links, so a visit can't point people anywhere else.
function safeLink(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && /(^|\.)sharepoint\.com$/i.test(url.hostname) ? url.toString() : ''
  } catch {
    return ''
  }
}

function isPast(visit) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
  return visit.date < today
}

async function load(store) {
  const result = await store.getWithMetadata(KEY, { type: 'json' })
  return { data: result?.data || { visits: [] }, etag: result?.etag, exists: Boolean(result) }
}

function readTeam() {
  try {
    const team = JSON.parse(env('VISITS_TEAM') || '[]')
    return Array.isArray(team) ? team.filter((m) => m && m.id && m.name) : []
  } catch {
    return []
  }
}

// Match the signed-in GitHub account to the team list: handle first, then a verified email.
function whoIs(session, team) {
  if (session?.provider !== 'github') return null
  const login = String(session.login || '').toLowerCase()
  const emails = (session.emails || []).map((e) => String(e).toLowerCase())
  return (
    team.find((m) => m.github && m.github.toLowerCase() === login) ||
    team.find((m) => m.email && emails.includes(m.email.toLowerCase())) ||
    null
  )
}

const publicTeam = (team) =>
  team.map(({ id, name, email, organiser, admin }) => ({ id, name, email: email || '', organiser: Boolean(organiser), admin: Boolean(admin) }))

function error(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

// The same signed session cookie the edge gate checks (see edge-functions/lib/session.js).
// Returns the session ({ sub, name, login, emails, provider }) or null.
async function readSession(request) {
  const secret = env('SESSION_SECRET')
  const header = request.headers.get('cookie') || ''
  const token = header
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1)
  if (!secret || !token) return null
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  const fromB64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    const ok = await crypto.subtle.verify('HMAC', key, fromB64url(sig), new TextEncoder().encode(body))
    if (!ok) return null
    const value = JSON.parse(fromB64url(body).toString('utf8'))
    return value.exp && value.exp > Date.now() ? value : null
  } catch {
    return null
  }
}
