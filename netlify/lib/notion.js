// Shared helpers for turning Notion properties into noticeboard JSON.
// Emojis are stripped from text and the first one becomes a Phosphor icon name.
// Rich text keeps its links as { text, href } segments for the page to render.

const EMOJI = /(?:\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}])(?:[‍️⃣]|\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*/gu;

const EMOJI_ICONS = {
  '🔹': 'users-three', '🔷': 'users-three', '👥': 'users-three',
  '🚀': 'rocket-launch',
  '⛱': 'sun', '🏖': 'sun', '☀': 'sun', '🌞': 'sun',
  '🎉': 'confetti', '🥳': 'confetti', '🎊': 'confetti',
  '🎄': 'tree-evergreen', '🎂': 'cake', '☕': 'coffee', '🍕': 'pizza', '🍻': 'beer-stein',
  '📣': 'megaphone-simple', '📢': 'megaphone-simple',
  '✈': 'airplane-tilt', '🚆': 'train', '🚂': 'train', '🚗': 'car',
  '🏆': 'trophy', '💼': 'briefcase', '👋': 'hand-waving', '🤝': 'handshake',
  '📅': 'calendar-dots', '🗓': 'calendar-dots', '⚠': 'warning', '✅': 'check-circle',
  '🎨': 'palette', '💡': 'lightbulb', '🧪': 'flask', '🔍': 'magnifying-glass', '🔎': 'magnifying-glass',
  '🎤': 'microphone-stage', '🎓': 'graduation-cap', '📚': 'books', '🧠': 'brain', '🤖': 'robot',
  '🔒': 'lock-key', '🧩': 'puzzle-piece', '🏥': 'first-aid-kit', '❤': 'heart', '⭐': 'star', '✨': 'sparkle',
};

function stripEmoji(text) {
  let icon = '';
  const clean = (text || '').replace(EMOJI, (m) => {
    if (!icon) icon = EMOJI_ICONS[m.replace(/[️‍⃣]/g, '')] || EMOJI_ICONS[[...m][0]] || 'star';
    return ' ';
  });
  return { icon, text: clean.replace(/[\s ]+/g, ' ').trim() };
}

// Rich text → [{ text, href? }], emojis removed, links kept.
function richSegments(rich) {
  let icon = '';
  const segs = (rich || [])
    .map((t) => {
      const s = stripEmoji(t.plain_text);
      if (!icon && s.icon) icon = s.icon;
      // Keep single spaces between segments that stripEmoji trimmed.
      const raw = (t.plain_text || '').replace(EMOJI, '').replace(/ /g, ' ');
      const text = raw.replace(/\s+/g, ' ');
      const href = t.href || t.text?.link?.url || null;
      return text ? (href ? { text, href } : { text }) : null;
    })
    .filter(Boolean);
  if (segs.length) {
    segs[0].text = segs[0].text.replace(/^\s+/, '');
    segs[segs.length - 1].text = segs[segs.length - 1].text.replace(/\s+$/, '');
  }
  return { icon, segments: segs.filter((s) => s.text) };
}

// Location can be a Notion "place" (name, address, lat/lon) or older plain text.
function locationOf(prop) {
  if (!prop) return null;
  if (prop.type === 'place' && prop.place) {
    const { name = '', address = '', lat, lon } = prop.place;
    // Town only: the last address part that isn't a postcode or the country.
    const parts = address.split(',').map((x) => x.trim())
      .filter((x) => x && !/^united kingdom$|^uk$/i.test(x) && !/^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(x));
    let detail = parts.length > 1 ? parts[parts.length - 1] : '';
    if (detail && name && detail.toLowerCase() === name.toLowerCase()) detail = '';
    const q = (address && name && address.toLowerCase().startsWith(name.toLowerCase()) ? address : [name, address].filter(Boolean).join(', ')) || (lat != null ? `${lat},${lon}` : '');
    const mapUrl = q ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` : null;
    // A town or city on its own comes through as "Bristol, England, United Kingdom":
    // show just "Bristol". The map link still uses the full string.
    if (name.includes(',')) return { name: name.split(',')[0].trim(), detail: '', mapUrl };
    return { name: name || detail, detail: name ? detail : '', mapUrl };
  }
  const rich = prop.rich_text || prop.title;
  if (rich) {
    const text = rich.map((t) => t.plain_text).join('').trim();
    return text ? { name: text, detail: '', mapUrl: null } : null;
  }
  if (prop.select?.name) return { name: prop.select.name, detail: '', mapUrl: null };
  if (prop.url) return { name: prop.url, detail: '', mapUrl: prop.url };
  return null;
}

module.exports = { stripEmoji, richSegments, locationOf };
