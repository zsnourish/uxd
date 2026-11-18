// Upcoming UX care site visits from the "UX Site Visits" Microsoft Bookings calendar.
//
// The noticeboard is public, so this function redacts everything except date, time,
// town and how many people are going. Care site names, addresses, service names,
// notes and attendee names never leave this function. Full details stay in Bookings.
//
// Requires env vars (set in Netlify, never committed), from an Entra app registration
// with the Microsoft Graph *application* permission Bookings.Read.All (admin consent):
//   MS_TENANT_ID      — Nourish tenant ID
//   MS_CLIENT_ID      — the app's Application (client) ID
//   MS_CLIENT_SECRET  — a client secret for that app
// Optional:
//   BOOKINGS_BUSINESS_ID — defaults to UXSiteVisits@nourishcare.com

const BUSINESS = process.env.BOOKINGS_BUSINESS_ID || 'UXSiteVisits@nourishcare.com';
const BOOKING_PAGE = `https://bookings.cloud.microsoft/book/${BUSINESS}/`;
const GRAPH = 'https://graph.microsoft.com/v1.0';
const LOOKAHEAD_DAYS = 180;

const json = (statusCode, body, maxAge = 600) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': `public, max-age=${maxAge}`,
  },
  body: JSON.stringify(body),
});

exports.handler = async function () {
  const { MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET } = process.env;
  if (!MS_TENANT_ID || !MS_CLIENT_ID || !MS_CLIENT_SECRET) {
    return json(200, { configured: false, bookingPage: BOOKING_PAGE, visits: [], open: [] }, 60);
  }

  try {
    const token = await getToken(MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET);
    const base = `${GRAPH}/solutions/bookingBusinesses/${encodeURIComponent(BUSINESS)}`;

    const start = new Date();
    const end = new Date(start.getTime() + LOOKAHEAD_DAYS * 86400000);
    const [services, appointments] = await Promise.all([
      graphAll(`${base}/services`, token),
      graphAll(
        `${base}/calendarView?start=${start.toISOString()}&end=${end.toISOString()}`,
        token
      ),
    ]);

    const serviceById = new Map(services.map((s) => [s.id, s]));

    // One row per service + start time: group bookings can come back as several appointments.
    const grouped = new Map();
    for (const a of appointments) {
      const startIso = toIso(a.startDateTime);
      if (!startIso || new Date(startIso) < start) continue;
      const key = `${a.serviceId}|${startIso}`;
      const row = grouped.get(key) || {
        serviceId: a.serviceId,
        start: startIso,
        end: toIso(a.endDateTime),
        town: '',
        people: new Set(),
      };
      row.town = row.town || townOf(a.serviceLocation) || townOf(serviceById.get(a.serviceId)?.defaultLocation);
      for (const c of a.customers || []) {
        const id = (c.emailAddress || c.customerId || c.name || '').toLowerCase();
        if (id) row.people.add(id);
      }
      for (const s of a.staffMemberIds || []) row.people.add(`staff:${s}`);
      grouped.set(key, row);
    }

    const visits = [...grouped.values()]
      .sort((x, y) => new Date(x.start) - new Date(y.start))
      .map((r) => ({
        start: r.start,
        end: r.end,
        town: r.town,
        going: r.people.size,
        link: serviceById.get(r.serviceId)?.webUrl || BOOKING_PAGE,
      }));

    // Visits set up in Bookings that nobody has booked onto yet.
    const bookedServices = new Set([...grouped.values()].map((r) => r.serviceId));
    const open = services
      .filter((s) => !s.isHiddenFromCustomers && !bookedServices.has(s.id))
      .map((s) => ({ town: townOf(s.defaultLocation), link: s.webUrl || BOOKING_PAGE }));

    return json(200, { configured: true, bookingPage: BOOKING_PAGE, visits, open });
  } catch (err) {
    console.error('visits:', err.message);
    return json(502, { configured: true, bookingPage: BOOKING_PAGE, error: 'Bookings could not be read' }, 60);
  }
};

async function getToken(tenant, clientId, secret) {
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: secret,
      grant_type: 'client_credentials',
      scope: 'https://graph.microsoft.com/.default',
    }),
  });
  if (!res.ok) throw new Error(`token ${res.status}`);
  return (await res.json()).access_token;
}

async function graphAll(url, token) {
  const out = [];
  let next = url;
  while (next) {
    const res = await fetch(next, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`graph ${res.status} ${new URL(next).pathname}`);
    const body = await res.json();
    out.push(...(body.value || []));
    next = body['@odata.nextLink'];
  }
  return out;
}

// Graph returns { dateTime: '2026-12-03T09:00:00.0000000', timeZone: 'UTC' } for Bookings.
function toIso(dt) {
  if (!dt?.dateTime) return null;
  const tz = (dt.timeZone || 'UTC').toUpperCase();
  const s = dt.dateTime.replace(/\.\d+$/, '');
  return tz === 'UTC' || tz === 'Z' ? `${s}Z` : new Date(s).toISOString();
}

// Town only: never the site name, street or postcode.
function townOf(loc) {
  const city = loc?.address?.city;
  return typeof city === 'string' ? city.trim() : '';
}
