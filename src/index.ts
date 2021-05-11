/**
 * Copyright 2021 Francois Chabot
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  AddTaskMsg,
  MsgFromWorker,
  MsgToWorker,
  TaskCompletion,
  TaskDiscovery,
  TaskFailure,
  TaskWorker,
  WorkerConfig,
} from './worker.js';

import { EventEmitter } from 'events';
import os from 'os';
import { MessageChannel, MessagePort, Worker } from 'worker_threads';
import workerModule from './worker-location.js'

type Affinity = 0 | 1 | 2;
const AFFINITY_LIGHT = 0;
const AFFINITY_STRONG = 1;
const AFFINITY_FORCE = 2;

/** Interface available both in the main thread and workers. */
export interface ITaskPool<T> {
  addTask(arg: T, options?: TaskOptions): void;
}

/** Task processing entrypoint. */
export type ProcessFunc<T, U> = (arg: T, pool: ITaskPool<T>) => U | Promise<U>;

/** Options that can be passed when adding a task. */
export interface TaskOptions {
  /** Prefer running on that specific worker. This is implicitely set when
   * adding a task from within a worker.
   */
  workerAffinity?: 'main' | number;

  /** How much effort should be put into respecting workerAffinity.
   * - 0 (or unset): The work can be stolen without hesitation.
   * - 1 The work might be stolen under certain circumstances.
   * - 2 The work will never be stolen under any circumstances.
   *
   * force is always implied when the affinity is 'main'
   */
  affinityStrength?: Affinity;
}

export interface IWorker {
  readonly id: string;
}

/** A task that has been added to the worker pool. */
export interface Task<T, U> extends PromiseLike<U> {
  readonly arg: T;
  readonly id: string;
  readonly options: TaskOptions;
  readonly worker?: IWorker;
}

/** Options that can be passed to a worker pool at construction. */
export interface WorkerPoolOptions<T, U> {
  /** Name of the exported symbol to use in the entrypoint module. Default: 'processTask' */
  entrypointSymbol: string;

  /** New workers are launched when the ratio of pending tasks to workers goes above this threshold. Default: 3 */
  taskPerWorker: number;

  /** Absolute maximum number of workers to launch. Default: cpu count */
  maxWorkers: number;

  /** How many tasks can be queued in each worker's backends. Lower = better load balancing. Higher = better pipelining. Default: 2.*/
  workerConcurency: number;

  /** Task processing's entrypoint function. (useful for type inference) */
  entryPoint?: ProcessFunc<T, U>;
}

/** A pool of worker threads dedicated to processing tasks of the (T)=>U form. */
export interface WorkerPool<T, U> {
  readonly isIdle: boolean;

  addTask(arg: T, options?: TaskOptions): Task<T, U>;

  on(event: 'task-added', listener: (task: Task<T, U>) => void): this;
  on(
    event: 'task-complete',
    listener: (
      err: Error | undefined,
      result: U | undefined,
      task: Task<T, U>
    ) => void
  ): this;

  dispose(): void;

  whenIdle(): Promise<void>;
}

export interface WorkerPoolConstructor {
  new <T, U>(
    entrypointModule: string,
    opts?: Partial<WorkerPoolOptions<T, U>>
  ): WorkerPool<T, U>;
}

interface WorkerClientOptions {
  eager: boolean;
  maxConcurency: number;
}

type WorkerStatus = 0 | 1 | 2 | 3;
const WORKER_STARTING = 0;
const WORKER_READY = 1;
const WORKER_DISPOSED = 2;

class WorkerClient<T, U> implements IWorker {
  id: string;

  _options: WorkerClientOptions;
  _port: MessagePort | Worker;
  _pool: WorkerPoolImpl<T, U>;

  ownedTasks = 0;
  tasksDispatched = 0;
  _queues: TaskImpl<T, U>[][] = [[], [], []];

  _activeTasks: Record<string, TaskImpl<T, U>> = {};

  status: WorkerStatus = WORKER_STARTING;

  constructor(
    pool: WorkerPoolImpl<T, U>,
    port: MessagePort | Worker,
    options: WorkerClientOptions,
    id: string
  ) {
    this.id = id;
    this._options = options;
    this._port = port;
    this._pool = pool;

    port.on('message', (msg) => this._recv(msg));
  }

  dispose() {
    this.status = WORKER_DISPOSED;
    this._post({ type: 'exit' });
  }

  _recv(msg: MsgFromWorker) {
    if (this.status === WORKER_DISPOSED) return;

    switch (msg.type) {
      case 'ready':
        this.status = WORKER_READY;
        this._flush();
        break;
      case 'task-complete':
        this._complete(msg as TaskCompletion<U>);
        break;
      case 'task-failed':
        this._fail(msg as TaskFailure);
        break;
      case 'task-discovered':
        this._discover(msg as TaskDiscovery<T>);
        break;
    }
  }

  _post(msg: MsgToWorker) {
    this._port.postMessage(msg);
  }

  _finish(id: string): TaskImpl<T, U> {
    this.ownedTasks -= 1;
    this.tasksDispatched -= 1;
    const task = this._activeTasks[id];
    delete this._activeTasks[id];
    this._flush();
    return task;
  }

  _complete(msg: TaskCompletion<U>) {
    const task = this._finish(msg.id);

    task.doresolve(msg.result);
    this._pool._completed(task, msg.result);
  }

  _fail(msg: TaskFailure) {
    const task = this._finish(msg.id);

    task.doreject(msg.error);
    this._pool._failed(task, msg.error);
  }

  _discover(msg: TaskDiscovery<T>) {
    this._pool._registerTask(msg.id, msg.arg, msg.options);
  }

  _enqueue(task: TaskImpl<T, U>) {
    this.ownedTasks += 1;
    const qid = task.options.affinityStrength || 0;
    this._queues[qid].push(task);
    this._flush();
  }

  _flush() {
    while (
      this.status === WORKER_READY &&
      this.tasksDispatched < this._options.maxConcurency
    ) {
      let next = this._queues[AFFINITY_FORCE].pop();

      if (next === undefined) {
        next = this._queues[AFFINITY_STRONG].pop();
      }

      if (next === undefined) {
        next = this._queues[AFFINITY_LIGHT].pop();
      }

      if (next === undefined && this._options.eager) {
        next = this._pool._findTask();
        if (next) this.ownedTasks += 1;
      }

      if (next === undefined) {
        if (this.tasksDispatched === 0) {
          this._pool._notifyIdle(this);
        }
        return;
      }

      this.tasksDispatched += 1;
      next.worker = this;
      this._activeTasks[next.id] = next;

      const msg: AddTaskMsg<T> = {
        type: 'add-task',
        id: next.id,
        options: next.options,
        arg: next.arg,
      };
      this._post(msg);
    }
  }
}

/** A pool of workers capable of performing work. */
class WorkerPoolImpl<T, U> implements WorkerPool<T, U> {
  constructor(
    entrypointModule: string,
    opts?: Partial<WorkerPoolOptions<T, U>>
  ) {
    this._entrypointModule = entrypointModule;
    this._options = {
      maxWorkers: os.cpus().length,
      workerConcurency: 2,
      taskPerWorker: 3,
      entrypointSymbol: 'processTask',

      ...opts,
    };

    // If we exist, we'll need at least one worker...
    this._launchWorker();

    // And launch the main thread worker. This is a bit wasteful in many cases,
    // but doing this unconditionally removes a bunch of null checks.
    const { port1, port2 } = new MessageChannel();
    const mainWorkerCfg: WorkerConfig = {
      entrypointModule: this._entrypointModule,
      entrypointSymbol: this._options.entrypointSymbol,
      workerId: 'main',
    };

    new TaskWorker(mainWorkerCfg, port1);

    this._mainThreadWorkerClient = new WorkerClient(
      this,
      port2,
      {
        eager: false,
        maxConcurency: this._options.workerConcurency,
      },
      'main'
    );
  }

  /** Will only be true if all work queued and discovered so far has been completed. */
  get isIdle(): boolean {
    return this._ownedTasks === 0;
  }

  on(event: string, listener: (...args: any[]) => void): this {
    this._eventsEmmiter.on(event, listener);
    return this;
  }

  emit(event: string, ...args: any[]): boolean {
    return this._eventsEmmiter.emit(event, ...args);
  }

  /** Add a task to be performed. */
  addTask(arg: T, opts?: TaskOptions): TaskImpl<T, U> {
    const id = (this._nextTaskId++).toString();
    return this._registerTask(id, arg, opts || {});
  }

  _registerTask(id: string, arg: T, options: TaskOptions): TaskImpl<T, U> {
    this._ownedTasks += 1;

    if (
      this._workers.length < this._options.maxWorkers &&
      this._ownedTasks - this._mainThreadWorkerClient.ownedTasks >
        this._workers.length * this._options.taskPerWorker
    ) {
      this._launchWorker();
    }

    const newTask = new TaskImpl<T, U>(id, options, arg);
    const assignee = this._chooseWorker(newTask);
    if (assignee) {
      assignee._enqueue(newTask);
    } else {
      this._freeTasks.push(newTask);
    }

    this.emit('task-added', newTask);

    if (this._idleWorkers.length > 0 && !this._stealing) {
      // We intentionally use the slow-ish setTimeout in order to let backlogs pile up ever so slightly
      this._stealing = setTimeout(() => this._stealWork(), 0);
    }

    return newTask;
  }

  _completed(task: TaskImpl<T, U>, result: U): void {
    this._ownedTasks -= 1;
    this.emit('task-complete', undefined, result, task);
  }

  _failed(task: TaskImpl<T, U>, err: Error): void {
    this._ownedTasks -= 1;
    this.emit('task-complete', err, undefined, task);
  }

  dispose(): void {
    this._workers.forEach((w) => w.dispose());
    this._mainThreadWorkerClient.dispose();

    if (this._stealing) {
      clearTimeout(this._stealing);
    }
  }

  /** Wait until the pool is not performing any work anymore. */
  async whenIdle(): Promise<void> {
    return new Promise((resolve) => {
      if (this.isIdle) {
        resolve();
      } else {
        this._onNextIdle.push(resolve);
      }
    });
  }

  _notifyIdle(worker: WorkerClient<T, U>): void {
    if (worker._options.eager) {
      this._idleWorkers.push(worker);
    }

    if (this.isIdle) {
      this._onNextIdle.forEach((cb) => cb());
      this._onNextIdle = [];
    }
  }

  _launchWorker(): void {
    const data: WorkerConfig = {
      entrypointModule: this._entrypointModule,
      entrypointSymbol: this._options.entrypointSymbol,
      workerId: this._workers.length,
    };
    const worker = new Worker(workerModule, { workerData: data });
    const client = new WorkerClient(
      this,
      worker,
      { eager: true, maxConcurency: this._options.workerConcurency },
      this._workers.length.toString()
    );
    this._workers.push(client);
  }

  _chooseWorker(task: TaskImpl<T, U>): WorkerClient<T, U> | undefined {
    const options: TaskOptions = task.options;
    if (options.workerAffinity !== undefined) {
      if (options.workerAffinity === 'main') {
        return this._mainThreadWorkerClient;
      } else {
        return this._workers[options.workerAffinity];
      }
    }

    return this._idleWorkers.pop();
  }

  _findTask(): TaskImpl<T, U> | undefined {
    return this._freeTasks.pop();
  }

  _stealWork(): void {
    // I am generally unhappy with this algorithm. especially wrt/ strong affinity.
    // If a worker that had stuff stolen from them gets around to consuming from the free list
    // while the stolen tasks are still there. They should be prioritized.
    this._stealing = undefined;

    // Check to see if the situation hasn't resolved itself.
    if (this._idleWorkers.length === 0) return;

    const stolen: TaskImpl<T, U>[] = [];
    const concurency = this._options.workerConcurency;

    let pressure = this._idleWorkers.length * concurency * 2;

    // Only consider workers that are fully busy.
    const workers = this._workers.filter((w) => w.ownedTasks >= concurency * 2);
    workers.sort((a, b) => b.ownedTasks - a.ownedTasks);

    // First pass: steal light affinity tasks
    const candidateCount = workers.length;
    for (let i = 0; i < candidateCount && pressure > 0; ++i) {
      const w = workers[i];

      const taken = w._queues[AFFINITY_LIGHT];
      w._queues[AFFINITY_LIGHT] = [];

      w.ownedTasks -= taken.length;
      pressure -= taken.length;
      stolen.push(...taken);
    }

    // second pass: steal strong affinity tasks
    for (let i = 0; i < candidateCount && pressure > 0; ++i) {
      const w = workers[i];

      const taken = w._queues[AFFINITY_STRONG];
      w._queues[AFFINITY_STRONG] = [];

      w.ownedTasks -= taken.length;
      pressure -= taken.length;
      stolen.push(...taken);
    }

    this._freeTasks.push(...stolen);

    this._flushIdlers();
  }

  _flushIdlers(): void {
    const idlers = this._idleWorkers;
    this._idleWorkers = [];

    for (const i of idlers) {
      i._flush();
    }
  }

  _eventsEmmiter: EventEmitter = new EventEmitter();

  _options: WorkerPoolOptions<T, U>;
  _entrypointModule: string;

  _mainThreadWorkerClient: WorkerClient<T, U>;

  /** Ordered by id */
  _workers: WorkerClient<T, U>[] = [];

  /** No particular order */
  _idleWorkers: WorkerClient<T, U>[] = [];

  // Pending tasks that have no particular worker affinity.
  _freeTasks: TaskImpl<T, U>[] = [];
  _nextTaskId = 0;
  _ownedTasks = 0;

  _onNextIdle: (() => void)[] = [];

  _stealing?: NodeJS.Timeout;
}

class TaskImpl<T, U> implements PromiseLike<U>, Task<T, U> {
  constructor(id: string, options: TaskOptions, arg: T) {
    // TODO: This interaction with Promise<U> is janky as all heck.
    // There's got to be a better way.
    let tmpResolve: (value: U | PromiseLike<U>) => void;
    let tmpReject: (reason?: Error) => void;

    this._prom = new Promise<U>((resolve, reject) => {
      tmpResolve = resolve;
      tmpReject = reject;
    });

    this.id = id;
    this.options = options;
    this.arg = arg;
    this.doresolve = tmpResolve!;
    this.doreject = tmpReject!;
  }

  then<TResult1 = U, TResult2 = never>(onfulfilled?: ((value: U) => TResult1 | PromiseLike<TResult1>) | undefined | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null): PromiseLike<TResult1 | TResult2> {
    return this._prom.then(onfulfilled, onrejected);
  }
  
  id: string;
  worker?: IWorker;
  options: TaskOptions;
  arg: T;
  _prom: Promise<U>;
  doresolve: (value: U | PromiseLike<U>) => void;
  doreject: (reason?: Error) => void;
}

export const WorkerPool: WorkerPoolConstructor = WorkerPoolImpl;
