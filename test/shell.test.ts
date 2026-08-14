import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  detectShell,
  initScript,
  PASSTHROUGH_COMMANDS,
  renderEnv,
  selectionEnv,
  SHELLS,
  wrapperActive,
} from '../src/shell.ts';

test('renders exports per shell dialect', () => {
  const changes = selectionEnv('prod-admin', 'eu-west-1');
  assert.equal(
    renderEnv('zsh', changes),
    [
      "export AWS_PROFILE='prod-admin'",
      "export AWS_DEFAULT_PROFILE='prod-admin'",
      "export AWS_REGION='eu-west-1'",
      "export AWS_DEFAULT_REGION='eu-west-1'",
    ].join('\n'),
  );
  assert.match(renderEnv('fish', changes), /^set -gx AWS_PROFILE 'prod-admin'/);
  assert.match(renderEnv('pwsh', changes), /^\$env:AWS_PROFILE = 'prod-admin'/);
});

test('an undefined value unsets rather than exporting empty', () => {
  const changes = selectionEnv('p', undefined);
  assert.match(renderEnv('zsh', changes), /unset AWS_REGION\nunset AWS_DEFAULT_REGION$/);
  assert.match(renderEnv('fish', changes), /set -e AWS_REGION/);
  assert.match(renderEnv('pwsh', changes), /Remove-Item -ErrorAction SilentlyContinue Env:AWS_REGION/);
});

test('profile names are quoted so they cannot become shell syntax', () => {
  const evil = "a'; rm -rf /; echo '";
  const rendered = renderEnv('zsh', [{ name: 'AWS_PROFILE', value: evil }]);
  assert.equal(rendered, `export AWS_PROFILE='a'\\''; rm -rf /; echo '\\'''`);
  assert.ok(!/^\s*rm /m.test(rendered));

  const pwsh = renderEnv('pwsh', [{ name: 'AWS_PROFILE', value: "it's" }]);
  assert.equal(pwsh, `$env:AWS_PROFILE = 'it''s'`);
});

test('every shell gets an init script that defines the wrapper and evals', () => {
  for (const shell of SHELLS) {
    const script = initScript(shell);
    assert.match(script, /awsx/);
    assert.match(script, /--emit-shell/);
    assert.match(script, /AWSX_SHELL_WRAPPER=1|AWSX_SHELL_WRAPPER = '1'|\$env:AWSX_SHELL_WRAPPER/);
    assert.ok(/eval|Invoke-Expression/.test(script), `${shell} must eval the emitted code`);
    // Non-mutating commands must bypass eval so they keep a real TTY.
    for (const command of PASSTHROUGH_COMMANDS) assert.match(script, new RegExp(command));
  }
});

test('the wrapper honours a custom bin name', () => {
  assert.match(initScript('zsh', 'awsp'), /^awsp\(\) \{/m);
});

test('shell detection prefers the wrapper hint, then $SHELL', () => {
  assert.equal(detectShell({ AWSX_SHELL: 'fish', SHELL: '/bin/zsh' }), 'fish');
  assert.equal(detectShell({ SHELL: '/bin/bash' }), 'bash');
  assert.equal(detectShell({ SHELL: '/opt/homebrew/bin/fish' }), 'fish');
  assert.equal(detectShell({ SHELL: '/bin/sh' }), 'bash');
  assert.equal(detectShell({}), 'zsh');
  assert.equal(detectShell({ AWSX_SHELL: 'nonsense', SHELL: '/bin/zsh' }), 'zsh');
});

test('wrapperActive only trusts an explicit 1', () => {
  assert.equal(wrapperActive({ AWSX_SHELL_WRAPPER: '1' }), true);
  assert.equal(wrapperActive({ AWSX_SHELL_WRAPPER: 'yes' }), false);
  assert.equal(wrapperActive({}), false);
});
