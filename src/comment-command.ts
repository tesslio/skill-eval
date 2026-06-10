export type TesslCommentCommand =
  | { kind: 'scenarios'; requestedPath: string }
  | { kind: 'eval'; requestedPath: string };

const COMMAND_RE = /^\/tessl\s+(scenarios|eval)\s+(\S+)$/i;

export function parseTesslCommentCommand(body: string | undefined): TesslCommentCommand | null {
  if (!body) return null;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = line.match(COMMAND_RE);
    if (!match) continue;

    const command = match[1]?.toLowerCase();
    const requestedPath = match[2];
    if (!requestedPath) return null;

    if (command === 'scenarios') {
      return { kind: 'scenarios', requestedPath };
    }
    if (command === 'eval') {
      return { kind: 'eval', requestedPath };
    }
  }

  return null;
}

export function isTrustedAuthorAssociation(association: string | undefined): boolean {
  return association === 'OWNER' || association === 'MEMBER' || association === 'COLLABORATOR';
}
