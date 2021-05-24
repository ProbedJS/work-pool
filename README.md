#  work-pool

A high-performance and flexible work pool. This was built specifically to address the specific needs of @probedjs/testing.

- Works with both CommonJS and ECMAScript modules.
- Heuristic-based task assignment.
- Supports both synchronous and asynchronous tasks.
- Work stealing.

## Getting Started

### Entrypoint module

In order to queue and perform tasks, you need an entrypoint module:

```javascript
// MyWorker.js
export const workerEntrypoint = (taskArg) => {
    return `Hello, ${taskArg}!`;
  },
};

workerEntrypoint.modulePath = fileURLToPath(import.meta.url);
workerEntrypoint.moduleSymbol = 'workerEntrypoint';
```

### Creating a work pool and dispatching work.

```javascript
import { WorkerPool } from '@probedjs/work-pool';
import { workerEntrypoint } from './MyWorker'

const main = async () => {
  const pool = new WorkerPool(workerEntrypoint);

  const result = await pool.addTask('World');
  console.log(result);

  pool.dispose();
};

main();
```

### Init and teardown

You can also register lifetime callbacks for the worker. These functions will be called once per worker.

```javascript
export const workerEntrypoint = (taskArg) => {
  return `Hello, ${taskArg}!`;
};

workerEntrypoint.modulePath = fileURLToPath(import.meta.url);
workerEntrypoint.moduleSymbol = 'workerEntrypoint';
workerEntrypoint.onWorkerStart = (client) => {}
workerEntrypoint.onWorkerExit = (client) => {}
```

### Sending and receiving messages

On top of dispatching tasks, messages can be send to and from workers.

```javascript
import { WorkerPool } from '@probedjs/work-pool';

export const workerEntrypoint = (taskArg, client) => {
  client.postMessageToPool("starting", taskArg);
  return `Hello, ${taskArg}!`;
};
workerEntrypoint.modulePath = fileURLToPath(import.meta.url);
workerEntrypoint.moduleSymbol = 'workerEntrypoint';

workerEntrypoint.onWorkerStart = (client) => {
  client.onMessage("hi", (contents, client)=>{
    console.log(`pool says hi: ${contents}`);
  })
}

const main = async () => {
  const pool = new WorkerPool(workerEntrypoint);

  pool.onMessage("starting", (content, origin) => {
    console.log(`got starting message ${content} from worker ${origin}`);
  });


  pool.addTask("joe");

  // Send a message to every worker.
  pool.postMessageToWorkers("Hi!");

  await pool.whenIdle();

  pool.dispose();
};

if(isMainThread) {
  main();
}
```