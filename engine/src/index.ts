import { assertAuthConfig } from './auth.js';
import { createApp } from './server.js';

assertAuthConfig(); // refuses to start with PETOPIA_AUTH=off in production

// Port 4400 (spec sec 2): Truehaven 4100, Vitalis 4200, Epicure 4300 already hold theirs on the same iMac.
const port = Number(process.env.PORT) || 4400;
createApp().listen(port, '127.0.0.1', () => {
  console.log(`petopia-engine listening on 127.0.0.1:${port}`);
});
