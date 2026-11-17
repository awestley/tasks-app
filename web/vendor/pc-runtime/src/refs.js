// pc:// references (docs/app-contract.md, section 4).
//   pc://<app>/<type>/<id>     canonical
//   [[task:<id>]]              link, in Markdown
//   ![[task:<id>]]             embed, in Markdown
// The short form names a type; which app owns it comes from the manifests (typeOwners).

const SEGMENT = /^[a-z][a-z0-9-]{0,31}$/;
const ID = /^[A-Za-z0-9._~-]{1,128}$/;

export function parseRef(ref) {
  if (typeof ref !== 'string') return null;
  const m = /^pc:\/\/([^/]+)\/([^/]+)\/([^/?#]+)$/.exec(ref.trim());
  if (!m) return null;
  let id;
  try { id = decodeURIComponent(m[3]); } catch { return null; }
  if (!SEGMENT.test(m[1]) || !SEGMENT.test(m[2]) || !ID.test(id)) return null;
  return { app: m[1], type: m[2], id };
}

export function formatRef({ app, type, id }) {
  if (!SEGMENT.test(app) || !SEGMENT.test(type) || !ID.test(String(id))) throw new Error('Invalid reference');
  return `pc://${app}/${type}/${encodeURIComponent(String(id))}`;
}

/**
 * Find [[type:id]] and ![[type:id]] in Markdown. `typeOwners` maps a type to its app id
 * (e.g. { task: 'tasks', note: 'notes' }); unknown types are left alone so ordinary
 * [[wikilinks]] keep working.
 * @returns {{ index: number, length: number, embed: boolean, ref: string, label: string|null }[]}
 */
export function findShortRefs(markdown, typeOwners) {
  const out = [];
  const re = /(!?)\[\[([a-z][a-z0-9-]{0,31}):([A-Za-z0-9._~-]{1,128})(?:\|([^\]\n]{1,200}))?\]\]/g;
  let m;
  while ((m = re.exec(markdown))) {
    const app = typeOwners[m[2]];
    if (!app) continue;
    out.push({ index: m.index, length: m[0].length, embed: m[1] === '!', ref: formatRef({ app, type: m[2], id: m[3] }), label: m[4] || null });
  }
  return out;
}

export function shortRef(ref, { embed = false, label } = {}) {
  const p = parseRef(ref);
  if (!p) throw new Error('Invalid reference');
  return `${embed ? '!' : ''}[[${p.type}:${p.id}${label ? `|${label}` : ''}]]`;
}
