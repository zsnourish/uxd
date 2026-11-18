# Team Noticeboard

Static site (matches `starterpack.html`'s Pulse-token, no-build-step convention) with two
Netlify Functions that pull live data from Notion at request time. No rebuild needed when
the team edits the Notion databases — just a page refresh.

## Pages
- `/index.html` — Team Updates (announcements)
- `/dates.html` — Team Events

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
