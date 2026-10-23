import { ursaAdapter } from './ursa.js';
import { portainerAdapter } from './portainer.js';

// The catalog is shared by the runtime and userscript metadata generator.
export const adapters = [ursaAdapter, portainerAdapter];
