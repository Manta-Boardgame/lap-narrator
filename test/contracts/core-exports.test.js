import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../../core/index.js';

// CONTRACTS.md 2。名前を変えるときは提案を通すこと。
const EXPECTED = [
  'canonicalJson', 'parseJsonl', 'stringifyJsonl', 'createSha256', 'sha256Hex',
  'wavHeader', 'parseWavHeader', 'planWavParts', 'createZipWriter', 'readZipDirectory', 'readZipEntry',
  'textHash', 'scriptHash', 'checkScript', 'reduceEvents', 'renderTake', 'defaultRenderSpec',
  'createLoudnessMeter', 'frameOf', 'buildTimeline', 'receiveVolume', 'commitIfComplete', 'validate',
  'EVENT_TYPES', 'ISSUE_CODES', 'CONTRACT_VERSION', 'DEFAULT_SAMPLE_RATE',
];

test('core/index.js が取り決めの名前をすべて公開している', () => {
  const missing = EXPECTED.filter((n) => !(n in core));
  assert.deepEqual(missing, []);
});

test('操作の種類が schema/events と同じ', async () => {
  const { readFileSync } = await import('node:fs');
  const schema = JSON.parse(readFileSync(new URL('../../schema/events.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual([...core.EVENT_TYPES].sort(), [...schema.properties.type.enum].sort());
});
