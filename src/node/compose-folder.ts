// Compose mode's folder (the one compose.yaml is in, mounted at /project):
// the installer writes its files there as the folder's own owner — the
// person who runs `compose up -d` — readable by them alone (it holds the
// installation's secrets). Each file whole or not at all (written next to
// it, then renamed).
import { chownSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ComposeFolder } from '../env';

export function composeFolder(dir: string): ComposeFolder {
  return {
    async write(files) {
      const owner = statSync(dir);
      for (const [name, content] of Object.entries(files)) {
        const path = join(dir, name);
        const temp = `${path}.writing`;
        writeFileSync(temp, content, { mode: 0o600 });
        try {
          chownSync(temp, owner.uid, owner.gid);
        } catch {
          // Not root, or a share that ignores it (a Mac's): already theirs.
        }
        renameSync(temp, path);
      }
    },
  };
}
