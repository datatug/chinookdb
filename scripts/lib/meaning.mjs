// What this repository reads from meaning files and from the universal concepts they extend: the
// concept and model reference grammar, the ?ref= pins, a checkout of github.com/meaninggraph/core at a pinned
// commit, and the known values of a concept, so that the data a bound column holds can be compared with them.
// Whether the meaning file itself is valid (the schema, references, extends, units, measures, binding roles) is
// checked by the released `meaninggraph` tool: pnpm check:meaning (scripts/check-meaning.mjs).
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cleanGitEnv } from './git-env.mjs';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

// Where meaning:// repositories are read from, keyed by {host}/{org}/{repo}.
// `git` fetches the repository at the ?ref= pin that the references carry (see
// checkoutGit); `dir` reads a local directory (relative to the repository
// root). The universal concepts come from the one pinned checkout of
// github.com/meaninggraph/core, which is also the checkout `meaninggraph check`
// is given (--graph): the resolver returns its `dir`.
export const coreRepo = 'github.com/meaninggraph/core';
export const meaningSources = {
  [coreRepo]: { git: 'https://github.com/meaninggraph/core' },
};

const conceptId = '[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*';
const bareRefPattern = new RegExp(`^${conceptId}$`);
const conceptRefPattern = new RegExp(`^meaning://([A-Za-z0-9.-]+(?:/[A-Za-z0-9._-]+)+)/(${conceptId})(?:\\?ref=([A-Za-z0-9._/-]+))?$`);
const modelRefPattern = /^modelspec:\/\/((?:[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._-]+)+)?)\/([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)(?:\?ref=([A-Za-z0-9._/-]+))?$/;

// A bare id is a concept in the same repository; meaning://{host}/{org}/{repo}/{id}
// is a concept in another one. The last path segment is the concept id.
export function parseConceptRef(ref) {
  if (bareRefPattern.test(ref)) return { id: ref };
  const match = conceptRefPattern.exec(ref);
  if (!match) return null;
  return { repo: match[1], id: match[2], ref: match[3] };
}

// modelspec:///{module}.{Name} (same repository) or modelspec://{host}/{org}/{repo}/{module}.{Name}.
export function parseModelRef(ref) {
  const match = modelRefPattern.exec(ref);
  if (!match) return null;
  return { repo: match[1] || undefined, module: match[2], name: match[3], ref: match[4] };
}

// Loads every *.meaning.yaml file directly in `dir` (the repository root; subdirectories are not
// searched) as one repository's concepts. The result also carries `dir` and, when
// given, the repository's own `address` ({host}/{org}/{repo}): a meaning://
// reference to that address inside it is a reference to itself, like a bare id.
export function loadMeaningDir(dir, address) {
  const files = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.meaning.yaml')).map((entry) => entry.name).sort().map((name) => {
    const path = join(dir, name);
    return { path, doc: parseYaml(readFileSync(path, 'utf8')) };
  });
  return { ...indexConcepts(files, address), dir };
}

export function indexConcepts(files, address) {
  const concepts = new Map();
  const problems = [];
  for (const file of files) {
    for (const concept of file.doc?.concepts ?? []) {
      if (concepts.has(concept.id)) problems.push(`concept ${concept.id} is declared twice (${concepts.get(concept.id).path} and ${file.path})`);
      else concepts.set(concept.id, { concept, path: file.path, doc: file.doc });
    }
  }
  return { files, concepts, problems, address };
}

// Every meaning:// reference written anywhere in a meaning file, parsed.
export function conceptReferences(doc) {
  const found = [];
  const walk = (value) => {
    if (typeof value === 'string') { const parsed = value.startsWith('meaning://') && parseConceptRef(value); if (parsed) found.push(parsed); }
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(doc);
  return found;
}

// The distinct ?ref= pins that a meaning file's references to `repo` carry.
export const pinsOf = (doc, repo) => [...new Set(conceptReferences(doc).filter((ref) => ref.repo === repo).map((ref) => ref.ref ?? ''))].sort();

const commit = /^[0-9a-f]{40}$/;
// Errors that another attempt cannot fix (the ref or repository is not there).
const permanentFailure = /couldn't find remote ref|not our ref|invalid refspec|not found|does not appear to be a git repository|could not read from remote|authentication failed/i;
const gitFailure = (error) => String(error.stderr ?? error.message).trim().split('\n').filter(Boolean).pop() ?? 'git failed';
// GIT_NO_REPLACE_OBJECTS: a replace ref in a repository must never make one commit read as another. The
// matching -c flags are in `hardening`, which goes in front of every git call here, so that they also hold for
// a `run` that is not this one.
const defaultRun = (command, args) => execFileSync(command, args, { stdio: 'pipe', env: { ...cleanGitEnv(), GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' } }).toString();
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// What no git call here may be told by the repository it reads: no hook (core.hooksPath), no filesystem
// monitor command (core.fsmonitor: git status would run it), no replace ref (core.useReplaceRefs).
export const hardening = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.useReplaceRefs=false'];
const lstatOrNull = (path) => { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

// Fetches `ref` of the git repository at `url` and returns { dir, release }.
//
// A full commit id is immutable, so with a `cacheDir` the checkout is kept there under that id (a CI cache may
// restore it). An entry is reused only when it is exactly that commit: HEAD is the commit, no tracked file
// differs, there is no untracked or ignored file or directory (whatever the exclude rules say), and no hidden index
// flag (assume-unchanged, skip-worktree, a sparse checkout). A sound entry is only read. An entry that is not is
// repaired in place (tracked files rewritten from the commit, everything untracked removed) and looked at again;
// one that cannot be repaired is thrown away and fetched anew. An entry or a `.git` that is a symbolic link is
// never followed: the link itself is replaced, and what it pointed at is not touched. `release` then does nothing.
// Any other ref, or no cacheDir, uses a temporary clone that `release` removes (in `tempDir`). A failed fetch is
// retried (`retries` attempts, a growing pause between them) and never leaves a clone behind.
//
// Several processes may fill and read one cache entry at the same time (the suite runs in parallel on a
// developer's machine, and CI shards share a cache). A checkout is always made in a private directory and renamed
// into place, which is atomic: the loser of the rename uses the winner's directory once it is verified. A git
// failure while verifying (another process holds the index lock) is looked at again before an entry is
// condemned. An entry is removed only when this process examined it and condemned it: it is renamed aside, and if
// what was moved is not the directory that was examined (another process replaced the entry in between) it is put
// back untouched and looked at afresh. Parked entries (`.discard-<pid>-<time>-*`) whose process is gone or that are
// older than `discardStaleMs` are removed on entry, never a young one of a live process, and so is a `.meaning-source-*`
// work directory older than `staleMs`. Every git call is hardened (see `hardening`, --template=
// on init, --end-of-options before a url, ref or path). `run(command, args)` runs git; tests replace it, and
// Known gap (datatug/chinookdb#16): git still runs in the entry, so a filter driver in the entry's own configuration runs.
// `onCondemned(dir)` is called between the verdict and the removal, and `onParked(aside)` between parking and the identity
// comparison, where a test makes another process act.
export function checkoutGit(url, ref, { cacheDir, tempDir = tmpdir(), run = defaultRun, retries = 3, retryDelayMs = 1000, staleMs = 60 * 60 * 1000, discardStaleMs = 10 * 60 * 1000, onCondemned, onParked } = {}) {
  const git = (dir, ...args) => run('git', [...hardening, '-C', dir, ...args]);
  // git is pointed at dir/.git explicitly, so that a directory that is not a repository of its own (inside the
  // cache, inside the project's own repository) is never reset or cleaned by mistake.
  const own = (dir, ...args) => run('git', [...hardening, '--git-dir', join(dir, '.git'), '--work-tree', dir, ...args]);
  // Read only: dir is exactly the commit (no change, nothing untracked or ignored, empty directories included, no
  // hidden index flag).
  const exact = (dir) => own(dir, '--no-optional-locks', 'status', '--porcelain').trim() === ''
    && own(dir, '--no-optional-locks', 'clean', '-n', '-d', '-x', '-f', '-f').trim() === ''
    && own(dir, '--no-optional-locks', 'ls-files', '-v').split('\n').filter(Boolean).every((line) => line.startsWith('H '));
  // True when `dir` is exactly the commit `expected`, making it so first if that can be done; false when it cannot be trusted.
  const pristine = (dir, expected) => {
    try {
      if (!lstatSync(dir).isDirectory() || !lstatSync(join(dir, '.git')).isDirectory()) return false; // lstat: a link is not followed
    } catch { return false; }
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (own(dir, 'rev-parse', '--verify', 'HEAD').trim() !== expected) return false;
        if (exact(dir)) return true;
        own(dir, 'read-tree', '--reset', '-u', 'HEAD');
        own(dir, 'checkout-index', '--all', '--force');
        own(dir, 'clean', '-ffdxq');
        if (exact(dir)) return true;
      } catch { /* git failed, most likely on another process's lock: look again */ }
      if (attempt < 3) pause(100 * attempt);
    }
    return false;
  };
  // Removes the entry this process examined (`examined`: its lstat) and condemned. 'discarded', 'gone' (nothing there any
  // more), or 'replaced' (another process put a different entry there first, which was put back and not touched). The entry
  // is parked as `.discard-<pid>-<time>-<uuid>`: the sweep (below) leaves a name whose process is alive and that is young,
  // so that no other process removes what this one is about to put back.
  const discard = (dir, examined, parent) => {
    const aside = join(parent, `.discard-${process.pid}-${Date.now()}-${randomUUID()}`);
    try { renameSync(dir, aside); } catch (error) {
      if (error.code === 'ENOENT') return 'gone';
      throw new Error(`cannot move the unusable cache entry ${dir} aside: ${error.message}`);
    }
    onParked?.(aside);
    const moved = lstatOrNull(aside);
    if (moved === null) return 'gone'; // removed by a sweep (this process crashed and came back, or it took too long): nothing to put back
    if (moved.dev !== examined.dev || moved.ino !== examined.ino || moved.birthtimeMs !== examined.birthtimeMs) {
      try { renameSync(aside, dir); } catch (error) {
        // Another entry was made at `dir` meanwhile; the one moved aside is a duplicate that nobody reads from here. It is
        // left for the sweep, which removes it when this process is gone or ten minutes have passed.
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) {
          throw new Error(`cannot put the cache entry ${dir} back from ${aside}: ${error.code === 'ENOENT' ? 'it was removed by another process in the meantime (the entry another process was using is gone; run again)' : error.message}`);
        }
      }
      return 'replaced';
    }
    rmSync(aside, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    return 'discarded';
  };
  // Whether a process is alive: signal 0 only checks (EPERM: it exists, and is somebody else's).
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
  // What a crash left in the cache: parked entries whose process is gone or that are older than `discardStaleMs` (a live
  // process may be about to put one back), and work directories nobody has touched for `staleMs`. Links are never followed.
  const sweep = (parent) => {
    let names;
    try { names = readdirSync(parent); } catch { return; }
    for (const name of names) {
      const path = join(parent, name);
      const parked = /^\.discard-(\d+)-(\d+)-/.exec(name);
      const stale = parked
        ? !alive(Number(parked[1])) || Date.now() - Number(parked[2]) > discardStaleMs
        : name.startsWith('.discard-') ? Date.now() - (lstatOrNull(path)?.mtimeMs ?? Date.now()) > discardStaleMs // not a name this code makes: by age alone
          : name.startsWith('.meaning-source-') && Date.now() - (lstatOrNull(path)?.mtimeMs ?? Date.now()) > staleMs;
      if (stale) rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  };
  const kept = cacheDir && commit.test(ref) ? join(cacheDir, ref) : null;
  if (kept) {
    mkdirSync(cacheDir, { recursive: true });
    sweep(cacheDir);
    for (let attempt = 1; ; attempt++) {
      const found = lstatOrNull(kept);
      if (!found) break;
      if (!found.isDirectory()) {
        unlinkSync(kept); // a link or a file: the link itself goes, never what it points at
        break;
      }
      if (pristine(kept, ref)) return { dir: kept, release() {} };
      onCondemned?.(kept);
      if (discard(kept, found, cacheDir) === 'discarded') break;
      if (attempt >= 5) throw new Error(`the cache entry ${kept} keeps being replaced by other processes`);
    }
  }
  const parent = kept ? cacheDir : tempDir;
  mkdirSync(parent, { recursive: true });
  const work = mkdtempSync(join(parent, '.meaning-source-'));
  let done = false;
  try {
    run('git', [...hardening, 'init', '-q', '--template=', '--end-of-options', work]);
    for (let attempt = 1; ; attempt++) {
      try { git(work, 'fetch', '-q', '--depth', '1', '--end-of-options', url, ref); break; } catch (error) {
        if (attempt >= retries || permanentFailure.test(gitFailure(error))) throw new Error(`cannot fetch ${ref} from ${url}: ${gitFailure(error)}`);
        pause(retryDelayMs * attempt);
      }
    }
    git(work, 'checkout', '-q', '--end-of-options', 'FETCH_HEAD');
    if (commit.test(ref) && !pristine(work, ref)) throw new Error(`${url} at ${ref} did not check out that commit`);
    if (kept) {
      try { renameSync(work, kept); } catch (error) {
        // Another process filled the entry first: use its directory once it is verified.
        if (!['ENOTEMPTY', 'EEXIST'].includes(error.code) || !pristine(kept, ref)) throw error;
      }
    }
    done = true;
  } finally {
    if (!done || kept) rmSync(work, { recursive: true, force: true });
  }
  return kept ? { dir: kept, release() {} } : { dir: work, release: () => rmSync(work, { recursive: true, force: true }) };
}

// The cache for checkouts of immutable commits: MEANING_CACHE_DIR, or .cache/meaning-sources
// under the repository root (git-ignored; CI restores it keyed by the meaning files).
export const defaultCacheDir = (root) => process.env.MEANING_CACHE_DIR || join(root, '.cache', 'meaning-sources');

// Resolves meaning:// repositories through `sources` (see meaningSources) to
// { dir, files, concepts, problems, address } or { error }. Call `.dispose()` when done:
// it removes the temporary clones of refs that are not immutable commits.
export function createResolver({ root, sources = meaningSources, cacheDir = defaultCacheDir(root), run } = {}) {
  const cache = new Map();
  const releases = [];
  const resolve = (repo, ref) => {
    const source = sources[repo];
    if (!source) return { error: `no source configured for meaning://${repo}` };
    if (source.git && !ref) return { error: `meaning://${repo} is read from git and needs a ?ref= pin` };
    const key = `${repo}@${ref ?? ''}`;
    if (!cache.has(key)) {
      try {
        if (source.dir) cache.set(key, loadMeaningDir(join(root, source.dir), repo));
        else {
          const checkout = checkoutGit(source.git, ref, { cacheDir, run });
          releases.push(checkout.release);
          cache.set(key, loadMeaningDir(checkout.dir, repo));
        }
      } catch (error) {
        cache.set(key, { error: `meaning://${repo}?ref=${ref} cannot be read: ${error.message}` });
      }
    }
    return cache.get(key);
  };
  resolve.dispose = () => { for (const release of releases.splice(0)) release(); cache.clear(); };
  return resolve;
}

// Binding roles whose stored values name the concept's known values.
const valueRoles = ['value', 'display-name'];

// Resolves `ref` as written inside `repo` (a repository index from
// loadMeaningDir or indexConcepts): bare ids resolve in that repository, and so
// does a meaning:// reference to the repository's own address (no ?ref=), the
// rest through `resolve`. Returns { concept, repo } or null.
export function resolveConcept(ref, repo, resolve) {
  const parsed = ref && parseConceptRef(ref);
  if (!parsed) return null;
  const own = !parsed.repo || (parsed.ref === undefined && parsed.repo === repo.address);
  const target = own ? repo : resolve(parsed.repo, parsed.ref);
  if (!target || target.error) return null;
  const found = target.concepts.get(parsed.id);
  return found ? { concept: found.concept, repo: target } : null;
}

// The concept and its ancestors through extends, nearest first. Stops at a
// repeat, so a cycle (which meaninggraph reports) cannot loop.
export function lineage(concept, repo, resolve) {
  const chain = [];
  for (let node = { concept, repo }; node && chain.length < 50; node = resolveConcept(node.concept.extends, node.repo, resolve)) {
    if (chain.some((seen) => seen.concept === node.concept)) break;
    chain.push(node);
  }
  return chain;
}

// The nearest concept along the lineage that sets `key`, with the repository
// it is written in (bare ids in its value resolve there), or null.
export function inherited(concept, repo, key, resolve) {
  return lineage(concept, repo, resolve).find((node) => node.concept[key] !== undefined) ?? null;
}

// The known values of a concept: its own, or those of the entity named by its
// values-of (its own or inherited through extends). extends never passes
// values themselves: a kind of country attribute holds countries, but an
// entity that extends another is not a list of the parent's instances.
export function effectiveValues(concept, local, resolve) {
  if (concept.values) return concept.values;
  const domain = inherited(concept, local, 'values-of', resolve);
  if (!domain) return [];
  return resolveConcept(domain.concept['values-of'], domain.repo, resolve)?.concept.values ?? [];
}

// The known values that a stored value names. `match` is labels (labels and
// aliases in any language, ignoring case) or codes.<code> (that code, exactly).
export function matchValues(values, stored, match = 'labels') {
  if (match.startsWith('codes.')) {
    const code = match.slice('codes.'.length);
    return values.filter((value) => value.codes?.[code] === String(stored));
  }
  const key = String(stored).toLowerCase();
  return values.filter((value) => [...Object.values(value.labels ?? {}), ...Object.values(value.aliases ?? {}).flat()].some((word) => word.toLowerCase() === key));
}

// Checks that every distinct value stored in a column bound with role value
// or display-name names exactly one of the concept's known values (see
// effectiveValues), matched as the binding's `match` says. `data` is rows
// keyed by entity name.
export function valueCoverageProblems({ local, resolve, data }) {
  const problems = [];
  for (const { concept, path } of local.concepts.values()) {
    const values = effectiveValues(concept, local, resolve);
    if (values.length === 0) continue;
    for (const binding of concept.bindings ?? []) {
      if (!binding.property || !valueRoles.includes(binding.role)) continue;
      const match = binding.match ?? 'labels';
      const entity = parseModelRef(binding.model)?.name;
      const stored = new Set((data[entity] ?? []).map((row) => row[binding.property]).filter((value) => value !== null && value !== undefined));
      for (const value of stored) {
        const matches = matchValues(values, value, match);
        if (matches.length !== 1) problems.push(`${path}: concept ${concept.id}: ${entity}.${binding.property} value "${value}" matches ${matches.length === 0 ? 'no value' : `${matches.length} values (${matches.map((m) => m.id).join(', ')})`}${match === 'labels' ? '' : ` by ${match}`}`);
      }
    }
  }
  return problems;
}
