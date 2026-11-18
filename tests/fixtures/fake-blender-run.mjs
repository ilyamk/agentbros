// Stands in for avc_run.py inside the fake Blender: writes small real PNGs and the worker's result file.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const request = JSON.parse(readFileSync(process.env.AGENTBROS_BLENDER_REQUEST, 'utf8'));
const [first, last] = request.frames ?? [1, 2];
const [width, height] = request.resolution ?? [64, 36];
for (let frame = first; frame <= last; frame++) {
  if (String(frame) === process.env.FAKE_SKIP_FRAME) continue;
  const file = path.join(request.output, `frame-${String(frame).padStart(6, '0')}.png`);
  const colour = `color=c=0x${(frame * 20).toString(16).padStart(2, '0')}404080:s=${width}x${height}`;
  const done = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', colour, '-frames:v', '1', '-pix_fmt', 'rgba', file]);
  if (done.status !== 0) throw new Error(done.stderr.toString());
  if (String(frame) === process.env.FAKE_TRUNCATE_FRAME) writeFileSync(file, readFileSync(file).subarray(0, 100));
}
const matrix = Array(16).fill(0);
writeFileSync(path.join(request.output, 'camera.json'), JSON.stringify({ frameStart: first, frameEnd: last, frames: Array.from({ length: last - first + 1 }, (_, index) => ({ frame: first + index, projectionMatrix: matrix, threeMatrixWorld: matrix })) }));
writeFileSync(request.resultFile, JSON.stringify({ blenderVersion: '5.2.3', engine: 'CYCLES', device: 'CPU', samples: request.samples ?? 1, width, height, fps: 30, filmTransparent: Boolean(request.filmTransparent), viewTransform: 'AgX', look: 'None', motionBlur: false, frameStart: first, frameEnd: last, rendered: !request.noRender }));
