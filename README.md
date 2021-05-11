#  work-pool

A high-performance and flexible work pool.

- Works with both CommonJS and ECMAScript modules.
- Supports task discovery.
- Heuristic-based task assignment.
- Supports both synchronous and asynchronous tasks.
- Work stealing.

## Getting Started

### Entrypoint module

In order to queue and perform tasks, you need an entrypoint module. Any module that exports a `processTask` (async or not) function will do.

```javascript
// MyWorker.js
export const processTask = (task) => {
  return `Hello, ${task}!`;
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

In Typescript, passing the entrypoint to the Workpool will get you clean typings:

```typescript
import { WorkerPool } from '@probedjs/work-pool';
import { processTask } from './MyWorker'

const main = async () => {
  const pool = new WorkerPool('MyModule.js', { entryPoint: processTask });

//...
```

### Discovering work

Sometimes, new work will be discovered while processing a task. The second parameter to `processTask()` is a *proxy* to the work pool that can be used to announce such work:

```javascript
export const processTask = (task, workPool) => {

  if(task.length > 1) {
      workPool.addTask(task.slice(0, -1));
  }

  return `Hello, ${task}!`;
};
```

### Listening to events

Because of task discovery, it's sometimes more convenient to ignore the promises returned by `addTask()` and rely on events instead.

```javascript
import { WorkerPool } from '@probedjs/work-pool';

const main = async () => {
  const pool = new WorkerPool('MyWorker.js');

  pool.on('task-complete', (err, result, task) => {
    if (!err) {
      console.log(result);
    }
  });

  pool.addTask("joe");
  pool.addTask("jack");
  pool.addTask("Will");
  pool.addTask("Averell");

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

## FAQ

### Why doesn't addTask() return the task when called from a worker?

It technically could. However, handling this correctly in a way that doesn't risk causing deadlocks is tricky, and no one has any immediate need for it. File an issue if you need this!