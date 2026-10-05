/**
 * Public entry point for mock-fs-stub.
 *
 * Exports the `MockFS` class and the `Stats` shape returned by `statSync`.
 * `createError` is exported too — tests that assert on thrown error shape use it
 * to construct a comparison value without duplicating the field list.
 */
import { MockFS, Stats, createError } from './core.js';

export { MockFS, Stats, createError };
export default MockFS;
