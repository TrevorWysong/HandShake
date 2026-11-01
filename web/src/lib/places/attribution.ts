// The map's credit line, as the network's settings give it
// (`services.map_attribution`): HTML, since a tile licence asks for a
// link. Leaflet inserts it as HTML, and the settings are the network
// operator's word, not this app's -- so it's rebuilt here from plain text and
// http(s) links alone. Every other tag is dropped (its text kept), every
// attribute but a link's address is dropped, and everything is escaped on
// the way out: nothing in it can run, style the page or point anywhere but
// the web.

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", middot: "·", ndash: "–", mdash: "—", hellip: "…" };

/// Plain text from HTML text: the common named entities and any numeric
/// one. An unknown entity stays as written.
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? whole;
    const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
  });
}

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/// A link's address, if it's an absolute http(s) URL.
function webAddress(tag: string): string | null {
  const href = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
  if (!href) return null;
  try {
    const url = new URL(decode(href[1] ?? href[2] ?? href[3]).trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/// The most text a credit line shows -- a line under the map, not a page.
const MAX_LENGTH = 300;

/// `html` as safe HTML: its text, and its http(s) links, opening in a new
/// tab. Never longer than `MAX_LENGTH` characters of text.
export function safeAttribution(html: string): string {
  return rebuild(html).html;
}

/// What `safeAttribution` leaves out of `html` -- the tags it drops, and
/// whether it cut the text short -- for packaging to warn of.
export function attributionLosses(html: string): { tags: string[]; cut: boolean } {
  const { tags, cut } = rebuild(html);
  return { tags, cut };
}

function rebuild(html: string): { html: string; tags: string[]; cut: boolean } {
  const tags: string[] = [];
  let cut = false;
  let out = "";
  let text = 0;
  let inLink = false;
  const put = (piece: string) => {
    const room = MAX_LENGTH - text;
    const chars = [...piece];
    if (chars.length > room) cut = true;
    if (room <= 0) return;
    const kept = chars.slice(0, room).join("");
    text += [...kept].length;
    out += escape(kept);
  };
  // A tag is `<` then a letter or `/`; any other `<` is text.
  for (const part of html.split(/(<\/?[a-z][^>]*>?)/i)) {
    if (!/^<\/?[a-z]/i.test(part)) {
      put(decode(part));
      continue;
    }
    if (/^<a[\s>]/i.test(part) && !inLink) {
      const href = webAddress(part);
      if (href) {
        out += `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">`;
        inLink = true;
        continue;
      }
    } else if (/^<\/a[\s>]/i.test(part) && inLink) {
      out += "</a>";
      inLink = false;
      continue;
    }
    tags.push(part);
  }
  return { html: inLink ? out + "</a>" : out, tags, cut };
}
