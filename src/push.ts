import { runCommand } from './commands.js';

// Pushing a branch to a remote for the first time: `git push -u <remote> <branch>`.
// Authentication failures are not retried: the user must load the key or change the remote.
export type PushOutcome =
  | { ok: true; branch: string; remote: string; upstream: string; output: string }
  | { ok: false; branch: string; remote: string; needsUser: boolean; reason: string; output: string };

const BRANCH = /^[A-Za-z0-9._][A-Za-z0-9._\/-]*$/;
const REMOTE = /^[A-Za-z0-9._-]+$/;

export function validPushTarget(branch: string, remote: string): string | null {
  if (!BRANCH.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.endsWith('.lock'))
    return `"${branch}" is not a branch name this harness will push.`;
  if (!REMOTE.test(remote)) return `"${remote}" is not a remote name this harness will push to.`;
  return null;
}

// Exit 128 with an authentication message: the SSH key is missing, locked, or not authorized.
export function classifyPushFailure(code: number | null, output: string): { needsUser: boolean; reason: string } {
  const auth =
    /permission denied \(publickey\)|authentication failed|could not read (username|from remote)|passphrase|host key verification failed/i.test(
      output,
    );
  if (code === 128 && auth)
    return {
      needsUser: true,
      reason:
        'Git could not authenticate to the remote. The user must load the SSH key into ssh-agent (ssh-add) or switch the remote to HTTPS with a token. Do not retry.',
    };
  return { needsUser: false, reason: `git push exited with ${code ?? 'no code'}.` };
}

export async function pushBranch(
  root: string,
  branch: string,
  remote = 'origin',
  timeout = 120000,
): Promise<PushOutcome> {
  const bad = validPushTarget(branch, remote);
  if (bad) return { ok: false, branch, remote, needsUser: false, reason: bad, output: '' };
  const r = await runCommand('git', ['push', '-u', remote, branch], root, timeout);
  if (r.timedOut)
    return { ok: false, branch, remote, needsUser: false, reason: 'git push timed out.', output: r.output };
  if (r.code !== 0) {
    const c = classifyPushFailure(r.code, r.output);
    return { ok: false, branch, remote, needsUser: c.needsUser, reason: c.reason, output: r.output };
  }
  const up = await runCommand('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root, 10000).catch(
    () => null,
  );
  return {
    ok: true,
    branch,
    remote,
    upstream: up && up.code === 0 ? up.output.trim() : `${remote}/${branch}`,
    output: r.output,
  };
}
