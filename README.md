mock-fs-stub
============

An in-memory filesystem stub implementing a subset of the Node `fs` synchronous
API, for tests that need to exercise file-handling code without touching disk.

```js
import { MockFS } from 'mock-fs-stub';

const fs = new MockFS(() => 0);   // optional clock function; default returns 0
fs.writeFileSync('/dir/file.txt', 'hello');
console.log(fs.readFileSync('/dir/file.txt'));   // 'hello'
console.log(fs.readdirSync('/dir'));             // ['file.txt']
console.log(fs.statSync('/dir/file.txt').size);  // 5
```

Exports:
- `MockFS` (default and named) — the filesystem class.
- `Stats` — the shape returned by `MockFS#statSync(path)`. Has `isFile()`,
  `isDirectory()`, `size`, `mtimeMs`, `path`.
- `createError(code, message, path, syscall)` — constructs the same error shape
  the library throws internally, for tests that compare against thrown errors.

Methods on `MockFS`: `readFileSync`, `writeFileSync`, `mkdirSync`, `rmdirSync`,
`unlinkSync`, `readdirSync`, `statSync`, `existsSync`, `reset`.

Why this exists
---------------

Real `fs` in a test process touches the actual filesystem, which means temp
directories, cleanup between tests, and races when tests run in parallel. This
stub keeps everything in a `Map` tree per instance, so each test gets an
isolated filesystem and there is nothing to clean up. The trade-off: the stub
is synchronous, holds only UTF-8 strings, and models no permissions, symlinks,
or device files. If your code under test uses streams, watchers, or `chown`,
this stub will not help you.

The awkward edge
----------------

`..` is rejected with `EINVAL` rather than resolved upwards. A stub that silently
lets `..` climb above its own root hides bugs instead of finding them, so the
library refuses it. If your code constructs paths that legitimately contain
`..`, normalise them before calling in.

`readdirSync` returns entry names in **insertion order**, not sorted. This is
deliberate — Map preserves insertion order, so the listing is stable across
runs without a sort pass, and it matches the order in which your test wrote
entries. If you need alphabetical, sort the result yourself.

`mtimeMs` comes from the clock function passed to the constructor, defaulting
to `() => 0`. Pass your own fake clock in tests; never assert against the
machine's wall clock.

## Performance

The window keeps a bounded buffer, so `push` is constant time and memory does not
grow with the length of the stream. `peak` and `trough` are linear in the window
size, which is the trade that keeps `push` cheap.

## Design notes

The window stores values eagerly rather than keeping running aggregates. Running
sums drift with floating point over long streams, and recomputing from a small
buffer is cheap enough that the drift is not worth the speed.

