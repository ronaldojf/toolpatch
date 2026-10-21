import { adapters } from './adapters/index.js';
import { startToolpatch } from './core/runtime.js';

void startToolpatch(window, adapters);
