/**
 * telemetry/known-fixes.json — the registry the telemetry Worker serves and
 * the "a newer version fixes this" prompt reads. Format: telemetry/README.md
 * → Known-fixes registry. Entries are added by hand and by the scheduled
 * product-manager routine, so every rule a PR can break is checked here.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { KNOWN_FIX_SUMMARY_MAX, knownFixProblem, parseKnownFixes } from '../../src/services/knownFixes';
import { compareVersions } from '../../src/types/feedback';

const REGISTRY_PATH = path.join(__dirname, '../../telemetry/known-fixes.json');
const raw: unknown = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
const entries = raw as Array<Record<string, unknown>>;
const ALLOWED_KEYS = new Set(['code', 'fixedIn', 'summary', 'issue']);

describe('telemetry/known-fixes.json', () => {
  it('is a JSON array', () => {
    expect(Array.isArray(raw)).toBe(true);
  });

  it('holds only valid entries', () => {
    const problems = entries
      .map((entry, i) => ({ i, problem: knownFixProblem(entry) }))
      .filter(p => p.problem !== null)
      .map(p => `entry ${p.i}: ${p.problem}`);
    expect(problems).toEqual([]);
  });

  it('uses no keys beyond code, fixedIn, summary and issue', () => {
    const extra = entries.flatMap((entry, i) => Object.keys(entry).filter(k => !ALLOWED_KEYS.has(k)).map(k => `entry ${i}: ${k}`));
    expect(extra).toEqual([]);
  });

  it('has summaries of at most 140 characters', () => {
    expect(KNOWN_FIX_SUMMARY_MAX).toBe(140);
    for (const entry of entries) expect(String(entry.summary).length).toBeLessThanOrEqual(140);
  });

  it('lists no code twice for the same fixedIn', () => {
    const keys = entries.map(e => `${e.code}@${e.fixedIn}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('is in fixedIn order, oldest first', () => {
    for (let i = 1; i < entries.length; i++) {
      expect(compareVersions(String(entries[i - 1].fixedIn), String(entries[i].fixedIn))).toBeLessThanOrEqual(0);
    }
  });

  it('parses without dropping anything', () => {
    expect(parseKnownFixes(raw)).toHaveLength(entries.length);
  });
});

describe('knownFixProblem', () => {
  const good = { code: 'domainLoad', fixedIn: '1.7.0', summary: 'Diagrams now open.' };

  it('accepts a minimal entry and one with an issue', () => {
    expect(knownFixProblem(good)).toBeNull();
    expect(knownFixProblem({ ...good, issue: 12 })).toBeNull();
  });

  it.each([
    ['an unknown code', { ...good, code: 'notACode' }],
    ['a feature key as code', { ...good, code: 'compare' }],
    ['a v prefix', { ...good, fixedIn: 'v1.7.0' }],
    ['two-part version', { ...good, fixedIn: '1.7' }],
    ['a pre-release', { ...good, fixedIn: '1.7.0-beta.1' }],
    ['an empty summary', { ...good, summary: '  ' }],
    ['a long summary', { ...good, summary: 'x'.repeat(141) }],
    ['a line break', { ...good, summary: 'one\ntwo' }],
    ['a POSIX path', { ...good, summary: 'Fixed /Users/alex/project/.erd-studio/gold/sales.json loading.' }],
    ['a Windows path', { ...good, summary: 'Fixed C:\\Users\\alex\\models.yml loading.' }],
    ['a home path', { ...good, summary: 'Fixed ~/work/dbt/models loading.' }],
    ['an issue string', { ...good, issue: '#12' }],
    ['a zero issue', { ...good, issue: 0 }],
    ['an array', [good]],
    ['null', null],
  ])('rejects %s', (_label, entry) => {
    expect(knownFixProblem(entry)).not.toBeNull();
  });
});
