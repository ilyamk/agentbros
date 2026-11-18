import {writeFileSync} from 'node:fs';
import {registerOwnedRenderProcesses} from '../../src/lib/longform/bounded-worker.ts';
await registerOwnedRenderProcesses();
writeFileSync(process.argv[2],'activated');
process.disconnect();
