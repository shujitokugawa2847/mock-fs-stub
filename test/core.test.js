import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockFS, Stats, createError } from '../src/index.js';

// All tests use a deterministic clock returning a fixed ms count. We never read the
// machine's wall clock in a test, because a test that passes on a fast machine and fails
// on a slow one is a broken test. We bump the fake clock explicitly where we need to see
// mtime change between writes.
let clockValue = 1000;
const clock = () => clockValue;

function freshFs() {
  clockValue = 1000;
  return new MockFS(clock);
}

test('writeFile creates a file that readFile returns verbatim', () => {
  const fs = freshFs();
  fs.writeFileSync('/a/b.txt', 'hello');
  assert.equal(fs.readFileSync('/a/b.txt'), 'hello');
});

test('writeFile auto-creates intermediate directories', () => {
  const fs = freshFs();
  fs.writeFileSync('/x/y/z.txt', 'deep');
  assert.equal(fs.readFileSync('/x/y/z.txt'), 'deep');
  assert.equal(fs.readFileSync('/x/y/z.txt'), 'deep');
  assert.ok(fs.existsSync('/x/y'));
});

test('readFile on missing path throws ENOENT with path and syscall', () => {
  const fs = freshFs();
  assert.throws(
    () => fs.readFileSync('/nope.txt'),
    (err) => err.code === 'ENOENT' && err.path === '/nope.txt' && err.syscall === 'read'
  );
});

test('readFile on a directory throws EISDIR', () => {
  const fs = freshFs();
  fs.mkdirSync('/dir');
  assert.throws(
    () => fs.readFileSync('/dir'),
    (err) => err.code === 'EISDIR'
  );
});

test('readFile through a file segment throws ENOTDIR', () => {
  const fs = freshFs();
  fs.writeFileSync('/file', 'data');
  assert.throws(
    () => fs.readFileSync('/file/inside'),
    (err) => err.code === 'ENOTDIR'
  );
});

test('mkdir on existing path throws EEXIST', () => {
  const fs = freshFs();
  fs.mkdirSync('/d');
  assert.throws(
    () => fs.mkdirSync('/d'),
    (err) => err.code === 'EEXIST'
  );
});

test('mkdir on missing parent throws ENOENT (no auto-create)', () => {
  const fs = freshFs();
  assert.throws(
    () => fs.mkdirSync('/a/b/c'),
    (err) => err.code === 'ENOENT'
  );
  assert.equal(fs.existsSync('/a'), false);
});

test('readdir returns entry names in insertion order', () => {
  const fs = freshFs();
  fs.writeFileSync('/dir/c', '1');
  fs.writeFileSync('/dir/a', '2');
  fs.writeFileSync('/dir/b', '3');
  // c, a, b — insertion order, not alphabetical. We document this so callers know.
  assert.deepEqual(fs.readdirSync('/dir'), ['c', 'a', 'b']);
});

test('readdir on a file throws ENOTDIR', () => {
  const fs = freshFs();
  fs.writeFileSync('/f', 'x');
  assert.throws(
    () => fs.readdirSync('/f'),
    (err) => err.code === 'ENOTDIR'
  );
});

test('unlink removes a file', () => {
  const fs = freshFs();
  fs.writeFileSync('/f', 'x');
  fs.unlinkSync('/f');
  assert.equal(fs.existsSync('/f'), false);
});

test('unlink on a directory throws EISDIR', () => {
  const fs = freshFs();
  fs.mkdirSync('/d');
  assert.throws(
    () => fs.unlinkSync('/d'),
    (err) => err.code === 'EISDIR'
  );
});

test('rmdir on a non-empty directory throws ENOTEMPTY', () => {
  const fs = freshFs();
  fs.mkdirSync('/d');
  fs.writeFileSync('/d/f', 'x');
  assert.throws(
    () => fs.rmdirSync('/d'),
    (err) => err.code === 'ENOTEMPTY'
  );
});

test('rmdir on a file throws ENOTDIR', () => {
  const fs = freshFs();
  fs.writeFileSync('/f', 'x');
  assert.throws(
    () => fs.rmdirSync('/f'),
    (err) => err.code === 'ENOTDIR'
  );
});

test('statSync reports file kind, size, and deterministic mtime', () => {
  const fs = freshFs();
  fs.writeFileSync('/f', 'abcd');
  const s = fs.statSync('/f');
  assert.equal(s.isFile(), true);
  assert.equal(s.isDirectory(), false);
  assert.equal(s.size, 4);
  assert.equal(s.mtimeMs, 1000);
});

test('statSync reports directory kind with zero size', () => {
  const fs = freshFs();
  fs.mkdirSync('/d');
  const s = fs.statSync('/d');
  assert.equal(s.isFile(), false);
  assert.equal(s.isDirectory(), true);
  assert.equal(s.size, 0);
});

test('stat mtimeMs reflects the injected clock at call time', () => {
  const fs = freshFs();
  fs.writeFileSync('/f', 'x');
  assert.equal(fs.statSync('/f').mtimeMs, 1000);
  clockValue = 2000;
  assert.equal(fs.statSync('/f').mtimeMs, 2000);
});

test('stat is a real Stats instance', () => {
  const fs = freshFs();
  fs.writeFileSync('/f', 'x');
  assert.ok(fs.statSync('/f') instanceof Stats);
});

test('existsSync returns false for missing paths without throwing', () => {
  const fs = freshFs();
  assert.equal(fs.existsSync('/missing'), false);
  fs.writeFileSync('/missing', 'x');
  assert.equal(fs.existsSync('/missing'), true);
});

test('writeFileSync to an existing directory path throws EISDIR', () => {
  const fs = freshFs();
  fs.mkdirSync('/d');
  assert.throws(
    () => fs.writeFileSync('/d', 'data'),
    (err) => err.code === 'EISDIR'
  );
});

test('writeFileSync overwrites an existing file', () => {
  const fs = freshFs();
  fs.writeFileSync('/f', 'one');
  fs.writeFileSync('/f', 'two');
  assert.equal(fs.readFileSync('/f'), 'two');
});

test('paths with "." and duplicate separators are normalized', () => {
  const fs = freshFs();
  fs.writeFileSync('/a/./b//c.txt', 'x');
  assert.equal(fs.readFileSync('/a/b/c.txt'), 'x');
});

test('".." in a path is rejected as EINVAL', () => {
  const fs = freshFs();
  fs.writeFileSync('/a.txt', 'x');
  assert.throws(
    () => fs.readFileSync('/../a.txt'),
    (err) => err.code === 'EINVAL'
  );
});

test('reset clears the filesystem back to an empty root', () => {
  const fs = freshFs();
  fs.writeFileSync('/f', 'x');
  fs.mkdirSync('/d');
  fs.reset();
  assert.equal(fs.existsSync('/f'), false);
  assert.equal(fs.existsSync('/d'), false);
});

test('createError produces an object with the expected shape', () => {
  const err = createError('ENOENT', 'no such file or directory', '/p', 'open');
  assert.equal(err.code, 'ENOENT');
  assert.equal(err.path, '/p');
  assert.equal(err.syscall, 'open');
  assert.equal(typeof err.errno, 'number');
});
