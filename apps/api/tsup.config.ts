import { defineConfig } from 'tsup';
import { nodeService } from '../../tsup.node';

export default defineConfig(nodeService('src/server.ts'));
