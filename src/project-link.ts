import * as core from '@actions/core';
import { basename } from 'node:path';
import { isPluginRoot } from './find-plugins.ts';
import { tesslBin } from './tessl-bin.ts';

function cleanCliOutput(output: string): string {
  return output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '').trim();
}

async function runTesslCommand(args: string[], cwd?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return {
    exitCode: await proc.exited,
    stdout,
    stderr,
  };
}

export function projectSetupRequiredMessage(pluginDir: string, workspace: string): string {
  const projectName = basename(pluginDir.replace(/\/+$/, '')) || 'skill-eval';
  const workspaceArg = workspace || '<workspace>';

  return [
    'This plugin is not linked to a Tessl project yet.',
    'Run this one-time setup locally from the plugin directory, commit the generated `tessl.json`, then rerun this command:',
    '',
    '```bash',
    `cd ${pluginDir}`,
    `tessl project create --workspace ${workspaceArg} ${projectName}`,
    'git add tessl.json',
    'git commit -m "chore: link Tessl project"',
    '```',
  ].join('\n');
}

export async function ensureProjectLinked(pluginDir: string, workspace: string): Promise<string | null> {
  if (!workspace || !isPluginRoot(pluginDir)) {
    return null;
  }

  const linkArgs = [tesslBin(), 'project', 'link', '--workspace', workspace];
  const link = await runTesslCommand(linkArgs, pluginDir);
  if (link.exitCode === 0) {
    core.info(`Tessl project link confirmed for ${pluginDir}`);
    return null;
  }

  const linkOutput = cleanCliOutput(`${link.stderr}\n${link.stdout}`);
  if (/No (?:matching )?Tessl project|No matching project/i.test(linkOutput)) {
    return projectSetupRequiredMessage(pluginDir, workspace);
  }

  return `tessl project link failed (exit ${link.exitCode}): ${linkOutput || 'unknown error'}`;
}
