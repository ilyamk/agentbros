import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const directory = path.dirname(fileURLToPath(import.meta.url));
// A licence-clean moving test pattern and tone, not a recording of a person.
const result = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-n', path.join(directory, 'source.mp4')], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
