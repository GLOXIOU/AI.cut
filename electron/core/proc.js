// Child processes (ffmpeg, yt-dlp, claude…): tracked so none of them outlives the app, and background work
// (import, analysis) can run at a lower CPU priority so the editor stays responsive while it crunches.
import { spawn } from 'node:child_process';
import os from 'node:os';

const live = new Map(); // proc -> { tree }

/**
 * spawn() + tracking. Extra options:
 *  - lowPriority: run below normal priority (import / analysis work)
 *  - tree: the process starts children of its own (yt-dlp, claude) → kill the whole tree on shutdown
 */
export function spawnTracked(cmd, args, opts = {}, { lowPriority = false, tree = false } = {}) {
  const proc = spawn(cmd, args, { windowsHide: true, ...opts });
  if (proc.pid) {
    live.set(proc, { tree });
    const forget = () => live.delete(proc);
    proc.once('exit', forget);
    proc.once('error', forget);
    if (lowPriority) {
      try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* already gone / not allowed */ }
    }
  }
  return proc;
}

/** Kill a process (and its children when it may have some). */
export function killTree(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    if (process.platform === 'win32' && proc.pid) {
      // proc.kill() only terminates the parent on Windows: grandchildren would keep running
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    } else {
      proc.kill('SIGKILL');
    }
  } catch { /* ignore */ }
}

/** Shutdown: terminate every child process still running. */
export function killAllChildren() {
  for (const [proc, { tree }] of live) {
    if (tree) killTree(proc);
    else { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }
  }
  live.clear();
}

export const liveChildren = () => live.size;
