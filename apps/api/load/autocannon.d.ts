// Minimal types for the parts of autocannon the load test uses (the package ships none).
declare module 'autocannon' {
  import type { EventEmitter } from 'node:events';

  export type Options = {
    url: string;
    connections?: number;
    duration?: number;
    method?: string;
    headers?: Record<string, string>;
    timeout?: number;
  };

  export type Result = {
    errors: number;
    timeouts: number;
  };

  export type Instance = EventEmitter &
    PromiseLike<Result> & {
      on(
        event: 'response',
        listener: (client: unknown, statusCode: number, resBytes: number, ms: number) => void,
      ): Instance;
    };

  export default function autocannon(opts: Options): Instance;
}
