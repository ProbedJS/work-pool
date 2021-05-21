import { WorkerEntryPoint, WorkerPool } from '../lib';
import { isMainThread } from 'worker_threads';

export const workerEntrypoint: WorkerEntryPoint<string, string> = async (
  arg: string
) => {
  return `hello ${arg}`;
};

const main = async () => {
  const pool = new WorkerPool(__filename);

  pool.onMessage('starting', (content, origin) => {
    console.log(`got starting message ${content} from worker ${origin}`);
  });

  pool.addTask('joe');

  await pool.whenIdle();

  pool.dispose();
};

if (isMainThread) main();
