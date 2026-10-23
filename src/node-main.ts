// The self-hosted installer's entry (npm run build:node → dist/node.mjs).
//   node dist/node.mjs                                         the installer
//   node dist/node.mjs replace-installer <container> <image> <release>   its own update with Docker (docker/replace.ts)
import { Docker } from './docker/client';
import { replaceInstaller } from './docker/replace';
import { start } from './node';
import { dockerTransport } from './node/docker-transport';

const [command, ...args] = process.argv.slice(2);
if (command === 'replace-installer') {
  const [name, image, release] = args;
  replaceInstaller(new Docker(dockerTransport(process.env), ''), name, image, release).then(
    () => console.log(`${name}: now ${image}`),
    (err: Error) => {
      console.error(`${name}: not updated - ${err.message}`);
      process.exit(1);
    }
  );
} else {
  start();
}
