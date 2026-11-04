// Run with: node --test .github/actions/coverage-comment/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMENT_MARKER, formatRanges, parseLcov, renderComment, toRanges } from './coverage-comment.mjs';

const LCOV = `TN:Example
SF:src/a/One.hx
FNF:2
FNH:1
BRF:4
BRH:3
DA:1,1
DA:2,0
DA:3,0
DA:5,0
LF:4
LH:1
end_of_record
SF:./tools/Two.hx
FNF:1
FNH:1
BRF:0
BRH:0
DA:7,2
LF:1
LH:1
end_of_record
`;

test('reads counts and uncovered lines, normalizing paths', () => {
  const files = parseLcov(LCOV, '/repo');
  assert.deepEqual([...files.keys()], ['src/a/One.hx', 'tools/Two.hx']);
  const one = files.get('src/a/One.hx');
  assert.deepEqual(one.lines, [1, 4]);
  assert.deepEqual(one.functions, [1, 2]);
  assert.deepEqual(one.branches, [3, 4]);
  assert.deepEqual(one.uncovered, [2, 3, 5]);
});

test('reads absolute paths relative to the root', () => {
  const files = parseLcov('SF:/repo/src/A.hx\nLF:1\nLH:1\nend_of_record\n', '/repo');
  assert.deepEqual([...files.keys()], ['src/A.hx']);
});

test('merges touching lines into ranges', () => {
  assert.deepEqual(toRanges([2, 3, 5, 7, 8, 9]), [[2, 3], [5, 5], [7, 9]]);
});

test('links ranges and caps how many are shown', () => {
  assert.equal(formatRanges([[2, 3], [5, 5]], 'u/f.hx'), '[2-3](u/f.hx#L2-L3), [5](u/f.hx#L5)');
  const many = Array.from({ length: 17 }, (_, i) => [i * 2, i * 2]);
  assert.match(formatRanges(many, null), /, and 2 more$/);
});

test('renders totals and only the changed files in the report', () => {
  const files = parseLcov(LCOV, '/repo');
  const body = renderComment({ files, changedFiles: ['src/a/One.hx', 'README.md'], blobUrl: 'https://x/blob/abc' });
  assert.ok(body.startsWith(`${COMMENT_MARKER}\n`));
  assert.match(body, /\| 40\.00% \(2 \/ 5\) \| 66\.67% \(2 \/ 3\) \| 75\.00% \(3 \/ 4\) \|/);
  assert.match(body, /Changed files \(1\)/);
  assert.match(body, /`src\/a\/One\.hx`.*\[2-3\]\(https:\/\/x\/blob\/abc\/src\/a\/One\.hx#L2-L3\)/);
  assert.doesNotMatch(body, /README/);
});

test('says so when no changed file is in the report', () => {
  const body = renderComment({ files: parseLcov(LCOV, '/repo'), changedFiles: ['README.md'], blobUrl: null });
  assert.match(body, /None of the changed files are in the coverage report\./);
});

test('leaves the file table out without a changed-files list', () => {
  const body = renderComment({ files: parseLcov(LCOV, '/repo'), changedFiles: null, blobUrl: null });
  assert.doesNotMatch(body, /Changed files|None of the changed/);
});
