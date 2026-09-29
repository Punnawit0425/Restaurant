// Entry point for `node --import`: installs the .jsx loader from jsx-hooks.mjs.
import { register } from 'node:module';

register('./jsx-hooks.mjs', import.meta.url);
