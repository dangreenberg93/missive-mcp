import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

function readOptional(filename: string): string | null {
  try {
    return readFileSync(join(rootDir, filename), 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Load MCP server instructions. Set MCP_INSTRUCTIONS_PROFILE to:
 * - all (default): base + PBD + Voyager
 * - pbd: base + PBD only
 * - voyager: base + Voyager only
 * - base: shared Missive guidance only
 */
export function loadMcpInstructions(): string {
  const profile = (process.env.MCP_INSTRUCTIONS_PROFILE || 'all').toLowerCase();
  const parts: string[] = [];

  const base = readOptional('instructions.md');
  if (base) parts.push(base);

  if (profile === 'all' || profile === 'pbd') {
    const pbd = readOptional('instructions-pbd.md');
    if (pbd) parts.push(pbd);
  }

  if (profile === 'all' || profile === 'voyager') {
    const voyager = readOptional('instructions-voyager.md');
    if (voyager) parts.push(voyager);
  }

  return parts.join('\n\n');
}
