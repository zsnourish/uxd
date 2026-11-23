// Site visits API: care home and agency visits the UX and Design team can join.
//
//   GET  /api/visits                  the team list and every visit
//   POST /api/visits { action, as }   create | update | delete | join | withdraw | seen
//
// Visits live in Netlify Blobs (store "site-visits", one JSON document), written
// with an etag check so two people opting in at once can't both take the last place.
//
// No customer details are stored here. A visit holds a customer code (for example
// CH-014), a simple area (town or city plus the first part of the postcode, for
// example "Leeds LS1"; never the full address, because an address identifies the
// care home on CQC), date, time, purpose and who's going. Caitlin keeps the
// code-to-customer list herself.
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
import SEED_CODES from '../lib/visit-codes.mjs'

const MAX_PEOPLE = 2 // the organiser plus one other
const KEY = 'visits'
const SESSION_COOKIE = 'uxd_session'
const DEFAULT_TYPES = ['Care home', 'Home care agency', 'Supported living', 'Mixed provider', 'Other'] // organisers can change the list on the page

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
      types: typesOf(data),
      codes: codesOf(data),
      customerListUrl: safeLink(env('VISITS_CUSTOMER_LIST_URL')),
      // Internal name of the list's code column (List settings → the column → Field= in the address), for filtered links.
      customerCodeField: /^[A-Za-z0-9_]{1,64}$/.test(env('VISITS_CUSTOMER_LIST_CODE_FIELD')) ? env('VISITS_CUSTOMER_LIST_CODE_FIELD') : '',
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
      return json({ error: error.message, field: error.field || null }, error.status || 400)
    }
    // Live Blobs always returns an ETag; the local `netlify dev` sandbox doesn't,
    // so there the write is unconditional.
    const write = etag
      ? await store.setJSON(KEY, data, { onlyIfMatch: etag })
      : await store.setJSON(KEY, data, exists ? {} : { onlyIfNew: true })
    if (write.modified) return json({ visits: data.visits, types: typesOf(data), codes: codesOf(data), ...result })
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
      const fields = clean(body.visit, typesOf(data), codesOf(data).map((c) => c.code))
      const { organiser, attendees } = pickPeople(body.visit, team, me)
      const visit = {
        id: crypto.randomUUID(),
        ...fields,
        organiser,
        attendees,
        sequence: 0,
        status: 'scheduled',
        seen: Object.fromEntries(attendees.map((id) => [id, 0])),
        notices: {},
        createdAt: now,
        createdBy: me.id,
        updatedAt: now,
        updatedBy: me.id,
      }
      // People put on the visit by someone else are told on the page.
      for (const id of [organiser, ...attendees]) if (id !== me.id) visit.notices[id] = { type: 'added', by: me.id, at: now }
      data.visits.push(visit)
      return { id: visit.id }
    }
    case 'update': {
      const visit = find()
      if (!canManage && visit.organiser !== me.id) throw error('Only this visit’s organiser can edit it.', 400)
      if (visit.status === 'cancelled') throw error('That visit has been deleted.')
      // A visit can keep a type that has since been taken off the list.
      const fields = clean(body.visit, [...typesOf(data), visit.kind], [...codesOf(data).map((c) => c.code), visit.code])
      const timeChanged = ['date', 'start', 'end'].some((k) => fields[k] !== visit[k])
      const placeChanged = fields.town !== visit.town || fields.code !== visit.code
      const before = [visit.organiser, ...visit.attendees]
      const next = body.visit && 'organiser' in body.visit ? pickPeople(body.visit, team, me) : { organiser: visit.organiser, attendees: visit.attendees }
      Object.assign(visit, fields)
      visit.organiser = next.organiser
      visit.attendees = next.attendees
      visit.notices = visit.notices || {}
      const after = [next.organiser, ...next.attendees]
      for (const id of before) if (!after.includes(id) && id !== me.id) visit.notices[id] = { type: 'removed', by: me.id, at: now }
      for (const id of after) {
        if (!before.includes(id)) {
          visit.seen[id] = visit.sequence + 1
          if (id !== me.id) visit.notices[id] = { type: 'added', by: me.id, at: now }
        }
      }
      for (const id of before) if (!after.includes(id)) delete visit.seen[id]
      visit.sequence += 1
      visit.updatedAt = now
      visit.updatedBy = me.id
      visit.lastChange = timeChanged ? 'rescheduled' : placeChanged ? 'moved' : 'updated'
      return { id: visit.id }
    }
    case 'delete': {
      const visit = find()
      if (!canManage && visit.organiser !== me.id) throw error('Only this visit’s organiser can cancel it.', 400)
      if (visit.attendees.some((id) => id !== me.id)) {
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
      if (visit.notices) delete visit.notices[me.id]
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
      if (visit.notices) delete visit.notices[me.id]
      if (visit.status === 'cancelled' && visit.attendees.every((id) => visit.seen[id] >= visit.sequence)) {
        data.visits = data.visits.filter((v) => v.id !== visit.id)
      }
      return { id: visit.id }
    }
    case 'dismiss-notice': {
      // "Got it" on an added/removed notice.
      const visit = find()
      if (visit.notices) delete visit.notices[me.id]
      return { id: visit.id }
    }
    case 'add-type': {
      if (!canManage) throw error('Only organisers can change visit types.')
      const name = typeName(body.name)
      const types = typesOf(data)
      if (types.some((t) => t.toLowerCase() === name.toLowerCase())) throw error('That type is already on the list.', 400, 'type')
      if (types.length >= 20) throw error('There can be up to 20 types.', 400, 'type')
      data.types = [...types, name]
      return { type: name }
    }
    case 'rename-type': {
      if (!canManage) throw error('Only organisers can change visit types.')
      const types = typesOf(data)
      const from = String(body.from ?? '')
      if (!types.includes(from)) throw error('That type no longer exists.', 410)
      const name = typeName(body.name)
      if (name !== from && types.some((t) => t.toLowerCase() === name.toLowerCase())) throw error('That type is already on the list.', 400, 'type')
      data.types = types.map((t) => (t === from ? name : t))
      for (const visit of data.visits) if (visit.kind === from) visit.kind = name
      data.codes = codesOf(data).map((c) => (c.type === from ? { ...c, type: name } : c))
      return { type: name }
    }
    case 'add-code': {
      if (!canManage) throw error('Only organisers can change customer codes.')
      const codes = codesOf(data)
      const code = String(body.code ?? '').trim().toUpperCase()
      if (!/^[A-Z]{1,6}-\d{1,6}$/.test(code)) throw error('Enter a code like CH-014: letters, a hyphen, then numbers.', 400, 'newcode')
      if (codes.some((c) => c.code === code)) throw error('That code is already on the list.', 400, 'newcode')
      if (!typesOf(data).includes(body.type)) throw error('Choose a type from the list.', 400, 'codetype')
      data.codes = [...codes, { code, type: body.type }].sort(byCode)
      return { code }
    }
    case 'update-code': {
      if (!canManage) throw error('Only organisers can change customer codes.')
      const codes = codesOf(data)
      if (!codes.some((c) => c.code === body.code)) throw error('That code no longer exists.', 410)
      if (!typesOf(data).includes(body.type)) throw error('Choose a type from the list.', 400, 'codetype')
      data.codes = codes.map((c) => (c.code === body.code ? { ...c, type: body.type } : c))
      return { code: body.code }
    }
    case 'remove-code': {
      if (!canManage) throw error('Only organisers can change customer codes.')
      // Visits already using it keep it; it just can't be picked for new ones.
      data.codes = codesOf(data).filter((c) => c.code !== body.code)
      return {}
    }
    case 'remove-type': {
      if (!canManage) throw error('Only organisers can change visit types.')
      const types = typesOf(data)
      if (types.length <= 1) throw error('Keep at least one type.')
      // Visits already using it keep their label; it just can't be picked for new ones.
      data.types = types.filter((t) => t !== body.name)
      return {}
    }
    default:
      throw error('Unknown action.')
  }
}

// Who's on a visit. The organiser defaults to whoever adds it. Caitlin (the team's
// organiser) is added as the other person by default when someone else organises;
// the form can change that person or leave the place free.
function pickPeople(input = {}, team, me) {
  const ids = new Set(team.map((m) => m.id))
  const organiser = ids.has(input.organiser) ? input.organiser : me.id
  const also = input.alsoGoing === '' ? null : ids.has(input.alsoGoing) ? input.alsoGoing : null
  if (also && also === organiser) throw error('Choose someone other than the organiser.', 400, 'alsoGoing')
  return { organiser, attendees: also ? [also] : [] }
}

function clean(input = {}, types = DEFAULT_TYPES, codes = null) {
  const text = (value, max) => String(value ?? '').trim().slice(0, max)
  const visit = {
    code: text(input.code, 20).toUpperCase(),
    kind: text(input.kind, 40),
    town: area(input.town),
    date: text(input.date, 10),
    start: text(input.start, 5),
    end: text(input.end, 5),
    purpose: text(input.purpose, 1500),
  }
  // Each message names its field so the page can show it on that field.
  // Keep these in step with checkFields() in visits.html.
  if (!/^[A-Z]{1,6}-\d{1,6}$/.test(visit.code)) throw error('Use the customer’s code, like CH-014, not their name.', 400, 'code')
  if (codes && !codes.includes(visit.code)) throw error('Pick a code from the list. If it’s a new customer, add the code in Customer codes first.', 400, 'code')
  if (!types.includes(visit.kind)) throw error('Choose a type from the list.', 400, 'kind')
  if (!visit.town) throw error('Find the area by postcode or town.', 400, 'town')
  if (!/^[A-Za-z][A-Za-z .'-]{0,39}( [A-Z]{1,2}\d[A-Z\d]?)?$/.test(visit.town)) {
    throw error('Use the town and first part of the postcode only, like Leeds LS1.', 400, 'town')
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(visit.date) || Number.isNaN(Date.parse(visit.date))) throw error('Enter the date.', 400, 'date')
  if (!/^\d{2}:\d{2}$/.test(visit.start)) throw error('Enter the start time.', 400, 'start')
  if (!/^\d{2}:\d{2}$/.test(visit.end)) throw error('Enter the end time.', 400, 'end')
  if (visit.end <= visit.start) throw error('The end time must be after the start time.', 400, 'end')
  return visit
}

// "leeds,  ls1" → "leeds LS1": tidy spacing, drop commas, upper-case the postcode district.
function area(value) {
  const words = String(value ?? '').replace(/,/g, ' ').trim().split(/\s+/).filter(Boolean)
  const last = words[words.length - 1] || ''
  if (words.length > 1 && /^[A-Za-z]{1,2}\d[A-Za-z\d]?$/.test(last)) words[words.length - 1] = last.toUpperCase()
  return words.join(' ').slice(0, 60)
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

function codesOf(data) {
  return Array.isArray(data.codes) ? data.codes : SEED_CODES
}

const byCode = (a, b) => {
  const [pa, na] = a.code.split('-'), [pb, nb] = b.code.split('-')
  return pa.localeCompare(pb) || Number(na) - Number(nb)
}

// Only Nourish SharePoint links, so the list link can't point anywhere else.
function safeLink(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && /(^|\.)sharepoint\.com$/i.test(url.hostname) ? url.toString() : ''
  } catch {
    return ''
  }
}

function typesOf(data) {
  return Array.isArray(data.types) && data.types.length ? data.types : DEFAULT_TYPES
}

function typeName(value, field = 'type') {
  const name = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!name) throw error('Enter a name for the type.', 400, field)
  if (name.length > 40) throw error('Keep type names to 40 characters.', 400, field)
  return name
}

function error(message, status = 400, field = null) {
  return Object.assign(new Error(message), { status, field })
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
