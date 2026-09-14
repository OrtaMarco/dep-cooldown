#!/usr/bin/env node
// The published executable. It runs the CLI unconditionally: npx and
// node_modules/.bin reach it through a symlink, and no "was I invoked
// directly?" check survives every way a path can be spelled.
import { run } from './cli.js';

run();
