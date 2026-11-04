/**
 * Turns an lcov report into the pull request's coverage comment: the totals, then the coverage
 * and uncovered lines of each changed file that is in the report.
 *
 *   node coverage-comment.mjs <lcov file> [changed files list]
 *
 * The changed-files list has one repo-relative path per line (`gh pr diff --name-only`). Without
 * it the file table is left out. Uncovered lines link to the file at HEAD_SHA in GITHUB_REPOSITORY
 * when both are set. Prints markdown to stdout. The first line is COMMENT_MARKER, which the action
 * uses to find and update its comment.
 */

import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const COMMENT_MARKER = '<!-- dropecho-coverage -->';

// A file with hundreds of gaps would make the comment unreadable (GitHub caps comments at 65k).
const MAX_RANGES = 15;

const METRICS = [
  ['lines', 'Lines'],
  ['functions', 'Functions'],
  ['branches', 'Branches'],
];

const emptyCounts = () => ({ lines: [0, 0], functions: [0, 0], branches: [0, 0] });

/**
 * Reads lcov text into one entry per source file, keyed by its path relative to `root`.
 * Each entry has [hit, found] counts per metric and the sorted line numbers that never ran.
 */
export function parseLcov(text, root = process.cwd()) {
  const files = new Map();
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const colon = line.indexOf(':');
    const key = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1);
    switch (key) {
      case 'SF': {
        const path = toRepoPath(value, root);
        current = files.get(path) ?? { path, ...emptyCounts(), uncovered: new Set() };
        files.set(path, current);
        break;
      }
      case 'DA': {
        const [lineNo, count] = value.split(',').map(Number);
        if (current && count === 0) current.uncovered.add(lineNo);
        break;
      }
      case 'LF': if (current) current.lines[1] += Number(value); break;
      case 'LH': if (current) current.lines[0] += Number(value); break;
      case 'FNF': if (current) current.functions[1] += Number(value); break;
      case 'FNH': if (current) current.functions[0] += Number(value); break;
      case 'BRF': if (current) current.branches[1] += Number(value); break;
      case 'BRH': if (current) current.branches[0] += Number(value); break;
      case 'end_of_record': current = null; break;
    }
  }
  for (const entry of files.values()) entry.uncovered = [...entry.uncovered].sort((a, b) => a - b);
  return files;
}

/** A path from the report as a forward-slash path relative to the repo root. */
export function toRepoPath(path, root) {
  const normalized = path.replace(/\\/g, '/');
  const rel = relative(root, resolve(root, normalized)).replace(/\\/g, '/');
  return rel || normalized;
}

/** Merges sorted line numbers into [start, end] ranges. */
export function toRanges(lines) {
  const ranges = [];
  for (const line of lines) {
    const last = ranges.at(-1);
    if (last && line === last[1] + 1) last[1] = line;
    else ranges.push([line, line]);
  }
  return ranges;
}

/** The uncovered-lines cell, linked to the file at the PR's head when `fileUrl` is given. */
export function formatRanges(ranges, fileUrl) {
  const label = ([start, end]) => (start === end ? `${start}` : `${start}-${end}`);
  const anchor = ([start, end]) => (start === end ? `#L${start}` : `#L${start}-L${end}`);
  const shown = ranges
    .slice(0, MAX_RANGES)
    .map((range) => (fileUrl ? `[${label(range)}](${fileUrl}${anchor(range)})` : label(range)));
  if (ranges.length > MAX_RANGES) shown.push(`and ${ranges.length - MAX_RANGES} more`);
  return shown.join(', ');
}

const cell = ([hit, found]) => (found ? `${((hit / found) * 100).toFixed(2)}% (${hit} / ${found})` : '-');
const row = (cells) => `| ${cells.join(' | ')} |`;

/**
 * The comment's markdown, from the parsed report, the changed files (null when unknown) and an
 * optional `blobUrl` (…/blob/<sha>) for line links.
 */
export function renderComment({ files, changedFiles, blobUrl }) {
  const total = emptyCounts();
  for (const entry of files.values()) {
    for (const [metric] of METRICS) {
      total[metric][0] += entry[metric][0];
      total[metric][1] += entry[metric][1];
    }
  }

  const out = [COMMENT_MARKER, '## Coverage', ''];
  out.push(row(METRICS.map(([, label]) => label)), row(METRICS.map(() => '---')));
  out.push(row(METRICS.map(([metric]) => cell(total[metric]))));

  if (changedFiles) {
    const changed = changedFiles.map((file) => files.get(file)).filter(Boolean);
    out.push('');
    if (!changed.length) {
      out.push('None of the changed files are in the coverage report.');
    } else {
      out.push(`<details><summary>Changed files (${changed.length})</summary>`, '');
      out.push(row(['File', ...METRICS.map(([, label]) => label), 'Uncovered lines']), row(Array(5).fill('---')));
      for (const entry of changed) {
        const fileUrl = blobUrl ? `${blobUrl}/${entry.path}` : null;
        const gaps = formatRanges(toRanges(entry.uncovered), fileUrl);
        out.push(row([`\`${entry.path}\``, ...METRICS.map(([metric]) => cell(entry[metric])), gaps]));
      }
      out.push('', '</details>');
    }
  }
  return `${out.join('\n')}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [lcovPath, changedPath] = process.argv.slice(2);
  if (!lcovPath || !existsSync(lcovPath)) {
    console.error(`No lcov report at ${lcovPath ?? '(none given)'}`);
    process.exit(1);
  }
  const files = parseLcov(readFileSync(lcovPath, 'utf8'));
  const changedFiles =
    changedPath && existsSync(changedPath)
      ? readFileSync(changedPath, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean)
      : null;
  const { GITHUB_SERVER_URL = 'https://github.com', GITHUB_REPOSITORY, HEAD_SHA } = process.env;
  const blobUrl = GITHUB_REPOSITORY && HEAD_SHA ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/blob/${HEAD_SHA}` : null;
  process.stdout.write(renderComment({ files, changedFiles, blobUrl }));
}
