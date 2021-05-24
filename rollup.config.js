import typescript from '@rollup/plugin-typescript';
import replace from '@rollup/plugin-replace';

const external = [
  'os',
  'worker_threads',
  'events',
  'perf_hooks',
  'url',
  'path',
];

export default [
  {
    input: 'src/index.ts',
    output: {
      file: './dist/index.mjs',
      sourcemap: true,
      format: 'esm',
    },
    external,
    plugins: [
      typescript(),
      replace({
        preventAssignment: true,
        WORKER_FILE_NAME: 'worker.mjs',
      }),
    ],
  },
  {
    input: 'src/index.ts',
    output: {
      file: './dist/index.cjs',
      sourcemap: true,
      format: 'cjs',
    },
    external,
    plugins: [
      typescript(),
      replace({
        preventAssignment: true,
        WORKER_FILE_NAME: 'worker.cjs',
      }),
    ],
  },

  {
    input: 'src/worker.ts',
    output: {
      file: './dist/worker.cjs',
      sourcemap: true,
      format: 'cjs',
    },
    external,
    plugins: [typescript()],
  },

  {
    input: 'src/worker.ts',
    output: {
      file: './dist/worker.mjs',
      sourcemap: true,
      format: 'esm',
    },
    external,
    plugins: [typescript()],
  },
];
