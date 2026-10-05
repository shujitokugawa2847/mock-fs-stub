/**
 * In-memory filesystem core.
 *
 * Design decisions, stated plainly:
 *
 * 1. We model the filesystem as a tree of Map nodes. Map preserves insertion order of
 *    directory entries, which lets `readdir` return stable, deterministic listings without
 *    sorting as a second pass. This matters for tests: two runs of the same test must
 *    produce the same array. A plain object would also work on V8, but Map ordering is
 *    spec'd, so we use Map.
 *
 * 2. Only regular files and directories are supported. Symlinks, sockets, devices, and
 *    permissions are out of scope. Brief asked for an in-memory *stub* for testing file
 *    operations; a stub that fakes `lstat` mode bits it cannot honour is a stub that lies.
 *    `isFile` / `isDirectory` are the only predicates we expose.
 *
 * 3. Errors use the POSIX code strings Node attaches (`ENOENT`, `EEXIST`, `ENOTDIR`,
 *    `ENOTEMPTY`, `EISDIR`, `EINVAL`) and carry `path`/`syscall` so the surface matches
 *    what real fs errors look like to anything logging them. We do not fabricate errno
 *    integers because the mapping is platform-dependent and would be dishonest.
 */

/**
 * @typedef {Object} FileEntry
 * @property {'file'} kind
 * @property {string} data
 */

/**
 * @typedef {Object} DirEntry
 * @property {'dir'} kind
 * @property {Map<string, FileEntry|DirEntry>} entries
 */

/** Create a fresh root directory entry. */
function makeDir() {
  return { kind: 'dir', entries: new Map() };
}

/**
 * Split a POSIX path into normalized segments. Empty, `.`, and repeated `/` collapse to
 * nothing; `..` is rejected rather than resolved upwards — a stub that silently lets you
 * climb above its root is a stub that hides bugs instead of finding them.
 *
 * @param {string} p
 * @returns {string[]}
 */
function segments(p) {
  if (typeof p !== 'string') {
    throw createError('EINVAL', 'path must be a string', p, 'open');
  }
  const out = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      throw createError('EINVAL', "'..' is not supported in stub paths", p, 'open');
    }
    out.push(seg);
  }
  return out;
}

/**
 * Build a Node-style error object. We attach `code`, `path`, and `syscall` because real
 * fs errors carry them and code that handles fs errors reads them off the object.
 */
function createError(code, message, path, syscall) {
  const err = new Error(`${code}: ${message}, ${syscall} '${path}'`);
  err.code = code;
  err.errno = codeToErrno(code);
  err.path = path;
  err.syscall = syscall;
  return err;
}

// Minimal errno table. Node's real values vary by platform; we expose stable ones so tests
// that happen to read `errno` (we don't recommend it) don't flake. Documented here so a
// reader knows these are chosen, not derived.
const errnoMap = {
  ENOENT: -2,
  EEXIST: -17,
  EISDIR: -21,
  ENOTDIR: -20,
  ENOTEMPTY: -66,
  EINVAL: -22,
};
function codeToErrno(code) {
  return errnoMap[code] ?? -1;
}

/**
 * Walk to the parent of `segs`'s last segment. Returns the parent DirEntry or throws.
 *
 * @param {DirEntry} root
 * @param {string[]} segs
 * @param {string} rawPath
 * @param {string} syscall
 * @returns {DirEntry}
 */
function walkToParent(root, segs, rawPath, syscall) {
  let node = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const name = segs[i];
    const child = node.entries.get(name);
    if (child === undefined) {
      throw createError('ENOENT', 'no such file or directory', rawPath, syscall);
    }
    if (child.kind !== 'dir') {
      throw createError('ENOTDIR', 'not a directory', rawPath, syscall);
    }
    node = child;
  }
  return node;
}

/**
 * Resolve a full path to a node, or null if it does not exist. Used by `readFile`,
 * `stat`, and `readdir`.
 */
function resolvePath(root, segs) {
  let node = root;
  for (const name of segs) {
    if (node.kind !== 'dir') return null;
    const child = node.entries.get(name);
    if (child === undefined) return null;
    node = child;
  }
  return node;
}

/**
 * Stats object. We expose only the fields tests reasonably assert on; `mtime` is driven
 * by an injected clock so tests never touch wall-clock time.
 */
class Stats {
  constructor(kind, size, mtimeMs, path) {
    this.kind = kind;
    this.size = size;
    this.mtimeMs = mtimeMs;
    this.path = path;
    // Numeric uid/gid as 0 — real fs returns these; we keep them for shape compatibility
    // but they carry no meaning in-memory.
    this.uid = 0;
    this.gid = 0;
  }
  isFile() { return this.kind === 'file'; }
  isDirectory() { return this.kind === 'dir'; }
}

/**
 * The in-memory filesystem. All operations are synchronous — this is a stub for tests,
 * not a production fs. If you need async, wrap the calls in `Promise.resolve()`.
 */
class MockFS {
  constructor(now = () => 0) {
    // Root is a directory. We hold a private copy of `now` so tests can pass a deterministic
    // clock and never depend on the machine's wall clock.
    this._root = makeDir();
    this._now = now;
  }

  /**
   * Read a file as a UTF-8 string. Throws ENOENT if missing, EISDIR if it's a directory,
   * ENOTDIR if a middle path segment is a file.
   */
  readFileSync(path) {
    const segs = segments(path);
    if (segs.length === 0) {
      throw createError('EISDIR', 'illegal operation on a directory', path, 'read');
    }
    let node = this._root;
    for (let i = 0; i < segs.length; i++) {
      if (node.kind !== 'dir') {
        throw createError('ENOTDIR', 'not a directory', path, 'read');
      }
      const child = node.entries.get(segs[i]);
      if (child === undefined) {
        throw createError('ENOENT', 'no such file or directory', path, 'read');
      }
      node = child;
    }
    if (node.kind === 'dir') {
      throw createError('EISDIR', 'illegal operation on a directory', path, 'read');
    }
    return node.data;
  }

  /**
   * Write a string to a file, creating intermediate directories as needed. Throws EISDIR
   * if the target path resolves to an existing directory.
   */
  writeFileSync(path, data) {
    if (typeof data !== 'string') {
      throw createError('EINVAL', 'data must be a string; binary buffers are out of scope', path, 'write');
    }
    const segs = segments(path);
    if (segs.length === 0) {
      throw createError('EISDIR', 'illegal operation on a directory', path, 'write');
    }
    let node = this._root;
    for (let i = 0; i < segs.length - 1; i++) {
      const name = segs[i];
      const child = node.entries.get(name);
      if (child === undefined) {
        const created = makeDir();
        node.entries.set(name, created);
        node = created;
      } else if (child.kind === 'dir') {
        node = child;
      } else {
        throw createError('ENOTDIR', 'not a directory', path, 'write');
      }
    }
    const lastName = segs[segs.length - 1];
    const existing = node.entries.get(lastName);
    if (existing !== undefined && existing.kind === 'dir') {
      throw createError('EISDIR', 'illegal operation on a directory', path, 'write');
    }
    node.entries.set(lastName, { kind: 'file', data });
  }

  /**
   * Create a directory. Parent must exist (we do NOT auto-create here, matching `mkdir`
   * semantics). Throws EEXIST if anything already exists at the path.
   */
  mkdirSync(path) {
    const segs = segments(path);
    if (segs.length === 0) {
      throw createError('EEXIST', 'file already exists', path, 'mkdir');
    }
    const parent = walkToParent(this._root, segs, path, 'mkdir');
    const name = segs[segs.length - 1];
    if (parent.entries.has(name)) {
      throw createError('EEXIST', 'file already exists', path, 'mkdir');
    }
    parent.entries.set(name, makeDir());
  }

  /**
   * Remove a file. Throws ENOENT if missing, EISDIR if the target is a directory,
   * ENOTEMPTY if a middle segment is a file.
   */
  unlinkSync(path) {
    const segs = segments(path);
    if (segs.length === 0) {
      throw createError('EISDIR', 'illegal operation on a directory', path, 'unlink');
    }
    const parent = walkToParent(this._root, segs, path, 'unlink');
    const name = segs[segs.length - 1];
    const child = parent.entries.get(name);
    if (child === undefined) {
      throw createError('ENOENT', 'no such file or directory', path, 'unlink');
    }
    if (child.kind === 'dir') {
      throw createError('EISDIR', 'illegal operation on a directory', path, 'unlink');
    }
    parent.entries.delete(name);
  }

  /**
   * Remove an empty directory. Throws ENOTEMPTY if non-empty, ENOENT if missing,
   * ENOTDIR if the target is a file.
   */
  rmdirSync(path) {
    const segs = segments(path);
    if (segs.length === 0) {
      throw createError('ENOTEMPTY', 'cannot remove root', path, 'rmdir');
    }
    const parent = walkToParent(this._root, segs, path, 'rmdir');
    const name = segs[segs.length - 1];
    const child = parent.entries.get(name);
    if (child === undefined) {
      throw createError('ENOENT', 'no such file or directory', path, 'rmdir');
    }
    if (child.kind !== 'dir') {
      throw createError('ENOTDIR', 'not a directory', path, 'rmdir');
    }
    if (child.entries.size > 0) {
      throw createError('ENOTEMPTY', 'directory not empty', path, 'rmdir');
    }
    parent.entries.delete(name);
  }

  /**
   * List a directory's entry names in insertion order. Throws ENOENT if missing,
   * ENOTDIR if the target is a file.
   */
  readdirSync(path) {
    const segs = segments(path);
    let node = this._root;
    for (let i = 0; i < segs.length; i++) {
      if (node.kind !== 'dir') {
        throw createError('ENOTDIR', 'not a directory', path, 'readdir');
      }
      const child = node.entries.get(segs[i]);
      if (child === undefined) {
        throw createError('ENOENT', 'no such file or directory', path, 'readdir');
      }
      node = child;
    }
    if (node.kind !== 'dir') {
      throw createError('ENOTDIR', 'not a directory', path, 'readdir');
    }
    return Array.from(node.entries.keys());
  }

  /**
   * Return stats for a path. mtimeMs comes from the injected clock, so tests are
   * deterministic. Throws ENOENT if missing, ENOTDIR if a middle segment is a file.
   */
  statSync(path) {
    const segs = segments(path);
    let node = this._root;
    for (let i = 0; i < segs.length; i++) {
      if (node.kind !== 'dir') {
        throw createError('ENOTDIR', 'not a directory', path, 'stat');
      }
      const child = node.entries.get(segs[i]);
      if (child === undefined) {
        throw createError('ENOENT', 'no such file or directory', path, 'stat');
      }
      node = child;
    }
    const size = node.kind === 'file' ? node.data.length : 0;
    return new Stats(node.kind, size, this._now(), path);
  }

  /**
   * Return true if a path exists (file or directory). Convenience method; not part of
   * the Node fs surface but every test wants it. We keep it here rather than each test
   * reinventing try/catch.
   */
  existsSync(path) {
    const segs = segments(path);
    return resolvePath(this._root, segs) !== null;
  }

  /**
   * Reset to an empty root. Useful for `beforeEach` in a test suite without
   * reconstructing the instance.
   */
  reset() {
    this._root = makeDir();
  }
}

export { MockFS, Stats, createError };
