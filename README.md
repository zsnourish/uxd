# Team Noticeboard

Static site (matches `starterpack.html`'s Pulse-token, no-build-step convention) with two
Netlify Functions that pull live data from Notion at request time. No rebuild needed when
the team edits the Notion databases — just a page refresh.

## Pages
- `/index.html` — Team Updates (announcements)
- `/dates.html` — Team Events
- `/visits` — Site visits (gated; see below)

## 1. Notion database schema

Both databases already exist. Apply this schema to each (Notion → database → `•••` →
"Edit property" per column, or via the Notion API/MCP if you have schema-write access —
my attempt from this chat was blocked with a permissions error, so you may need to do
this manually or grant the integration schema-edit access first).

**Team Announcements** (`https://app.notion.com/p/3ac80408d1b28022b227c87bc67cecb1`)
| Property | Type | Notes |
|---|---|---|
| Update | Title | The update text itself |
| Subject | Select | Team, Team Day, Hiring, Team Day / Travel, Team Day / Hatch, Design Roles |
| Date | Date | |
| Action Needed | Select | No, Yes, Done |

**Team Events** (`https://app.notion.com/p/3ac80408d1b28091a139f6392f94a749`)
| Property | Type | Notes |
|---|---|---|
| Purpose | Title | e.g. "☕ UX/Design Team Day" |
| Dates | Date | Use the end-date toggle for multi-day events |
| Location | Text | Venue / city |
| Notes | Text | |
| Category | Select | Other UX/Design team events, Nourish org events, Non-Nourish events |

## 2. Create a Notion integration

1. [notion.so/my-integrations](https://www.notion.so/my-integrations) → New integration →
   internal, read-only content capabilities are enough.
2. Copy the "Internal Integration Token".
3. Open each database in Notion → `•••` → Connections → add the integration to both.
4. Copy each database's ID from its URL (the 32-character string before `?v=`).

## 3. Netlify environment variables

In Netlify → Site settings → Environment variables, add:
- `NOTION_TOKEN` — the integration token from step 2
- `NOTION_ANNOUNCEMENTS_DB_ID` — Team Announcements database ID
- `NOTION_EVENTS_DB_ID` — Team Events database ID

## 4. Deploy

Connect this repo to Netlify (or drag-and-drop deploy). `netlify.toml` already points at
the functions folder — no build command needed.

## Adding this to the existing repo

```bash
git clone https://github.com/zsnourish/uxd.git
cd uxd
# copy in: index.html, dates.html, assets/, netlify/, netlify.toml, README.md
git add .
git commit -m "Add Team Noticeboard site (Notion-backed)"
git push
```

## Site visits (`/visits`)

Care home and agency visits the team can opt in to. Caitlin (any `organiser` in the team list)
adds, edits and deletes visits and is always going. Anyone else can opt in while there's a place
(2 people per visit: the organiser plus one), add the visit to Outlook, and withdraw any time.

- **No customer details on Netlify.** A visit holds a customer code (letters-hyphen-numbers, for
  example CH-014), a simple area (town or city plus the first part of the postcode, for example
  Leeds LS1), date, time, purpose and who's going. Caitlin keeps the code-to-customer list herself.
  The API rejects names as codes and street addresses or full postcodes in the area. Past visits
  stay as a history.
- **Area lookup.** The Area field looks up a postcode, postcode district or town with
  [postcodes.io](https://postcodes.io) (free UK open data, called from the browser) and saves only
  "Town OUTCODE". A full postcode typed there is sent to postcodes.io but never stored.
- **Sheets.** Adding or editing a visit and managing visit types open in a side sheet (bottom sheet
  on phones). Drill-ins replace the sheet's content with a Back button; sheets never stack.
- **Visit types.** Organisers edit the list from the settings icon (Settings › Visit types) or the form's "Edit types". It's kept in Blobs with the
  visits. Renaming a type updates visits that use it; removing one leaves it on existing visits.
- **Errors** show under the field they belong to (client check first, then the API's, which names
  the field).
- **Gate.** `netlify/edge-functions/gate.js` (ported from the Pulse docs site) covers `/visits`,
  `/auth/*` and `/api/visits`: GitHub (members of the `nourishcare` org) or the shared team
  password. It fails closed: with no sign-in method set, the area returns 503. The rest of the
  noticeboard stays public.
- **Who you are.** Taken from the GitHub sign-in, matched to the team list on `github` handle or a
  verified GitHub email. Shared-password visitors can see visits but not opt in or change anything.
- **Data.** Netlify Blobs store `site-visits`, written with an ETag check so two people can't take
  the last place.
- **Outlook.** No email is sent. Opting in offers an `.ics` file and an Outlook on the web link,
  both titled "Site visit: CH-014, Leeds LS1". When a visit is rescheduled or
  cancelled, the person going sees it on the page with an updated or cancelling `.ics`, and the
  organiser gets an "Email <name>" link.

Environment variables (Netlify, all scopes):
- `SESSION_SECRET` — random string that signs the session cookie (required)
- `SITE_PASSWORD` — the shared team password
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` — a GitHub OAuth app with callback
  `https://uxnourish.netlify.app/auth/github/callback` (optional `GITHUB_ORG`, default `nourishcare`)
- `VISITS_TEAM` — JSON list of `{ id, name, email, github, organiser?, admin? }`. It lives in
  Netlify, not in this public repo.

Run locally with `npx netlify-cli dev --offline --dir .` and a `.env` holding `VISITS_TEAM`.
Locally there's no sign-in (you pick who to preview as) and Blobs writes aren't conditional, so
test the gate and the two-person cap on the live site.
