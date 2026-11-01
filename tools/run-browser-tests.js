import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Playwright chooses its own worker color setting. Strip conflicting inherited
// flags only for this child process; never alter the caller or machine settings.
const env = { ...process.env };
delete env.NO_COLOR;
delete env.FORCE_COLOR;
const cli = fileURLToPath(import.meta.resolve('@playwright/test/cli'));
const result = spawnSync(process.execPath, [cli, 'test', ...process.argv.slice(2)], {
  stdio: 'inherit', env,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
