// Renders Notion rich text segments ({ text, href }) as safe HTML with links,
// and turns bare URLs in plain text into links too.
(function () {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeHref = (h) => (/^(https?:|mailto:)/i.test(h || '') ? h : null);
  const link = (href, text) =>
    '<a href="' + esc(href) + '"' + (/^mailto:/i.test(href) ? '' : ' target="_blank" rel="noopener"') + '>' + esc(text) + '</a>';
  const linkify = (text) =>
    esc(text).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)'"]/g, (u) => {
      const raw = u.replace(/&amp;/g, '&');
      return link(raw, raw.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''));
    });
  window.renderRich = function (value) {
    if (!value) return '';
    if (typeof value === 'string') return linkify(value);
    return value.map((s) => (safeHref(s.href) ? link(s.href, s.text) : linkify(s.text))).join('');
  };
  window.plainText = function (value) {
    if (!value) return '';
    return typeof value === 'string' ? value : value.map((s) => s.text).join('');
  };
  window.icon = function (name, cls) {
    return '<i class="ph ph-' + esc(name) + (cls ? ' ' + cls : '') + '" aria-hidden="true"></i>';
  };
})();
