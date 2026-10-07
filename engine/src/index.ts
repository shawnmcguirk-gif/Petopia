import { assertAuthConfig } from './auth.js';
import { createApp, inboxDepsFromEnv } from './server.js';
import { startSweep } from './sweep.js';

assertAuthConfig(); // refuses to start with PETOPIA_AUTH=off in production

// Port 4400 (spec sec 2): Truehaven 4100, Vitalis 4200, Epicure 4300 already hold theirs on the same iMac.
const port = Number(process.env.PORT) || 4400;
createApp().listen(port, '127.0.0.1', () => {
  console.log(`petopia-engine listening on 127.0.0.1:${port}`);
});

// The engine owns its inbox sweep (spec sec 2 "Scheduling"): every PETOPIA_SWEEP_SECONDS (default 60). Without
// VAULT_ROOT there is no inbox to sweep, so it stays off and says so once.
if (process.env.VAULT_ROOT) startSweep(inboxDepsFromEnv());
else console.log('petopia-engine: VAULT_ROOT is not set; the document inbox sweep is off');
