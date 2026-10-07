import fs from 'node:fs/promises';
import {readJobInventory} from '../../src/jobs.ts';
const input = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
await readJobInventory(input.config, input.host, input.now, input.timeoutMs, new URL(input.helper));
