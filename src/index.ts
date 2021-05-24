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
  ADD_TASK_TYPE,
  AddTaskMsg,
  EXIT_TYPE,
  IWorkerClient,
  MsgBase,
  MsgMsg,
  READY_TYPE,
  TASK_COMPLETION_TYPE,
  TaskCompletion,
  TaskOptions,
  UserContent,
  WorkerConfig,
  WorkerEntryPoint,
} from './worker-api';

import { performance } from 'perf_hooks';
import { EventEmitter } from 'events';
import os from 'os';
import { MessagePort, Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import path from 'path';

export { IWorkerClient, WorkerEntryPoint };

/** A flat amount added to all tasks.  */
const BASE_TASK_COST = 1;

const MAIN_THREAD_ID = -1;

export interface IWorker {
  readonly id: number;
  postMessageToWorker(type: string, contents?: UserContent): void;
}

/** Worker entrypoint */

/** A task that has been added to the worker pool. */
export interface Task<T, U> extends PromiseLike<U> {
  readonly argument: T;
  readonly id: number;
  readonly options: TaskOptions;
  readonly worker?: IWorker;

  readonly taskCost: number;
  readonly pretaskCost: number;
}

/** Options that can be passed to a worker pool at construction. */
export interface WorkerPoolOptions<T, U> {
  /** New workers are launched when the ratio of pending tasks to workers goes above this threshold. Default: 3 */
  taskPerWorker: number;

  /** Absolute maximum number of workers to launch. Default: cpu count */
  maxWorkers: number;

  /** How many tasks can be sent at a time to each worker. Lower -> better load balancing. Higher -> better pipelining. Default: 2.*/
  workerConcurency: number;

  /** Function that returns an estimate of the cost (in ms) associated with running a task on a given worker.*/
  inherentCostEstimator: (task: Task<T, U>) => number;
  workerCostEstimator: (task: Task<T, U>, worker: IWorker) => number;
}

/** A pool of worker threads dedicated to processing tasks of the (T)=>U form. */
export interface WorkerPool<T, U> {
  /** Wether or not there is work currently queued and/or being processed. */
  readonly isIdle: boolean;

  /** Add a task to be processed. There is no guarantee that tasks will be executed in order.*/
  addTask(arg: T, options?: TaskOptions): Task<T, U>;

  /** Register a handler that is called whenever a task is added to the pool. */
  on(event: 'task-added', listener: (task: Task<T, U>) => void): this;
  on(event: 'worker-launched', listener: (worker: IWorker) => void): this;

  /** Register a handler that is called whenever a task is done. */
  on(
    event: 'task-complete',
    listener: (
      err: Error | undefined,
      result: U | undefined,
      task: Task<T, U>
    ) => void
  ): this;

  removeListener(
    event: 'task-added',
    listener: (task: Task<T, U>) => void
  ): this;

  removeListener(
    event: 'worker-launched',
    listener: (worker: IWorker) => void
  ): this;

  removeListener(
    event: 'task-complete',
    listener: (
      err: Error | undefined,
      result: U | undefined,
      task: Task<T, U>
    ) => void
  ): this;

  /** Register a handler that is called whenever a message with the provided type is sent from a worker. */
  onMessage(
    type: string,
    listener: (msg: UserContent, origin: IWorker) => void
  ): this;

  removeMessageListener(
    event: string,
    listener: (...args: any[]) => void
  ): this;

  /** Sends a message to every **current** worker. */
  postMessageToWorkers(type: string, contents?: UserContent): void;

  /** Clean up. */
  dispose(): void;

  /** Gets a promise that resolves when every queued task has been completed. */
  whenIdle(): Promise<void>;

  /** Increases the current number of launchers. */
  resizeUpTo(upTo: number): void;
}

export interface WorkerPoolConstructor {
  new <T, U>(
    entryPoint: WorkerEntryPoint<T, U>,
    opts?: Partial<WorkerPoolOptions<T, U>>
  ): WorkerPool<T, U>;
}

interface WorkerClientOptions {
  maxConcurency: number;
}

type WorkerStatus = 0 | 1 | 2 | 3;
const WORKER_STARTING = 0;
const WORKER_READY = 1;
const WORKER_DISPOSED = 2;

class ClientBase {
  _next!: ClientBase;
  _prev!: ClientBase;
  load: number;

  constructor(load: number) {
    this.load = load;
  }

  postMessageToWorker(_type: string, _contents?: UserContent): void {
    // Intentionally empty
  }

  dispose(): void {
    // Intentionally empty
  }

  _shouldAdvance(): boolean {
    return this._next.load !== -1 && this.load > this._next.load;
  }

  _shouldRetreat(): boolean {
    return this._prev.load !== -1 && this.load < this._prev.load;
  }

  _resort(): void {
    if (this._shouldAdvance()) {
      // Yank out the node.
      this._next._prev = this._prev;
      this._prev._next = this._next;

      // Advance until we find where we belong.
      this._next = this._next._next;
      while (this._shouldAdvance()) {
        this._next = this._next._next;
      }

      // Insert ourselves.
      this._prev = this._next._prev;
      this._next._prev = this;
      this._prev._next = this;
    } else if (this._shouldRetreat()) {
      this._prev._next = this._next;
      this._next._prev = this._prev;

      while (this._shouldRetreat()) {
        this._prev = this._prev._prev;
      }
      this._next = this._prev._next;
      this._next._prev = this;
      this._prev._next = this;
    }
  }
}

abstract class Client<T, U> extends ClientBase implements IWorker {
  constructor(
    pool: WorkerPoolImpl<T, U>,
    options: WorkerClientOptions,
    id: number
  ) {
    super(0);
    this.id = id;
    this._options = options;
    this._pool = pool;
  }

  abstract _onAddTask(msg: AddTaskMsg<T>): void;
  abstract _onDispose(): void;

  dispose() {
    if (this.status !== WORKER_STARTING) {
      this._onDispose();
    }
    this.status = WORKER_DISPOSED;
  }

  _ready() {
    if (this.status === WORKER_DISPOSED) {
      this._onDispose();
    } else {
      this.status = WORKER_READY;

      this._flush();
    }
  }

  _complete(msg: TaskCompletion<U>) {
    const task = this._pool._tasks.get(msg.id)!;

    this.ownedTasks -= 1;
    this.tasksDispatched -= 1;
    this.load -= task.taskCost + task.pretaskCost + BASE_TASK_COST;
    this._resort();

    task.taskCost = msg.taskCost;
    task.pretaskCost = msg.pretaskCost;

    this._pool._completed(task, msg.error, msg.result);

    this._flush();
  }

  _enqueue(task: TaskImpl<T, U>) {
    this.ownedTasks += 1;
    this.load += task.taskCost + task.pretaskCost + BASE_TASK_COST;
    this._resort();
    this._queue.push(task);
    this._flush();
  }

  _flush() {
    while (
      this.status === WORKER_READY &&
      this.tasksDispatched < this._options.maxConcurency
    ) {
      const next = this._queue.shift();

      if (next) {
        this.tasksDispatched += 1;
        next.worker = this;

        const msg: AddTaskMsg<T> = {
          id: next.id,
          arg: next.argument,
          options: next.options,
        };
        this._onAddTask(msg);
      } else {
        break;
      }
    }
  }

  id: number;
  ownedTasks = 0;
  tasksDispatched = 0;
  status: WorkerStatus = WORKER_STARTING;

  _pool: WorkerPoolImpl<T, U>;
  _options: WorkerClientOptions;

  _queue: TaskImpl<T, U>[] = [];
}

class WorkerClient<T, U> extends Client<T, U> {
  _port: MessagePort | Worker;

  constructor(
    pool: WorkerPoolImpl<T, U>,
    port: Worker,
    options: WorkerClientOptions,
    id: number
  ) {
    super(pool, options, id);
    this._port = port;

    port.on('message', (msg) => this._recv(msg));
  }

  _onDispose() {
    this._port.postMessage({ type: EXIT_TYPE });
  }

  postMessageToWorker(type: string, contents?: UserContent): void {
    this._port.postMessage({ type, contents });
  }

  _recv(msg: MsgBase) {
    switch (msg.type) {
      case READY_TYPE:
        this._ready();
        break;
      case TASK_COMPLETION_TYPE:
        this._complete((msg as unknown) as TaskCompletion<U>);
        break;
      default:
        this._pool._recvMsg(msg as MsgMsg, this);
        break;
    }
  }

  _onAddTask(msg: AddTaskMsg<T>) {
    this._port.postMessage({ type: ADD_TASK_TYPE, ...msg });
  }
}

class MainThreadClient<T, U> extends Client<T, U> implements IWorkerClient<T> {
  constructor(pool: WorkerPoolImpl<T, U>, options: WorkerClientOptions) {
    super(pool, options, MAIN_THREAD_ID);

    this._next = this;
    this._prev = this;
    this._entry = pool._entryPoint;

    (async () => {
      if (this._entry!.onWorkerStart) {
        await this._entry!.onWorkerStart(this);
      }
      this._ready();
    })();
  }

  _onDispose() {
    // Nothing
  }

  onMessage(
    type: string,
    listener: (contents: UserContent, client: IWorkerClient<T>) => void
  ): void {
    this._eventsEmmiter.on(type, listener);
  }

  postMessageToPool(type: string, contents: UserContent): void {
    const msg: MsgMsg = { type, contents };
    this._pool._recvMsg(msg, this);
  }

  postMessageToWorker(type: string, contents?: UserContent): void {
    this._recvMessageToWorker(type, contents);
  }

  _recvMessageToWorker(type: string, contents: UserContent): void {
    this._eventsEmmiter.emit(type, contents, this);
  }

  async _onAddTask(msg: AddTaskMsg<T>) {
    const { arg, options, id } = msg;
    let taskCost = 0;
    let pretaskCost = 0;

    if (this._entry!.preTask) {
      const startTime = performance.now();
      await this._entry!.preTask(arg, this);
      pretaskCost = performance.now() - startTime;
    }

    const startTime = performance.now();
    const rawResult = this._entry!(arg, this);

    rawResult.then(
      (result) => {
        taskCost = performance.now() - startTime;
        this._complete({ id, options, result, taskCost, pretaskCost });
      },
      (error) => {
        taskCost = performance.now() - startTime;
        this._complete({ id, options, error, taskCost, pretaskCost });
      }
    );
  }

  _entry?: WorkerEntryPoint<T, U>;
  _eventsEmmiter: EventEmitter = new EventEmitter();
}

/** A pool of workers capable of performing work. */
class WorkerPoolImpl<T, U> implements WorkerPool<T, U> {
  constructor(
    entryPoint: WorkerEntryPoint<T, U>,
    opts?: Partial<WorkerPoolOptions<T, U>>
  ) {
    this._entryPoint = entryPoint;
    this._options = {
      maxWorkers: os.cpus().length,
      inherentCostEstimator: () => 0,
      workerCostEstimator: () => 0,
      workerConcurency: 2,
      taskPerWorker: 3,
      ...opts,
    };

    const canaryNode = new ClientBase(-1);
    canaryNode._next = canaryNode;
    canaryNode._prev = canaryNode;
    this._workers = canaryNode;

    this._mainThreadWorker = new MainThreadClient(this, {
      maxConcurency: this._options.workerConcurency,
    });
  }

  /** Will only be true if all work queued and discovered so far has been completed. */
  get isIdle(): boolean {
    return this._tasks.size === 0;
  }

  on(event: string, listener: (...args: any[]) => void): this {
    this._eventsEmmiter.on(event, listener);
    return this;
  }

  removeListener(event: string, listener: (...args: any[]) => void): this {
    this._eventsEmmiter.removeListener(event, listener);
    return this;
  }

  onMessage(event: string, listener: (...args: any[]) => void): this {
    this._msgEventsEmmiter.on(event, listener);
    return this;
  }

  removeMessageListener(
    event: string,
    listener: (...args: any[]) => void
  ): this {
    this._msgEventsEmmiter.removeListener(event, listener);
    return this;
  }

  /** Sends a message to all currently active workers. This does NOT wait for the task queue to be empty. */
  postMessageToWorkers(type: string, contents?: UserContent): void {
    this._mainThreadWorker.postMessageToWorker(type, contents);

    let current = this._workers._next;
    while (current != this._workers) {
      current.postMessageToWorker(type, contents);
      current = current._next;
    }
  }

  /** Add a task to be performed. */
  addTask(arg: T, opts?: TaskOptions): TaskImpl<T, U> {
    return this._registerTask(this._nextTaskId++, arg, opts || {});
  }

  _chooseWorker(task: TaskImpl<T, U>): WorkerClient<T, U> {
    const workerEstimator = this._options.workerCostEstimator;

    let taskCost: number;
    if (task.options.key) {
      taskCost =
        this._costCache.get(task.options.key) ||
        this._options.inherentCostEstimator(task);
    } else {
      taskCost = this._options.inherentCostEstimator(task);
    }

    let result = this._workers._next as WorkerClient<T, U>;
    let pretaskCost = workerEstimator(task, result);
    let resultNewLoad = result.load + taskCost + pretaskCost;

    // We know the following:
    // - inherentCost is fixed.
    // - result.load can only increase, or stay the same.
    // - workerCost can become literaly anything.
    while (result._next !== this._workers) {
      const candidate = result._next as WorkerClient<T, U>;

      const candidatePretaskCost = workerEstimator(task, candidate);
      const candidateNewLoad = candidate.load + taskCost + candidatePretaskCost;
      if (candidateNewLoad < resultNewLoad) {
        result = candidate;
        pretaskCost = candidatePretaskCost;
        resultNewLoad = candidateNewLoad;
      } else {
        // There might be a remaining worker who's estimate is better, but it
        // cannot possibly overcome the load difference.
        break;
      }
    }

    task.taskCost = taskCost;
    task.pretaskCost = pretaskCost;

    return result;
  }

  _registerTask(id: number, arg: T, options: TaskOptions): TaskImpl<T, U> {
    const newTask = new TaskImpl<T, U>(id, options, arg);
    this._tasks.set(id, newTask);

    if (
      this._numWorkers < this._options.maxWorkers &&
      this._tasks.size - this._mainThreadWorker.ownedTasks >
        this._numWorkers * this._options.taskPerWorker
    ) {
      this._launchWorker();
    }

    if (options.mainThread) {
      this._mainThreadWorker._enqueue(newTask);
      this._eventsEmmiter.emit('task-added', newTask);
      return newTask;
    }

    const worker = this._chooseWorker(newTask);
    worker!._enqueue(newTask);

    this._eventsEmmiter.emit('task-added', newTask);
    return newTask;
  }

  _completed(
    task: TaskImpl<T, U>,
    error: Error | undefined,
    result: U | undefined
  ): void {
    if (task.options.key) {
      this._costCache.set(task.options.key, task.taskCost);
    }

    if (error) {
      task._reject(error);
    } else {
      task._resolve(result!);
    }

    this._tasks.delete(task.id);
    this._eventsEmmiter.emit('task-complete', error, result, task);

    if (this.isIdle) {
      this._onNextIdle.forEach((cb) => cb());
      this._onNextIdle = [];
    }
  }

  _recvMsg(msg: MsgMsg, origin: Client<T, U>): void {
    this._msgEventsEmmiter.emit(msg.type, msg.contents, origin);
  }

  dispose(): void {
    let current = this._workers._next;
    while (current != this._workers) {
      current.dispose();
      current = current._next;
    }
    this._mainThreadWorker.dispose();
  }

  /** Wait until the pool is not performing any work anymore. */
  whenIdle(): Promise<void> {
    if (this.isIdle) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this._onNextIdle.push(resolve);
    });
  }

  _launchWorker(): void {
    const data: WorkerConfig = {
      entrypointModule: this._entryPoint.modulePath,
      entrypointSymbol: this._entryPoint.moduleSymbol,
    };

    const workerModule = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      'WORKER_FILE_NAME'
    );
    const newClient = new WorkerClient(
      this,
      new Worker(workerModule, {
        workerData: data,
      }),
      { maxConcurency: this._options.workerConcurency },
      this._numWorkers
    );

    this._numWorkers += 1;
    this._eventsEmmiter.emit('worker-launched', newClient);

    // A fresh worker has no load, so it can go straight to the front of the list,
    // no questions asked.
    newClient._next = this._workers._next;
    newClient._prev = this._workers;
    newClient._next._prev = newClient;
    newClient._prev._next = newClient;
  }

  resizeUpTo(upTo: number): void {
    const workersToLaunch = Math.min(upTo, this._options.maxWorkers);
    while (this._numWorkers < workersToLaunch) {
      this._launchWorker();
    }
  }

  _options: WorkerPoolOptions<T, U>;
  _entryPoint: WorkerEntryPoint<T, U>;

  _eventsEmmiter: EventEmitter = new EventEmitter();
  _msgEventsEmmiter: EventEmitter = new EventEmitter();

  _numWorkers = 0;
  _workers: ClientBase; // An intrusive doubly-linked list with _workers being a canary node.
  _mainThreadWorker: MainThreadClient<T, U>;

  _nextTaskId = 0;
  _tasks: Map<number, TaskImpl<T, U>> = new Map();

  _onNextIdle: (() => void)[] = [];
  _costCache: Map<string, number> = new Map();
}

class TaskImpl<T, U> implements PromiseLike<U>, Task<T, U> {
  constructor(id: number, options: TaskOptions, arg: T) {
    this._prom = new Promise<U>((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });

    this.id = id;
    this.argument = arg;
    this.options = options;
  }

  then<TResult1 = U, TResult2 = never>(
    onfulfilled?:
      | ((value: U) => TResult1 | PromiseLike<TResult1>)
      | undefined
      | null,
    onrejected?:
      | ((reason: Error) => TResult2 | PromiseLike<TResult2>)
      | undefined
      | null
  ): PromiseLike<TResult1 | TResult2> {
    return this._prom.then(onfulfilled, onrejected);
  }

  id: number;
  argument: T;
  options: TaskOptions;

  worker?: IWorker;

  taskCost = 0;
  pretaskCost = 0;

  /** Results handling */
  _prom: Promise<U>;
  _resolve!: (value: U | PromiseLike<U>) => void;
  _reject!: (reason?: Error) => void;
}

export const WorkerPool: WorkerPoolConstructor = WorkerPoolImpl;
