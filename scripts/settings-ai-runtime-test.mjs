import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SettingsStore, withAiAssistRuntime } from '../dist-electron/electron/settings.js';

const directory = await mkdtemp(join(tmpdir(), 'newamp-ai-settings-'));
try {
  const path = join(directory, 'settings.json');
  const store = new SettingsStore(path);
  const saved = store.set({ openaiApiKey: 'saved-public-key', openaiModel: 'saved-public-model' });
  const env = {
    NEWAMP_OPENAI_BASE_URL: 'http://127.0.0.1:47831/v1',
    NEWAMP_OPENAI_API_KEY: 'private-gateway-credential',
    NEWAMP_OPENAI_MODEL: 'endpoint-model',
  };
  const projected = withAiAssistRuntime(saved, env);
  assert.deepEqual(projected.aiAssistRuntime, { ready: true, mode: 'gateway', model: 'endpoint-model' });
  assert.equal(projected.openaiApiKey, 'saved-public-key');
  assert.equal(projected.openaiModel, 'saved-public-model');
  assert.ok(!JSON.stringify(projected).includes(env.NEWAMP_OPENAI_API_KEY));
  assert.ok(!JSON.stringify(projected).includes(env.NEWAMP_OPENAI_BASE_URL));
  const returned = store.set({ ...projected, aiAssistRuntime: { ready: false, mode: 'api', model: 'spoofed' } });
  assert.equal(returned.aiAssistRuntime, undefined, 'renderer runtime fields cannot enter persisted settings');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).aiAssistRuntime, undefined);
  assert.deepEqual(withAiAssistRuntime(returned, env).aiAssistRuntime, projected.aiAssistRuntime);
  assert.deepEqual(withAiAssistRuntime(returned, {}).aiAssistRuntime,
    { ready: true, mode: 'api', model: 'saved-public-model' });
  const noSavedKey = { ...saved, openaiApiKey: null };
  assert.equal(withAiAssistRuntime(noSavedKey, env).aiAssistRuntime.ready, true);
  assert.equal(withAiAssistRuntime(noSavedKey, {}).aiAssistRuntime.ready, false);
  assert.equal(withAiAssistRuntime(saved, { ...env, NEWAMP_OPENAI_API_KEY: ' ' }).aiAssistRuntime.ready, false,
    'missing gateway credentials do not fall back to the paid API key');
  assert.equal(withAiAssistRuntime(saved, { ...env, NEWAMP_OPENAI_MODEL: 'invalid model' }).aiAssistRuntime.model,
    'gpt-5.4-mini');
  console.log('[settings-ai-runtime-test] PASS');
} finally {
  const resolvedDirectory = resolve(directory);
  assert.ok(resolvedDirectory.startsWith(resolve(join(tmpdir(), 'newamp-ai-settings-'))));
  await rm(resolvedDirectory, { recursive: true, force: true });
}
