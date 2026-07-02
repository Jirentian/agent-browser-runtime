import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';

test('runtime exposes a tracked tab close command', async () => {
  const [brokerSource, cliSource] = await Promise.all([
    readFile(new URL('../src/server.js', import.meta.url), 'utf8'),
    readFile(new URL('../../cli/brs.js', import.meta.url), 'utf8'),
  ]);

  assert.match(brokerSource, /app\.delete\('\/tabs\/:tabId'/, 'broker must expose DELETE /tabs/:tabId');
  assert.match(brokerSource, /store\.getTab\(tabId\)/, 'tab close must resolve the tracked tab');
  assert.match(brokerSource, /catch \(_\) \{ return null; \}/, 'tab close must tolerate untracked tabs');
  assert.match(brokerSource, /tabs\.get/, 'tab close must allow real Chrome tabs that are not tracked in SQLite');
  assert.match(brokerSource, /tabs\.close/, 'tab close must call the extension close primitive');
  assert.match(brokerSource, /store\.closeTab\(tabId\)/, 'tab close must mark the tracked tab closed');
  assert.match(cliSource, /cmd === 'tab-close'/, 'CLI must expose tab-close');
  assert.match(cliSource, /DELETE.*\/tabs\/\$\{encodeURIComponent\(tabId\)\}/, 'CLI tab-close must call DELETE /tabs/:tabId');
});
