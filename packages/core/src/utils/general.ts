import { Addon, Preset } from '../db/schemas';
import { parseConnectionURI } from '../db/utils';
import { Env } from './env';
import path from 'path';

export function getAddonName(addon: Addon | Preset): string {
  return 'type' in addon
    ? addon.type
    : `${addon.name}${addon.displayIdentifier || addon.identifier ? ` ${addon.displayIdentifier || addon.identifier}` : ''}`;
}

export function getDataFolder(): string {
  const databaseURI = parseConnectionURI(Env.DATABASE_URI);
  if (databaseURI.dialect === 'sqlite') {
    return path.dirname(databaseURI.filename);
  }
  return path.join(process.cwd(), 'data');
}
