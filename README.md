#  work-pool

A high-performance and flexible work pool. This was built specifically to address the specific needs of @probedjs/testing.

- Works with both CommonJS and ECMAScript modules.
- Heuristic-based task assignment.
- Supports both synchronous and asynchronous tasks.
- Work stealing.

## Getting Started

### Entrypoint module

In order to queue and perform tasks, you need an entrypoint module. Any module that exports a function (async or not) as `workerEntrypoint` will do.

```javascript
// MyWorker.js
export const workerEntrypoint = (taskArg) => {
    return `Hello, ${taskArg}!`;
  },
};
```

### Creating a work pool and dispatching work.

```javascript
import { WorkerPool } from '@probedjs/work-pool';

const main = async () => {
  const pool = new WorkerPool('MyWorker.js');

  const result = await pool.addTask('World');
  console.log(result);

  pool.dispose();
};

main();
```

In Typescript, passing the entrypoint to the Workpool will get you clean typings. You still need to pass the
worker module's path, so that it can be loaded from workers.

```typescript
import { WorkerPool } from '@probedjs/work-pool';
import { workerEntrypoint } from './MyWorker'

const main = async () => {
  const pool = new WorkerPool('MyModule.js', { entryPoint: workerEntrypoint });

//...
```
### Init and teardown

You can also register lifetime callbacks for the worker. These functions will be called once per worker.

```javascript
export const workerEntrypoint = (taskArg) => {
  return `Hello, ${taskArg}!`;
};

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

workerEntrypoint.onWorkerStart = (client) => {
  client.onMessage("hi", (contents, client)=>{
    console.log(`pool says hi: ${contents}`);
  })
}

const main = async () => {
  const pool = new WorkerPool(import.meta.url);

  pool.onMessage("starting", (content, origin) => {
    console.log(`got starting message ${content} from worker ${origin}`);
  });


  pool.addTask("joe");

  // Send a message to every worker.
  pool.postMessageToWorkers("Hi!");

  await pool.whenIdle();

  pool.dispose();
};

main();
```

## Advanced use

### Affinity

Tasks optionally have affinity to a specific worker. If set, affinity can have three different strenghts.

- `light`: The work can be redispatched without hesitation.
- `strong`: The work might be sent to another worker if the workloads start to become too unbalanced.
- `force`: The work will unconditionally run on that worker.

By default: 
- Tasks queued from the main thread have no particular affinity.
- Tasks queued from within a worker have 'light' affinity to the worker that queued it.

You can change that behavior via options passed to `addTask()`. Here's a few typical uses:

```javascript
// From within a worker, hold on tighter to that task.
workPool.addTask(data, {affinityStrength: 'strong' });

// Run a task as part of the main thread. Useful when the task has non-serializable components.
workPool.addTask(data, {workerAffinity: 'main'});
```

**N.B** The main thread will never have tasks assigned to it unless `workerAffinity: 'main'` is explicitely set, 
in which case affinityStrength is implicitely `force`. 
