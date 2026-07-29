// Fetches rows from the "Team Events" Notion database and returns
// them as normalised JSON for the front end to render.
//
// Requires env vars (set in Netlify dashboard, not committed):
//   NOTION_TOKEN            — internal integration token (shared with announcements.js)
//   NOTION_EVENTS_DB_ID     — the database ID (from its URL)

const NOTION_VERSION = '2022-06-28';

exports.handler = async function () {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_EVENTS_DB_ID;

  if (!token || !dbId) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Missing NOTION_TOKEN or NOTION_EVENTS_DB_ID env var' }),
    };
  }

  try {
    const results = [];
    let cursor = undefined;

    do {
      const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          start_cursor: cursor,
          sorts: [{ property: 'Dates', direction: 'ascending' }],
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Notion API error ${res.status}: ${text}`);
      }

      const json = await res.json();
      results.push(...json.results);
      cursor = json.has_more ? json.next_cursor : undefined;
    } while (cursor);

    const items = results.map((page) => {
      const props = page.properties;
      return {
        purpose: richTextToPlain(props['Purpose']?.title),
        dateStart: props['Dates']?.date?.start || null,
        dateEnd: props['Dates']?.date?.end || null,
        location: props['Location']?.rich_text
          ? richTextToPlain(props['Location'].rich_text)
          : '',
        notes: props['Notes']?.rich_text ? richTextToPlain(props['Notes'].rich_text) : '',
        category: props['Category']?.select?.name || '',
      };
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
      body: JSON.stringify(items),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

function richTextToPlain(richTextArray) {
  if (!richTextArray || !richTextArray.length) return '';
  return richTextArray.map((t) => t.plain_text).join('');
}
