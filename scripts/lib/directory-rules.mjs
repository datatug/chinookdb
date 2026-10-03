// The OVDB Directory's own rules for what a manifest publishes, ported for the offline pre-check
// (CC0-1.0, like the Directory's files).
//
// MIRRORS `scripts/lib/urls.mjs` and `scripts/lib/directory.mjs` of openvaultdb/directory: publicHttpsProblem,
// hostProblem, hasOvdbMarker and homepageProblem are copied from urls.mjs (the file's opening comment is not
// repeated; it includes the refusal of any port, even :443, and of any percent escape in a path), and from
// directory.mjs the canonical-url rule (urlProblem), the id pattern (at most 80 characters), the
// deployment.engine pattern and the `homepage` field check, and from git.mjs isRepositoryPath. When the
// Directory changes one of them, change it here. The list of single-field edits in scripts/test-model.mjs
// ("the checker refuses every one of ...") pins the agreement: each edit was refused by the Directory's own
// manifestProblems when it was added, and the checker must refuse it too.

// ---- scripts/lib/urls.mjs ----

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
  // The parser drops the default port, so look at the text: any ":" in the authority is a port.
  if (probe.slice('https://'.length).split('/')[0].includes(':')) return 'must not name a port (not even :443): a deployment is reached on the default https port';
  if (url.pathname.includes('//')) return 'has an empty path segment (//)';
  if (url.pathname.includes('%')) return 'must not contain a percent escape in the path (write the character itself, or leave it out)';
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

// What the index guarantees about a manifest's `homepage`, on top of publicHttpsProblem (https, no
// userinfo, query or fragment, no port, a public host written canonically): at most 200 characters; a
// lower-case host of two or more dot-separated labels of ASCII letters, digits and hyphen (no label starts
// or ends with a hyphen); a path of only A-Z a-z 0-9 . _ ~ / - (no percent escape, no quote, ampersand or
// other punctuation). A site that shows the value must still HTML-escape it, and must not put it in a
// single-quoted or unquoted attribute.
export const homepageMaxLength = 200;
const homepageLabel = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
export function homepageProblem(value) {
  const problem = publicHttpsProblem(value);
  if (problem) return problem;
  if (value.length > homepageMaxLength) return `is longer than ${homepageMaxLength} characters`;
  const url = new URL(value);
  const labels = url.hostname.split('.');
  if (labels.length < 2 || !labels.every((label) => homepageLabel.test(label))) return `host ${url.hostname} must be lower-case labels of ASCII letters, digits and hyphen (none starting or ending with a hyphen), at least two, separated by dots`;
  if (!/^[A-Za-z0-9._~/-]*$/.test(url.pathname)) return 'path may only use A-Z a-z 0-9 . _ ~ / and - (no quote, ampersand, percent escape or other punctuation)';
  return null;
}

// ---- the rule for every URL field of a manifest ----

const urlLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const urlPath = /^[A-Za-z0-9._~/-]*$/;

// A problem with `value` as a URL a manifest publishes, or null: publicHttpsProblem (the Directory's rule) and, on top
// of it, one plain spelling for every URL field, so that it is text that needs no escaping in an HTML attribute, a JSON
// string or a command line, whatever a page does with it: a host of lower-case ASCII letters, digits and hyphen in
// dot-separated labels (1 to 63 characters each, none starting or ending with a hyphen, at least two, 253 characters in
// all, no trailing dot); no port; a path of only A-Z a-z 0-9 . _ ~ / and - (and, with `template`, the one literal {name}
// of recordset_page), no percent escape, no `//`, no dot segment. This is at least as strict as the Directory's rule,
// and stricter wherever that is looser; the 200-character cap is homepage's alone.
export function manifestUrlProblem(value, options = {}) {
  const problem = publicHttpsProblem(value, options);
  if (problem) return problem;
  const [, authority, path] = /^https:\/\/([^/]*)(\/.*)$/.exec(value) ?? [];
  if (authority === undefined) return 'must be https://<host>/<path>';
  const labels = authority.split('.');
  if (authority.length > 253 || labels.length < 2 || !labels.every((label) => urlLabel.test(label))) return `host ${authority} must be lower-case ASCII letters, digits and hyphen in dot-separated labels (1 to 63 characters each, none starting or ending with a hyphen, at least two, 253 characters in all)`;
  const plainPath = options.template ? path.replace('{name}', '') : path;
  if (!urlPath.test(plainPath)) return 'path may only use A-Z a-z 0-9 . _ ~ / and - (no quote, ampersand, parenthesis, percent escape or other punctuation)';
  return null;
}

// ---- scripts/lib/directory.mjs and scripts/lib/git.mjs ----

// A problem with `value` as a database's canonical url, or null: a public https URL without a trailing
// slash, with `ovdb` as a complete path segment or as a subdomain (see hasOvdbMarker).
export function canonicalUrlProblem(value) {
  const problem = manifestUrlProblem(value);
  if (problem) return problem;
  if (value.endsWith('/')) return 'must not have a trailing slash';
  if (!hasOvdbMarker(value)) return 'must have ovdb as a complete path segment or as a subdomain (https://acme.com/ovdb/sales or https://ovdb.acme.com/sales)';
  return null;
}

// A problem with the manifest's `homepage` as the Directory checks the field, or null.
// The Directory's own homepage rule first, then the plain spelling every URL field has (label lengths, host length).
export const homepageFieldProblem = (value) => (typeof value === 'string' && value !== '' ? homepageProblem(value) ?? manifestUrlProblem(value) : 'is not a URL (leave homepage out when the database has no website)');

// A database id: the record key and the manifest's id.
export const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const maxIdLength = 80;
export const enginePattern = /^[A-Za-z][A-Za-z0-9_.+-]{0,39}$/;

// A path inside a repository: relative, no "..", no glob characters.
const filePathPattern = /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*(?:^|\/)\.(?:\/|$))[A-Za-z0-9_.\/-]+$/;
export const isRepositoryPath = (path) => typeof path === 'string' && filePathPattern.test(path) && !path.endsWith('/');
