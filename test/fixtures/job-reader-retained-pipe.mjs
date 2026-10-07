import {spawn} from 'node:child_process';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
const child = spawn(process.execPath, [fileURLToPath(new URL('./job-reader-pending.mjs', import.meta.url))],
  {stdio: ['ignore', process.stdout, 'ignore']});
fs.writeFileSync(process.env.JOB_READER_PID_FILE, String(child.pid));
setInterval(() => {}, 1000);
