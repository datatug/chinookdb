// The OVDB Directory's own rules for what a manifest publishes, ported for the offline pre-check
// (CC0-1.0, like the Directory's files).
//
// MIRRORS openvaultdb/directory at commit a4aebb7f6d3bccc98348f809963ea66cc280439c (the head of its
// pull request 8) PLUS two refusals that the Directory is adding to every URL field on that branch: any port
// (including :443) and any percent escape in the path (outside recordset_page's {name}). Both are marked
// "PLUS" below; they stand until the next head of openvaultdb/directory PR 8, which this file then follows.
// From `scripts/lib/urls.mjs` come publicHttpsProblem, hostProblem and hasOvdbMarker (copied, the file's opening
// comment is not repeated); from `scripts/lib/directory.mjs` the canonical-url rule (urlProblem), the id pattern
// (idPattern, at most 80 characters) and the deployment.engine pattern; from `scripts/lib/git.mjs`
// isRepositoryPath. When the Directory changes
// one of them, change it here, and scripts/test-model.mjs (the refusals that it pins) with it.
//
// `homepageProblem` is NOT the Directory's: it is a stricter rule for the one field that a page puts
// in a link, written to be safe in an attribute and in a URL whatever the HTML around it.

// ---- scripts/lib/urls.mjs @ a4aebb7, plus the two refusals marked PLUS ----

// Names that are never public: local, internal and reserved naming zones.
const privateSuffixes = [
  'localhost', 'local', 'internal', 'localdomain', 'lan', 'home.arpa', 'arpa', 'intranet', 'corp', 'private',
  'svc', 'home', 'test', 'example', 'invalid', 'onion',
];

// Two-label public suffixes where the registered name sits one label further left
// (ovdb.co.uk is a registered name under co.uk, not a subdomain). The list is short: 17
// of the common ones, kept by hand, not the public suffix list. How it is decided: a
// suffix is added by a reviewed change to this list when a real publisher needs it. Until
// then a name under a suffix that is not listed counts as having `ovdb` as a subdomain
// (ovdb.co.il, ovdb.com.sg, ovdb.github.io and ovdb.pages.dev pass although `ovdb` is
// the registered name, or a publisher's own site, there). That is acceptable because
// the marker is a naming convention, not proof that the publisher owns the origin (see
// the README).
const twoLabelSuffixes = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'co.in', 'co.za', 'com.br', 'com.cn', 'com.mx', 'com.tr', 'com.ar',
]);

// A problem with the host of `url` for a public mapping, or null.
export function hostProblem(url) {
  const host = url.hostname.toLowerCase();
  if (host.startsWith('[') || host.includes(':')) return `${url.hostname} is an IP address; a public mapping names a host`;
  if (host.endsWith('.')) return `${url.hostname} ends with a dot; write the host without it`;
  if (host.split('.').some((label) => label === '')) return `${url.hostname} has an empty label`;
  if (/^\d+(\.\d+)*$/.test(host) || /^0x[0-9a-f]+$/.test(host)) return `${url.hostname} is an IP address; a public mapping names a host`;
  if (!host.includes('.')) return `${url.hostname} is a single-label name, not a public host`;
  for (const suffix of privateSuffixes) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return `${url.hostname} is a local, internal or reserved name (.${suffix}), not a public host`;
  }
  return null;
}

// A problem with `value` as a public https URL (the canonical url, the
// deployment's url, discovery document or recordset page, the publisher's
// url), or null. `template` allows `{name}` exactly once, and only in the path
// (never in the host, userinfo or port), as in recordset_page.
// Refused: anything but https, userinfo, a query, a fragment, a host that is
// not public (see hostProblem), a malformed or non-canonical spelling.
export function publicHttpsProblem(value, { template = false } = {}) {
  if (typeof value !== 'string' || value.trim() === '') return 'is not a URL';
  if (value !== value.trim() || /[\u0000- \u007f\\]/.test(value)) return 'contains whitespace, control characters or a backslash';
  let probe = value;
  if (template) {
    if (value.split('{name}').length !== 2) return 'must contain {name} exactly once';
    const authorityEnd = value.indexOf('/', value.indexOf('//') + 2);
    if (authorityEnd === -1 || value.indexOf('{name}') < authorityEnd) return 'must have {name} in the path only, never in the host, userinfo or port';
    probe = value.replace('{name}', 'name');
  }
  let url;
  try { url = new URL(probe); } catch { return 'is not a URL'; }
  if (url.protocol !== 'https:') return `must be https, not ${url.protocol.slice(0, -1)}`;
  if (url.username || url.password) return 'must not contain credentials (userinfo)';
  if (url.search || probe.includes('?')) return 'must not contain a query';
  if (url.hash || probe.includes('#')) return 'must not contain a fragment';
  const problem = hostProblem(url);
  if (problem) return problem;
  // PLUS (not in a4aebb7): no port at all, not even the default one written out (:443).
  if (url.port !== '' || /^https:\/\/[^/?#]*:/.test(probe)) return 'must not contain a port';
  if (url.pathname.includes('//')) return 'has an empty path segment (//)';
  // PLUS (not in a4aebb7): no percent escape at all in the path, outside the {name} placeholder (which `probe` has
  // already replaced). The Directory's rule above refuses only an escape of an unreserved character; %2F and %2E%2E
  // are other spellings of a path the URL does not show.
  if (url.pathname.includes('%') || /^https:\/\/[^/?#]*\/[^?#]*%/.test(probe)) return 'must not contain a percent escape in the path (write the character itself)';
  // The literal text must be the URL's own spelling, so that what is checked is
  // what is published (no %2e dot segments, no mixed-case host, no decoded host).
  if (url.href !== probe) return `is not written canonically (it would be ${url.href})`;
  return null;
}

// Whether the canonical url has `ovdb` as a complete path segment or as a
// subdomain. A subdomain is a host label that is left of the registered name:
// the registered name is the last two labels, or the last three under a two-label
// suffix such as co.uk. So ovdb.acme.com and x.ovdb.acme.co.uk count; ovdb.com and
// ovdb.co.uk (where ovdb is the registered name itself) do not. In the path,
// acme.com/ovdb/x counts and acme.com/ovdbx/x does not.
export function hasOvdbMarker(value) {
  const url = new URL(value);
  if (url.pathname.split('/').includes('ovdb')) return true;
  const labels = url.hostname.toLowerCase().split('.');
  const suffixLabels = twoLabelSuffixes.has(labels.slice(-2).join('.')) ? 2 : 1;
  return labels.slice(0, labels.length - suffixLabels - 1).includes('ovdb');
}

// ---- scripts/lib/directory.mjs and scripts/lib/git.mjs @ a4aebb7 ----

// A problem with `value` as a database's canonical url, or null: a public https URL without a trailing
// slash, with `ovdb` as a complete path segment or as a subdomain (see hasOvdbMarker).
export function canonicalUrlProblem(value) {
  const problem = publicHttpsProblem(value);
  if (problem) return problem;
  if (value.endsWith('/')) return 'must not have a trailing slash';
  if (!hasOvdbMarker(value)) return 'must have ovdb as a complete path segment or as a subdomain (https://acme.com/ovdb/sales or https://ovdb.acme.com/sales)';
  return null;
}

// A database id: the record key and the manifest's id.
export const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const maxIdLength = 80;
export const enginePattern = /^[A-Za-z][A-Za-z0-9_.+-]{0,39}$/;

// A path inside a repository: relative, no "..", no glob characters.
const filePathPattern = /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*(?:^|\/)\.(?:\/|$))[A-Za-z0-9_.\/-]+$/;
export const isRepositoryPath = (path) => typeof path === 'string' && filePathPattern.test(path) && !path.endsWith('/');

// ---- not the Directory's ----

export const maxHomepageLength = 200;
const homepageHost = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const homepagePath = /^\/[A-Za-z0-9._~/-]*$/;

// A problem with `value` as a manifest's `homepage`, or null. On top of publicHttpsProblem (so on top of the
// Directory's rules): at most 200 characters; the host is dot-separated labels of lower-case ASCII letters,
// digits and hyphen (no leading or trailing hyphen in a label), at least two labels, no port, no userinfo;
// the path has only A-Z a-z 0-9 . _ ~ / and -, no percent escape, no `//`, no `.` or `..` segment. So the
// URL is plain text that needs no escaping in an HTML attribute, a JSON string or a command line.
export function homepageProblem(value) {
  if (typeof value !== 'string') return 'must be a public https URL';
  if (value.length > maxHomepageLength) return `must be at most ${maxHomepageLength} characters`;
  const problem = publicHttpsProblem(value);
  if (problem) return problem;
  const [, authority, path] = /^https:\/\/([^/]*)(\/.*)$/.exec(value) ?? [];
  if (authority === undefined) return 'must be https://<host>/<path>';
  if (!homepageHost.test(authority)) return 'must have a host of lower-case ASCII letters, digits and hyphens in dot-separated labels (at least two, no port, no userinfo)';
  if (!homepagePath.test(path)) return 'must have a path of only letters, digits and . _ ~ / - (no percent escape, quote, space or other character)';
  if (path.split('/').some((segment, index, all) => segment === '.' || segment === '..' || (segment === '' && index > 0 && index < all.length - 1))) return 'must not have a . or .. or empty path segment';
  return null;
}
