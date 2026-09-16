#!/usr/bin/env node
// The `glcm` command. The sources are TypeScript, as everywhere else in this repository, so tsx compiles them on the fly.
import { register } from 'tsx/esm/api';

register();
const { run } = await import('../src/main.ts');
process.exitCode = await run(process.argv.slice(2));
